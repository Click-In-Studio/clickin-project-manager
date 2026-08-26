import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { ApprovalRequestError, getProductionPermissionContext, listMyAccessRequests, submitAccessRequest } from "@/lib/db";
import { isValidCustomExpiry, isValidTtlInterval } from "@/lib/approval-ttl";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权限" }, { status: 403 });

  const requests = await listMyAccessRequests(id, session.userId);
  return Response.json({ requests });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权限" }, { status: 403 });

  const body = (await req.json()) as {
    type?: "resource_access" | "atomic_permission";
    resourceType?: string;
    resourceId?: string;
    resourceSub?: string;
    permissionLevel?: string;
    grantType?: "permanent" | "ttl";
    ttlDuration?: string;
    requestedExpiresAt?: string;
    note?: string;
  };
  if (!body.resourceType || !body.permissionLevel) {
    return Response.json({ error: "缺少必填字段" }, { status: 400 });
  }
  // 终局（批G）：atomic_permission 类型已随原子键退役——旧客户端缓存提交时提示刷新
  if (body.type === "atomic_permission") {
    return Response.json({ error: "申请格式已更新，请刷新页面后重试" }, { status: 400 });
  }

  // 固定档位传 ttlDuration，自定义日期传 requestedExpiresAt，必须且只能有一个。
  const grantType = body.grantType ?? "permanent";
  const validDuration = isValidTtlInterval(body.ttlDuration);
  const validCustomExpiry = isValidCustomExpiry(body.requestedExpiresAt);
  if (grantType === "ttl" && validDuration === validCustomExpiry) {
    return Response.json({ error: "临时权限必须选择有效期" }, { status: 400 });
  }

  try {
    const request = await submitAccessRequest(id, session.userId, {
      type: body.type,
      resourceType: body.resourceType,
      resourceId: body.resourceId,
      resourceSub: body.resourceSub,
      permissionLevel: body.permissionLevel,
      grantType,
      ttlDuration: body.ttlDuration ?? null,
      requestedExpiresAt: body.requestedExpiresAt ?? null,
      note: body.note ?? null,
    });
    return Response.json({ request }, { status: 201 });
  } catch (e) {
    if (e instanceof ApprovalRequestError) {
      if (e.reason === "invalid_ttl")  return Response.json({ error: "临时权限必须选择有效期" }, { status: 400 });
      // ROOT 节点（删除演出/转让所有权/还原快照）owner-only，无审批通道
      if (e.reason === "no_entry")     return Response.json({ error: "该权限仅演出所有者可用，无法通过申请获得" }, { status: 403 });
      if (e.reason === "no_approver")  return Response.json({ error: "找不到该申请的审批人，请联系制作人" }, { status: 409 });
    }
    throw e;
  }
}
