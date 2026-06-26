import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, listScenesByVersion, listRehearsalMarksByVersion,
  getActiveVersionId, loadProduction, applyPatchToDB, ensureScriptMarkerMigration, getVersion,
} from "@/lib/db";
import { tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/roles";
import { withGeneratedSceneNumbers } from "@/lib/script-generated-labels";
import type { Block, BlockType } from "@/lib/script-types";

function uid(prefix = "b") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function makeBlock(content = "", type: BlockType = "dialogue"): Block {
  return {
    id: uid(),
    type,
    content,
    characterIds: [],
    characterAnnotations: {},
    lyric: false,
    sceneId: null,
    rehearsalMark: null,
    forceShowCharacterName: false,
  };
}

function makeMarkerBlock(type: Extract<BlockType, "chapter_marker" | "scene_marker">, markerId: string, name: string, number: string, parentId: string | null): Block {
  return {
    ...makeBlock("", type),
    id: markerId,
    sceneId: markerId,
    markerMeta: { name, number, parentMarkerId: parentId },
  };
}

function shouldInsertEmptyBlockAfterMarker(blocks: Block[], markerIndex: number): boolean {
  const marker = blocks[markerIndex];
  if (!marker || (marker.type !== "chapter_marker" && marker.type !== "scene_marker")) return false;

  for (let cursor = markerIndex + 1; cursor < blocks.length; cursor++) {
    const next = blocks[cursor];
    if (next.type === "chapter_marker") break;
    if (marker.type === "chapter_marker" && next.type === "scene_marker") return false;
    if (next.type === "scene_marker") break;
    if (next.type === "dialogue" || next.type === "stage") return false;
  }
  return true;
}

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

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const resolved = await resolveProductionVersion(id, req.nextUrl.searchParams.get("versionId") ?? undefined);
  if (resolved.error) {
    return req.nextUrl.searchParams.has("versionId")
      ? resolved.error
      : req.nextUrl.searchParams.get("includeRehearsalMarks") === "1"
      ? Response.json({ scenes: [], rehearsalMarks: {} })
      : Response.json([]);
  }
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }
  const scenes = await listScenesByVersion(versionId);
  if (req.nextUrl.searchParams.get("includeRehearsalMarks") === "1") {
    const rehearsalMarks = await listRehearsalMarksByVersion(versionId);
    return Response.json({ scenes, rehearsalMarks });
  }
  return Response.json(scenes);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const name     = typeof body.name     === "string" ? body.name.trim()     : "";
  const parentId = typeof body.parentId === "string" ? body.parentId        : null;
  const insertBeforeSceneId = typeof body.insertBeforeSceneId === "string" ? body.insertBeforeSceneId : null;
  const insertAfterSceneId = typeof body.insertAfterSceneId === "string" ? body.insertAfterSceneId : null;

  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  // Load current marker-backed scene list and block stream to compute insertion position.
  const result = await loadProduction(id, versionId);
  const scenes = result ? [...result.state.scenes] : [];
  const blocks = result ? [...result.state.blocks] : [];

  const newScene = { id: uid("mk"), number: "", name, parentId };

  const beforeSceneIndex = insertBeforeSceneId ? scenes.findIndex((s) => s.id === insertBeforeSceneId) : -1;
  const afterSceneIndex = insertAfterSceneId ? scenes.findIndex((s) => s.id === insertAfterSceneId) : -1;
  if (beforeSceneIndex >= 0) {
    scenes.splice(beforeSceneIndex, 0, newScene);
  } else if (afterSceneIndex >= 0) {
    scenes.splice(afterSceneIndex + 1, 0, newScene);
  } else if (parentId) {
    let insertAfter = scenes.findIndex((s) => s.id === parentId);
    for (let i = insertAfter + 1; i < scenes.length; i++) {
      if (scenes[i].parentId === parentId) insertAfter = i;
      else break;
    }
    scenes.splice(insertAfter + 1, 0, newScene);
  } else {
    scenes.push(newScene);
  }

  const numberedScenes = withGeneratedSceneNumbers(scenes);
  const numberedNewScene = numberedScenes.find((scene) => scene.id === newScene.id) ?? newScene;
  const marker = makeMarkerBlock(parentId ? "scene_marker" : "chapter_marker", newScene.id, name, numberedNewScene.number, parentId);
  const emptyBlock = makeBlock();
  const targetSceneIndex = numberedScenes.findIndex((scene) => scene.id === newScene.id);
  const insertBeforeScene = numberedScenes.slice(targetSceneIndex + 1).find((scene) => (
    parentId ? scene.parentId === parentId || scene.parentId === null : scene.parentId === null
  ));
  let insertBeforeIndex = insertBeforeScene
    ? blocks.findIndex((block) => (
        (block.type === "chapter_marker" || block.type === "scene_marker") &&
        block.sceneId === insertBeforeScene.id
      ))
    : -1;
  if (insertBeforeIndex < 0 && parentId) {
    const parentMarkerIndex = blocks.findIndex((block) => block.type === "chapter_marker" && block.sceneId === parentId);
    const nextChapterIndex = blocks.findIndex((block, index) => index > parentMarkerIndex && block.type === "chapter_marker");
    insertBeforeIndex = nextChapterIndex >= 0 ? nextChapterIndex : blocks.length;
    if (parentMarkerIndex >= 0 && insertBeforeIndex <= parentMarkerIndex) insertBeforeIndex = parentMarkerIndex + 1;
  }
  if (insertBeforeIndex < 0) insertBeforeIndex = blocks.length;
  const afterId = insertBeforeIndex > 0 ? blocks[insertBeforeIndex - 1]?.id ?? null : null;
  const nextBlocks = [...blocks];
  nextBlocks.splice(insertBeforeIndex, 0, marker);
  const needsEmptyBlock = shouldInsertEmptyBlockAfterMarker(nextBlocks, insertBeforeIndex);

  await applyPatchToDB(id, versionId, {
    clientSeq: 0,
    blockOps: [
      { op: "insert", block: marker, afterId },
      ...(needsEmptyBlock ? [{ op: "insert" as const, block: emptyBlock, afterId: marker.id }] : []),
    ],
    charOps: [],
    sceneOps: [],
  });
  tickAndBroadcastSeq(id, versionId);

  const sceneDetail = { ...numberedNewScene, synopsis: "", actionLine: "", music: "", stageNotes: "", expectedDuration: "" };
  return Response.json({ ok: true, scene: sceneDetail }, { status: 201 });
}
