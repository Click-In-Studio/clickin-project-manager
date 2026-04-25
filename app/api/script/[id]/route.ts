import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { type ScriptPatch, requiredPermissions } from "@/lib/script-ops";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map() };
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  return Response.json(getState(id));
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }

  const patch = (await req.json()) as ScriptPatch;
  const needed = requiredPermissions(patch, getState(id));
  for (const perm of needed) {
    if (!hasPermission(perm, session.isAdmin, memberRoles, overrides)) {
      return Response.json({ error: `权限不足：${perm}` }, { status: 403 });
    }
  }

  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  const serverSeq = await applyPatch(id, patch, userToken);
  return Response.json({ ok: true, serverSeq });
}
