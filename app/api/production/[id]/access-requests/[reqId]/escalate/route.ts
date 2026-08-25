import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { escalateAccessRequest, getProductionPermissionContext } from "@/lib/db";
import { MAX_APPROVAL_COMMENT_LENGTH } from "@/lib/approval-stages";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

/** 向上转发（#140）：当前级批不了就把申请推到阶梯下一级，不是拒绝。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, reqId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  // 转交说明会随通知发给下一级审批人，让他知道为什么轮到自己
  const { comment } = (await req.json().catch(() => ({}))) as { comment?: string };

  const result = await escalateAccessRequest(reqId, session.userId, comment);
  if (!result.ok) {
    if (result.reason === "comment_too_long") {
      return Response.json({ error: `转交说明不能超过 ${MAX_APPROVAL_COMMENT_LENGTH} 字` }, { status: 400 });
    }
    if (result.reason === "not_found")      return Response.json({ error: "申请不存在" }, { status: 404 });
    if (result.reason === "unauthorized")   return Response.json({ error: "无权处理此申请" }, { status: 403 });
    if (result.reason === "no_next_stage")  return Response.json({ error: "已到审批链顶端，无法继续转发" }, { status: 409 });
    return Response.json({ error: "申请已被他人处理" }, { status: 409 });
  }
  return Response.json({ request: result.request });
}
