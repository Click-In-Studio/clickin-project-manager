import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { cancelAccessRequest, getProductionPermissionContext } from "@/lib/db";
import { MAX_APPROVAL_COMMENT_LENGTH } from "@/lib/approval-stages";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, reqId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const { comment } = ((await req.json().catch(() => null)) ?? {}) as { comment?: string };

  const result = await cancelAccessRequest(reqId, session.userId, comment);
  if (!result.ok) {
    if (result.reason === "comment_too_long") {
      return Response.json({ error: `撤回说明不能超过 ${MAX_APPROVAL_COMMENT_LENGTH} 字` }, { status: 400 });
    }
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    return Response.json({ error: "申请状态无法撤回" }, { status: 409 });
  }
  // 回带撤回后的申请：前端不必为了拿到终态再跑一趟列表
  return Response.json({ ok: true, request: result.request });
}
