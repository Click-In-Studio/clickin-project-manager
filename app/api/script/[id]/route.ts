import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import type { ScriptPatch } from "@/lib/script-ops";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";

async function checkAccess(req: NextRequest, productionId: string): Promise<Response | null> {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.openId, productionId);
    if (!ok) return Response.json({ error: "无权访问该剧本" }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const deny = await checkAccess(req, id);
  if (deny) return deny;
  return Response.json(getState(id));
}

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/script/[id]">) {
  const { id } = await ctx.params;
  const deny = await checkAccess(req, id);
  if (deny) return deny;
  const patch = (await req.json()) as ScriptPatch;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  const serverSeq = await applyPatch(id, patch, userToken);
  return Response.json({ ok: true, serverSeq });
}
