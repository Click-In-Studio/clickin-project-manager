/**
 * GET /api/production/:id/approval-items
 *
 * 当前用户在当前项目真实参与的审批实例索引。详情和写动作仍由各业务接口负责。
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { listApprovalCenterItems } from "@/lib/approval/approval-center-db";
import {
  ApprovalCenterQueryError,
  parseApprovalCenterListParams,
} from "@/lib/approval/approval-center-types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权限" }, { status: 403 });

  try {
    const params = parseApprovalCenterListParams(req.nextUrl.searchParams);
    const page = await listApprovalCenterItems(session.userId, id, params);
    return Response.json(page);
  } catch (error) {
    if (error instanceof ApprovalCenterQueryError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
