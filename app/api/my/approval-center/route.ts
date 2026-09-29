/**
 * GET /api/my/approval-center
 *
 * 当前用户跨项目的审批中心只读列表。可用查询参数：
 * view、type（可重复或逗号分隔）、status（同左）、from、to、q、sort、limit、cursor。
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { listApprovalCenterItems } from "@/lib/approval/approval-center-db";
import {
  ApprovalCenterQueryError,
  parseApprovalCenterListParams,
} from "@/lib/approval/approval-center-types";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  try {
    const params = parseApprovalCenterListParams(req.nextUrl.searchParams);
    const page = await listApprovalCenterItems(session.userId, params);
    return Response.json(page);
  } catch (error) {
    if (error instanceof ApprovalCenterQueryError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
