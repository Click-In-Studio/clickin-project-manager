/**
 * 实例流程视图（prB，缺口文档 P1-6）。
 *
 * 与 preview 接口的分工：preview 按 session 用户算组织链，只适合申请人提交前
 * 预估；本接口按 requestId 读实例——快照、审计链、当前处理人、未来预测与
 * 当前用户可执行的动作。可见性校验在 getAccessRequestFlow 里（申请人/链上
 * 参与者/当前处理人/owner/制作人/平台管理员）。
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getAccessRequestFlow, getProductionPermissionContext } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id, reqId } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const result = await getAccessRequestFlow(reqId, session.userId, access.permCtx.isAdmin);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "申请不存在" }, { status: 404 });
    return Response.json({ error: "无权查看该申请的流程" }, { status: 403 });
  }
  // 跨演出防串：路径里的演出与申请所属演出必须一致
  if (result.view.request.productionId !== id) {
    return Response.json({ error: "申请不存在" }, { status: 404 });
  }
  return Response.json(result.view);
}
