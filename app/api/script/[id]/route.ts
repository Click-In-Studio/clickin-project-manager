import { type NextRequest } from "next/server";
import { broadcastEvent, tickAndBroadcastSeq } from "@/lib/server-cache";
import { patchAffectsMarkerProjection, type ScriptPatch, requiredPermissions } from "@/lib/script/script-ops";
import { hasEffectiveGrant } from "@/lib/perm/grant-check";
import { TOKEN_COOKIE } from "@/lib/platform/feishu/feishu-auth";
import { getSession } from "@/lib/account/session";
import { rejectNonHeadWrite } from "@/lib/script/head-version";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getActiveVersionId, getVersion } from "@/lib/script/version-db";
import { loadProduction } from "@/lib/script/script-state-db";
import { ScriptPatchConflict, type ScriptPatchBasis } from "@/lib/script/script-patch-basis";
import { applyPatchToDB } from "@/lib/script/script-patch-db";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  return { session, access };
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
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!await hasEffectiveGrant(permCtx, id, "script", "*", "blocks", "view")) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });

  const result = await loadProduction(id, versionId);
  if (!result) return Response.json({ error: "版本不存在" }, { status: 404 });
  return Response.json(result.state);
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(permCtx, id, "script", "*", "blocks", "view")) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }

  const nonHead = await rejectNonHeadWrite(id, req.nextUrl.searchParams.get("v"));
  if (nonHead) return nonHead;
  const versionId = await resolveVersion(req, id);
  if (!versionId) return Response.json({ error: "无可用版本" }, { status: 404 });

  // Load current state from DB for permission checking
  const current = await loadProduction(id, versionId);
  if (!current) return Response.json({ error: "版本不存在" }, { status: 404 });

  const patch = (await req.json()) as ScriptPatch & { basis?: ScriptPatchBasis };
  const needed = requiredPermissions(patch, current.state);
  for (const perm of needed) {
    // E1 过渡双制：node: 前缀键走行判定，其余仍走原子键（E2 收敛）
    if (perm.startsWith("node:")) {
      const m = /^node:([^/]+)\/([^/@]+)(?:\/(.+))?@(\w+)$/.exec(perm);
      if (!m || !await hasEffectiveGrant(permCtx, id, m[1], m[2], m[3] ?? "*", m[4] as "view" | "create" | "edit" | "delete")) {
        return Response.json({ error: `权限不足：${perm}` }, { status: 403 });
      }
    }
  }

  if (!patch.basis) return Response.json({ error: "缺少编辑依据，请重新加载剧本" }, { status: 409 });

  // userToken unused in atomic path (Feishu sync removed); accepted but ignored
  void req.cookies.get(TOKEN_COOKIE)?.value;

  try {
    await applyPatchToDB(id, versionId, patch, patch.basis);
  } catch (error) {
    if (error instanceof ScriptPatchConflict) {
      return Response.json({ error: "剧本已被他人修改，本地修改未上传", code: "SCRIPT_PATCH_CONFLICT" }, { status: 409 });
    }
    throw error;
  }
  const serverSeq = tickAndBroadcastSeq(id, versionId);
  if (patchAffectsMarkerProjection(patch, current.state)) {
    broadcastEvent(id, versionId, "markers", { seq: serverSeq });
  }
  return Response.json({ ok: true, serverSeq });
}
