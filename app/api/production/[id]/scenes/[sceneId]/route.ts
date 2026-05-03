import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, updateSceneMetadata, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
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

  // Handle number/name through the cache system
  const hasStructural = "number" in body || "name" in body;
  if (hasStructural) {
    const versionId = await getActiveVersionId(id) ?? '';
    const state = getState(id, versionId);
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene) return Response.json({ error: "未找到章节" }, { status: 404 });
    const updated = {
      ...scene,
      number: typeof body.number === "string" ? body.number.trim() : scene.number,
      name:   typeof body.name   === "string" ? body.name.trim()   : scene.name,
    };
    await applyPatch(id, versionId, { clientSeq: 0, blockOps: [], charOps: [], sceneOps: [{ op: "upsert", scene: updated }] });
  }

  // Handle metadata fields directly in DB
  const metaFields: Record<string, string> = {};
  for (const key of METADATA_KEYS) {
    if (key in body && typeof body[key] === "string") metaFields[key] = body[key];
  }
  if (Object.keys(metaFields).length > 0) {
    await updateSceneMetadata(sceneId, id, metaFields);
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

  const delVersionId = await getActiveVersionId(id) ?? '';
  await applyPatch(id, delVersionId, { clientSeq: 0, blockOps: [], charOps: [], sceneOps: [{ op: "delete", id: sceneId }] });
  return Response.json({ ok: true });
}
