import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant, hasEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, listEventReports, createEventReport } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `rp${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const reports = await listEventReports(eventId);
  return Response.json({ reports });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  // Creating a report requires edit-level on the event
  if (!await hasEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", eventId, event.status === "published" ? "publication" : "details", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; reportType?: string; body?: string;
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });

  const report = await createEventReport({
    id: uid(),
    eventId,
    reportType: body.reportType ?? "rehearsal",
    title,
    body: body.body ?? "",
    createdBy: session.userId,
  });
  return Response.json({ report }, { status: 201 });
}
