import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventReports, createEventReport } from "@/lib/event-db";
import { loadEventPermContext, canWriteReport } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `rp${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
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
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const permCtx = await loadEventPermContext(session.userId, eventId);
  if (!canWriteReport(session.isAdmin, memberRoles, overrides, permCtx))
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
