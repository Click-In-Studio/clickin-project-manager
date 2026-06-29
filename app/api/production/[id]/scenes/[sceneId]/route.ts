import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getActiveVersionId,
  loadProduction, applyPatchToDB, ensureScriptMarkerMigration, getVersion,
} from "@/lib/db";
import { tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/roles";
import { FIXED_INITIAL_CHAPTER_BLOCK_ID } from "@/lib/script-fixed-markers";
import { isMarkerBlock, shouldInsertEmptyBlockAfterMarker } from "@/lib/script-marker-blocks";
import type { Block } from "@/lib/script-types";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return { error: Response.json({ error: "无可用版本" }, { status: 404 }) };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) {
    return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  }
  return { versionId };
}

const METADATA_KEYS = ["synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const;

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();

  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  const result = await loadProduction(id, versionId);
  if (!result) return Response.json({ error: "未找到版本" }, { status: 404 });
  const marker = result.state.blocks.find((block) => (
    isMarkerBlock(block) &&
    block.type !== "rehearsal_marker" &&
    block.id === sceneId
  ));
  if (!marker) return Response.json({ error: "未找到章节" }, { status: 404 });

  const markerMeta = { ...(marker.markerMeta ?? {}) };
  if (typeof body.number === "string") markerMeta.number = body.number.trim();
  if (typeof body.name === "string") markerMeta.name = body.name.trim();

  const metaFields: Record<string, string> = {};
  for (const key of METADATA_KEYS) {
    if (marker.type === "chapter_marker" && key === "expectedDuration") continue;
    if (key in body && typeof body[key] === "string") metaFields[key] = body[key];
  }
  Object.assign(markerMeta, metaFields);

  if ("number" in body || "name" in body || Object.keys(metaFields).length > 0) {
    await applyPatchToDB(id, versionId, {
      clientSeq: 0,
      blockOps: [{ op: "update", block: { ...marker, markerMeta } }],
      charOps: [],
      sceneOps: [],
    });
    tickAndBroadcastSeq(id, versionId);
  }

  return Response.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(_req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  if (sceneId === FIXED_INITIAL_CHAPTER_BLOCK_ID) {
    return Response.json({ error: "开场章节不可删除" }, { status: 400 });
  }

  const body = _req.method === "DELETE" ? await _req.json().catch(() => ({})) : {};
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  const result = await loadProduction(id, versionId);
  if (!result) return Response.json({ error: "未找到版本" }, { status: 404 });
  const removedSceneIds = new Set([
    sceneId,
    ...result.state.scenes.filter((scene) => scene.parentId === sceneId).map((scene) => scene.id),
  ]);
  const deletedMarkerIds = new Set<string>();
  const markersToRepair = new Set<string>();
  const blocks = result.state.blocks;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (
      !isMarkerBlock(block) ||
      block.type === "rehearsal_marker" ||
      block.sceneId === null ||
      !removedSceneIds.has(block.sceneId)
    ) {
      continue;
    }
    deletedMarkerIds.add(block.id);
    const previous = blocks[index - 1];
    if (previous && isMarkerBlock(previous)) markersToRepair.add(previous.id);
  }
  const blockOps: Array<{ op: "delete"; id: string } | { op: "insert"; block: Block; afterId: string | null }> = [
    ...[...deletedMarkerIds].map((id) => ({ op: "delete" as const, id })),
  ];
  if (markersToRepair.size > 0) {
    const remainingBlocks = blocks.filter((block) => !deletedMarkerIds.has(block.id));
    const markerIndexById = new Map(remainingBlocks.map((block, index) => [block.id, index]));
    const markerIndexes = [...markersToRepair]
      .map((id) => markerIndexById.get(id) ?? -1)
      .filter((index) => index >= 0)
      .sort((a, b) => b - a);
    for (const markerIndex of markerIndexes) {
      if (!shouldInsertEmptyBlockAfterMarker(remainingBlocks, markerIndex)) continue;
      const emptyBlock: Block = {
        id: crypto.randomUUID(),
        type: "dialogue",
        content: "",
        characterIds: [],
        characterAnnotations: {},
        lyric: false,
        sceneId: null,
        rehearsalMark: null,
        forceShowCharacterName: false,
      };
      blockOps.push({ op: "insert", block: emptyBlock, afterId: remainingBlocks[markerIndex].id });
      remainingBlocks.splice(markerIndex + 1, 0, emptyBlock);
    }
  }

  await applyPatchToDB(id, versionId, {
    clientSeq: 0,
    blockOps,
    charOps: [],
    sceneOps: [],
  });
  tickAndBroadcastSeq(id, versionId);
  return Response.json({ ok: true });
}
