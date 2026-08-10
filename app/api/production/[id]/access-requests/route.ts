import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listMyAccessRequests, submitAccessRequest } from "@/lib/db";

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
    note?: string;
  };
  if (!body.resourceType || !body.permissionLevel) {
    return Response.json({ error: "缺少必填字段" }, { status: 400 });
  }

  const request = await submitAccessRequest(id, session.userId, {
    type: body.type,
    resourceType: body.resourceType,
    resourceId: body.resourceId,
    resourceSub: body.resourceSub,
    permissionLevel: body.permissionLevel,
    grantType: body.grantType ?? "permanent",
    ttlDuration: body.ttlDuration ?? null,
    note: body.note ?? null,
  });
  return Response.json({ request }, { status: 201 });
}
