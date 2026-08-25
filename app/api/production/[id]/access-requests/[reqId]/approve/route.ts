import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { approveAccessRequest, getProductionPermissionContext } from "@/lib/db";
import { MAX_APPROVAL_COMMENT_LENGTH } from "@/lib/approval-stages";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, reqId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  // 旧客户端不发 body（POST 空体会让 req.json() 抛），意见是选填的
  const { comment } = (await req.json().catch(() => ({}))) as { comment?: string };

  const result = await approveAccessRequest(reqId, session.userId, comment);
  if (!result.ok) {
    if (result.reason === "comment_too_long") {
      return Response.json({ error: `审批意见不能超过 ${MAX_APPROVAL_COMMENT_LENGTH} 字` }, { status: 400 });
    }
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    if (result.reason === "unauthorized") return Response.json({ error: "无权审批" }, { status: 403 });
    // #140：直属上级本人没有这个权限，只能向上转发
    if (result.reason === "forward_only") {
      return Response.json({ error: "你尚未持有该权限，只能向上转交给下一级审批人", forwardOnly: true }, { status: 403 });
    }
    return Response.json({ error: "申请已被他人处理" }, { status: 409 });
  }
  return Response.json({ request: result.request });
}
