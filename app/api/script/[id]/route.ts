import { type NextRequest } from "next/server";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { patchAffectsMarkerProjection, type ScriptPatch, requiredPermissions } from "@/lib/script-ops";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, getActiveVersionId, getVersion,
  loadProduction, applyPatchToDB, ensureScriptMarkerMigration,
} from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

async function resolveVersion(req: NextRequest, productionId: string): Promise<string | null> {
  const versionId = req.nextUrl.searchParams.get("v");
  const resolvedVersionId = versionId ?? await getActiveVersionId(productionId);
  if (!resolvedVersionId) return null;
  const version = await getVersion(resolvedVersionId);
  return version?.productionId === productionId ? resolvedVersionId : null;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });

  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  const result = await loadProduction(id, versionId);
  if (!result) return Response.json({ error: "版本不存在" }, { status: 404 });
  return Response.json(result.state);
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }

  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });

  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  const ver = await getVersion(versionId);
  if (!ver || ver.status !== 'editing') {
    return Response.json({ error: "该版本不可编辑" }, { status: 403 });
  }

  // Load current state from DB for permission checking
  const current = await loadProduction(id, versionId);
  if (!current) return Response.json({ error: "版本不存在" }, { status: 404 });

  const patch = (await req.json()) as ScriptPatch;
  const needed = requiredPermissions(patch, current.state);
  for (const perm of needed) {
    if (!hasPermission(perm, session.isAdmin, memberRoles, overrides)) {
      return Response.json({ error: `权限不足：${perm}` }, { status: 403 });
    }
  }

  // userToken unused in atomic path (Feishu sync removed); accepted but ignored
  void req.cookies.get(TOKEN_COOKIE)?.value;

  await applyPatchToDB(id, versionId, patch);
  const serverSeq = tickAndBroadcastSeq(id, versionId);
  if (patchAffectsMarkerProjection(patch, current.state)) {
    broadcastEvent(id, versionId, "markers", { seq: serverSeq });
  }
  return Response.json({ ok: true, serverSeq });
}
