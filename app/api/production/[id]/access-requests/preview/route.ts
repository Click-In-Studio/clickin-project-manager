import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, previewApprovalLadder } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 提交前预览这条申请会走的审批链（只读，不落任何行）。
 *
 * 预览的是**当前登录者自己**要提交的申请：subjectId 恒取 session，不接受入参。
 * 否则这个接口就成了「查任意人的汇报关系与部门负责人」的通用探针——阶梯本身
 * 就是一张组织关系图，谁的链谁能看。
 *
 * 返回的是**预测不是承诺**：阶梯按此刻的人事关系现算，提交后每次升级都会重算。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权限" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const resourceType = sp.get("resourceType");
  const permissionLevel = sp.get("permissionLevel");
  if (!resourceType || !permissionLevel) {
    return Response.json({ error: "缺少必填字段" }, { status: 400 });
  }

  const preview = await previewApprovalLadder(id, session.userId, {
    resourceType,
    resourceId: sp.get("resourceId") ?? undefined,
    resourceSub: sp.get("resourceSub") ?? undefined,
    permissionLevel,
  });
  return Response.json(preview);
}
