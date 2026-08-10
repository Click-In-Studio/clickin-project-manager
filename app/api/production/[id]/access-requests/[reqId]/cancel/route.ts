import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { cancelAccessRequest, getProductionPermissionContext } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, reqId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const result = await cancelAccessRequest(reqId, session.userId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    return Response.json({ error: "申请状态无法撤回" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
