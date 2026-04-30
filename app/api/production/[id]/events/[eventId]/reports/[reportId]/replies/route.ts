import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getEventReport, getReportNote,
  listReportReplies, createReportReply,
} from "@/lib/event-db";
import {
  loadEventPermContext,
  canReplyToReport, canReplyToReportNote, canReplyToReply,
} from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const replies = await listReportReplies(reportId);
  return Response.json({ replies });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "报告不存在" }, { status: 404 });

  const body = await req.json() as {
    parentType: "report" | "note" | "reply";
    parentId: string;
    content: string;
  };

  if (!body.content?.trim()) return Response.json({ error: "内容不能为空" }, { status: 400 });
  if (!["report", "note", "reply"].includes(body.parentType))
    return Response.json({ error: "无效的父级类型" }, { status: 400 });

  const permCtx = await loadEventPermContext(session.openId, eventId);

  let allowed = false;
  if (body.parentType === "report") {
    allowed = canReplyToReport(session.isAdmin, permCtx.isFollower, permCtx.isInCall);
  } else if (body.parentType === "note") {
    const note = await getReportNote(body.parentId, reportId);
    if (!note) return Response.json({ error: "Note 不存在" }, { status: 404 });
    allowed = canReplyToReportNote(session.isAdmin, permCtx.isFollower, permCtx.isInCall, permCtx.memberDeptIds, note.departmentId);
  } else {
    allowed = canReplyToReply(session.isAdmin, permCtx.isFollower, permCtx.isInCall);
  }

  if (!allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const id = `rpl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const reply = await createReportReply({
    id, reportId,
    parentType: body.parentType,
    parentId: body.parentId,
    openId: session.openId,
    authorName: session.name,
    content: body.content.trim(),
  });

  return Response.json({ reply }, { status: 201 });
}
