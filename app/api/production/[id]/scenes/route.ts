import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, listScenesByVersion, getActiveVersionId,
  loadProduction, applyPatchToDB, ensureScriptMarkerMigration, getVersion, listMarkerProjectionByVersion,
} from "@/lib/db";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/roles";
import { diffState } from "@/lib/script-ops";
import { insertMarker, projectMarkers } from "@/lib/script-marker-domain";

const createId = () => crypto.randomUUID();

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
  if (resolved.error) return resolved.error;
  const migration = await ensureScriptMarkerMigration(resolved.versionId);
  if (migration.status === "running") return Response.json({ status: "updating", migration }, { status: 202 });
  const scenes = await listMarkerProjectionByVersion(id, resolved.versionId);
  return req.nextUrl.searchParams.get("includeRehearsalMarks") === "1"
    ? Response.json({ scenes, rehearsalMarks: Object.fromEntries(scenes.map((scene) => [scene.id, scene.rehearsalMarks])) })
    : Response.json(scenes);
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
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const migration = await ensureScriptMarkerMigration(resolved.versionId);
  if (migration.status === "running") return Response.json({ status: "updating", migration }, { status: 202 });
  const result = await loadProduction(id, resolved.versionId);
  if (!result) return Response.json({ error: "未找到版本" }, { status: 404 });

  const next = insertMarker(result.state, {
    kind: body.kind === "scene" || body.parentId ? "scene" : "chapter",
    name: typeof body.name === "string" ? body.name.trim() : "",
    parentId: typeof body.parentId === "string" ? body.parentId : null,
    beforeId: typeof body.insertBeforeSceneId === "string" ? body.insertBeforeSceneId : null,
    afterId: typeof body.insertAfterSceneId === "string" ? body.insertAfterSceneId : null,
  }, createId);
  await applyPatchToDB(id, resolved.versionId, diffState(result.state, next, 0));
  const serverSeq = tickAndBroadcastSeq(id, resolved.versionId);
  broadcastEvent(id, resolved.versionId, "markers", { seq: serverSeq });
  const details = await listScenesByVersion(resolved.versionId);
  const scenes = projectMarkers(next, details);
  return Response.json({ ok: true, scenes }, { status: 201 });
}
