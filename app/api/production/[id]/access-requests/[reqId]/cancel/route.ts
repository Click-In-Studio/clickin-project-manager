import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { cancelAccessRequest } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { reqId } = await ctx.params;

  const result = await cancelAccessRequest(reqId, session.userId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    return Response.json({ error: "申请状态无法撤回" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
