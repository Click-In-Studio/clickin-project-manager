import { type NextRequest } from "next/server";
import { canAccessNode } from "@/lib/grant-template";
import { hasAnyEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { listProductionEvents, createProductionEvent } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `ev${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function validateVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return true;
  const version = await getVersion(versionId);
  return version?.productionId === productionId;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const events = await listProductionEvents(productionId);
  return Response.json({ events });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const createAccess = await canAccessNode(permCtx, productionId, "event", "*", "*", "create");
  if (!createAccess.allowed)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null; description?: string;
    versionId?: string | null;
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });
  if (!(await validateVersion(productionId, body.versionId))) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }

  const event = await createProductionEvent({
    id: uid(),
    productionId,
    title,
    eventType: body.eventType ?? "custom",
    location: body.location ?? "",
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
    description: body.description ?? "",
    createdBy: session.userId,
    versionId: body.versionId ?? null,
  });
  return Response.json({ event }, { status: 201 });
}
