import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { getProductionEvent, getEventReport, getReportNote, updateReportNote, deleteReportNote, type Mention } from "@/lib/event-db";
import { canModerateNotes } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string; noteId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId, noteId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "记录不存在" }, { status: 404 });

  const note = await getReportNote(noteId, reportId);
  if (!note) return Response.json({ error: "Note 不存在" }, { status: 404 });

  const isModerator = canModerateNotes(session.isAdmin, memberRoles);
  if (!isModerator && note.authorUserId !== session.userId)
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { content?: string; mentions?: Mention[] };
  if (!body.content?.trim())
    return Response.json({ error: "内容不能为空" }, { status: 400 });

  const updated = await updateReportNote(noteId, reportId, body.content.trim(), body.mentions);
  if (!updated) return Response.json({ error: "Note 不存在" }, { status: 404 });
  return Response.json({ note: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId, noteId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });
  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "记录不存在" }, { status: 404 });

  const isModerator = canModerateNotes(session.isAdmin, memberRoles);
  const deleted = await deleteReportNote(noteId, reportId, session.userId, isModerator || session.isAdmin);
  if (!deleted) return Response.json({ error: "无权删除或 Note 不存在" }, { status: 403 });
  return Response.json({ ok: true });
}
