import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { listScenesByVersion, listMarkerProjectionByVersion } from "@/lib/script/script-scene-character-db";
import { getActiveVersionId, getVersion } from "@/lib/script/version-db";
import { loadProduction } from "@/lib/script/script-state-db";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { canAccessNode } from "@/lib/perm/grant-template";
import { diffState } from "@/lib/script/script-ops";
import { insertHierarchyMarker, moveHierarchyMarker, projectMarkers } from "@/lib/script/script-marker-domain";
import { rejectNonHeadWrite } from "@/lib/script/head-version";

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
  if (!await hasEffectiveGrant(permCtx, id, "script", "*", "blocks", "view")) {
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
  // 六步链（行 ∪ 区间，admin/owner 在第 1 步旁路）——与 characters 的 create 同口径。
  const createAccess = await canAccessNode(permCtx, id, "scene", "*", "*", "create");
  if (!createAccess.allowed) {
    return Response.json(
      { error: createAccess.reason === "needs_self_confirm" ? "请先确认创建权限" : "权限不足" },
      { status: 403 },
    );
  }
  const body = await req.json();
  const nonHead = await rejectNonHeadWrite(id, typeof body.versionId === "string" ? body.versionId : null);
  if (nonHead) return nonHead;
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
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

export async function PUT(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "scene", "*", "*", "edit"))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  if (typeof body.markerId !== "string" || (body.beforeMarkerId !== null && typeof body.beforeMarkerId !== "string")) {
    return Response.json({ error: "排序参数无效" }, { status: 400 });
  }
  const nonHead = await rejectNonHeadWrite(id, typeof body.versionId === "string" ? body.versionId : null);
  if (nonHead) return nonHead;
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const result = await loadProduction(id, resolved.versionId);
  if (!result) return Response.json({ error: "未找到版本" }, { status: 404 });

  const next = moveHierarchyMarker(result.state, body.markerId, body.beforeMarkerId, createId);
  if (next === result.state) return Response.json({ error: "无法移动到该位置" }, { status: 400 });
  await applyPatchToDB(id, resolved.versionId, diffState(result.state, next, 0));
  const serverSeq = tickAndBroadcastSeq(id, resolved.versionId);
  broadcastEvent(id, resolved.versionId, "markers", { seq: serverSeq });
  const details = await listScenesByVersion(resolved.versionId);
  return Response.json({ ok: true, scenes: projectMarkers(next, details) });
}
