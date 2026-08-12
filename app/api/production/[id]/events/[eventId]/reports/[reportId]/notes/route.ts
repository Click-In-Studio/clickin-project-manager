import { type NextRequest } from "next/server";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getProductionEvent, getEventReport, listReportNotes, createReportNote, type Mention } from "@/lib/event-db";
import { canWriteNote, hasEventDomainView, loadEventPermContext } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

let _seq = 0;
const uid = () => `rn${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "记录不存在" }, { status: 404 });

  const notes = await listReportNotes(reportId);
  return Response.json({ notes });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "记录不存在" }, { status: 404 });

  const body = (await req.json()) as {
    departmentId?: string; content?: string; mentions?: Mention[];
  };
  if (!body.departmentId || !body.content?.trim())
    return Response.json({ error: "departmentId 和 content 不能为空" }, { status: 400 });

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);
  if (!await canWriteNote(permCtx, productionId, eventId, body.departmentId, eventPermCtx.participantDeptIds))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const note = await createReportNote({
    id: uid(),
    reportId,
    departmentId: body.departmentId,
    content: body.content.trim(),
    authorUserId: session.userId,
    authorName: session.name,
    mentions: body.mentions ?? [],
  });
  return Response.json({ note }, { status: 201 });
}
