import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getActiveVersionId, loadProduction, applyPatchToDB,
  ensureScriptMarkerMigration, getVersion, listScenesByVersion,
} from "@/lib/db";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/roles";
import { diffState } from "@/lib/script-ops";
import {
  convertMarker, executeMarkerDeletion, planMarkerDeletion, projectMarkers, resolveMarkerId,
  updateMarkerMeta, type MarkerDeleteOperation, type MarkerKind,
} from "@/lib/script-marker-domain";

const createId = () => crypto.randomUUID();
const META_KEYS = ["synopsis", "actionLine", "music", "stageNotes", "expectedDuration"] as const;

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return { error: Response.json({ error: "无可用版本" }, { status: 404 }) };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  return { versionId, version };
}

async function context(req: NextRequest, productionId: string, requestedVersionId: unknown) {
  const auth = await getCtx(req, productionId);
  if (!auth.session) return { error: Response.json({ error: "未登录" }, { status: 401 }) };
  if (auth.isArchived) return { error: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  if (!hasPermission("script:metadata", auth.session.isAdmin, auth.memberRoles, auth.overrides)) {
    return { error: Response.json({ error: "权限不足" }, { status: 403 }) };
  }
  const resolved = await resolveProductionVersion(productionId, requestedVersionId);
  if (resolved.error) return resolved;
  if (resolved.version.status !== "editing") {
    return { error: Response.json({ error: "该版本不可编辑" }, { status: 403 }) };
  }
  const migration = await ensureScriptMarkerMigration(resolved.versionId);
  if (migration.status === "running") return { error: Response.json({ status: "updating", migration }, { status: 202 }) };
  const result = await loadProduction(productionId, resolved.versionId);
  if (!result) return { error: Response.json({ error: "未找到版本" }, { status: 404 }) };
  return { auth, result, versionId: resolved.versionId };
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const body = await req.json();
  const current = await context(req, id, body.versionId);
  if ("error" in current) return current.error;
  if (!resolveMarkerId(current.result.state, sceneId)) {
    return Response.json({ error: "未找到章节" }, { status: 404 });
  }
  let next = current.result.state;
  if (body.kind === "chapter" || body.kind === "scene") {
    next = convertMarker(next, sceneId, body.kind as MarkerKind, createId);
  }
  const fields: Record<string, string> = {};
  if (typeof body.name === "string") fields.name = body.name.trim();
  for (const key of META_KEYS) if (typeof body[key] === "string") fields[key] = body[key];
  if (Object.keys(fields).length > 0) next = updateMarkerMeta(next, sceneId, fields);
  const patch = diffState(current.result.state, next, 0);
  if (patch.blockOps.length > 0 || patch.sceneOps.length > 0) {
    await applyPatchToDB(id, current.versionId, patch);
    const serverSeq = tickAndBroadcastSeq(id, current.versionId);
    broadcastEvent(id, current.versionId, "markers", { seq: serverSeq });
  }
  const details = await listScenesByVersion(current.versionId);
  return Response.json({ ok: true, scenes: projectMarkers(next, details) });
}

export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes/[sceneId]">) {
  const { id, sceneId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const current = await context(req, id, body.versionId);
  if ("error" in current) return current.error;
  if (!resolveMarkerId(current.result.state, sceneId)) {
    return Response.json({ error: "未找到章节" }, { status: 404 });
  }
  const details = await listScenesByVersion(current.versionId);
  const plan = planMarkerDeletion(current.result.state, sceneId, details);
  if (plan.status === "blocked" || (plan.status === "choice" && !body.operation)) {
    return Response.json({ ok: false, plan }, { status: plan.status === "blocked" ? 409 : 300 });
  }
  const operation: MarkerDeleteOperation = plan.status === "ready"
    ? plan.operation
    : { type: body.operation === "whole" ? "whole" : "marker-only", markerId: sceneId };
  if (operation.type === "whole" && !hasPermission(
    "script:edit",
    current.auth.session.isAdmin,
    current.auth.memberRoles,
    current.auth.overrides,
  )) {
    return Response.json({ error: "删除整段内容需要剧本编辑权限" }, { status: 403 });
  }
  const next = executeMarkerDeletion(current.result.state, operation, createId);
  await applyPatchToDB(id, current.versionId, diffState(current.result.state, next, 0));
  const serverSeq = tickAndBroadcastSeq(id, current.versionId);
  broadcastEvent(id, current.versionId, "markers", { seq: serverSeq });
  return Response.json({ ok: true, scenes: projectMarkers(next, details) });
}
