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

  // 意见选填。两种「没有 body」都要接住：空体让 req.json() 抛（catch 兜住），
  // 而合法的 JSON `null` 会**解析成功**并返回 null——直接解构就是 TypeError → 500。
  const { comment } = ((await req.json().catch(() => null)) ?? {}) as { comment?: string };

  const result = await approveAccessRequest(reqId, session.userId, comment);
  if (!result.ok) {
    if (result.reason === "comment_too_long") {
      return Response.json({ error: `审批意见不能超过 ${MAX_APPROVAL_COMMENT_LENGTH} 字` }, { status: 400 });
    }
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    if (result.reason === "unauthorized") return Response.json({ error: "无权审批" }, { status: 403 });
    // 自定义有效期在审批等待期内被跨过：申请已自动结束，说清楚，别混进
    // 「已被他人处理」——那句话既不真也没告诉审批人下一步该做什么。
    if (result.reason === "expired") {
      return Response.json({ error: "该申请选定的到期日期已过，申请已自动结束，请让申请人重新提交" }, { status: 409 });
    }
    // #140：直属上级本人没有这个权限，只能向上转发
    if (result.reason === "forward_only") {
      return Response.json({ error: "你尚未持有该权限，只能向上转交给下一级审批人", forwardOnly: true }, { status: 403 });
    }
    return Response.json({ error: "申请已被他人处理" }, { status: 409 });
  }
  return Response.json({ request: result.request });
}
