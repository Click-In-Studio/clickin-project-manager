import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, listScenesByVersion, getActiveVersionId,
  loadProduction, applyPatchToDB, getVersion, listMarkerProjectionByVersion,
} from "@/lib/db";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/permissions";
import { diffState } from "@/lib/script-ops";
import { insertHierarchyMarker, projectMarkers } from "@/lib/script-marker-domain";

const createId = () => crypto.randomUUID();

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  return { session, access };
}

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return { error: Response.json({ error: "无可用版本" }, { status: 404 }) };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) {
    return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  }
  return { versionId, version };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("script:view", permCtx)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const resolved = await resolveProductionVersion(id, req.nextUrl.searchParams.get("versionId") ?? undefined);
  if (resolved.error) return resolved.error;
  const scenes = await listMarkerProjectionByVersion(resolved.versionId);
  return req.nextUrl.searchParams.get("includeRehearsalMarks") === "1"
    ? Response.json({ scenes, rehearsalMarks: Object.fromEntries(scenes.map((scene) => [scene.id, scene.rehearsalMarks])) })
    : Response.json(scenes);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("scene:rename", permCtx)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  const body = await req.json();
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  if (resolved.version.status !== "editing") {
    return Response.json({ error: "该版本不可编辑" }, { status: 403 });
  }
  const result = await loadProduction(id, resolved.versionId);
  if (!result) return Response.json({ error: "未找到版本" }, { status: 404 });

  const next = insertHierarchyMarker(result.state, {
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
