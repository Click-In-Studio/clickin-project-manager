import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import {
  getEventReport, getReportNote, getProductionEvent,
  listReportReplies, createReportReply,
  type Mention,
} from "@/lib/event-db";
import {
  loadEventPermContext,
  canReplyToReport, canReplyToReportNote, canReplyToReply,
} from "@/lib/event-permissions";
import { buildReplyMentionCard } from "@/lib/platform/feishu/feishu-bot";
import { SERVER_URL } from "@/lib/server-url";
import { notifyUsers } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("event:follow", permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const replies = await listReportReplies(reportId);
  return Response.json({ replies });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:follow", permCtx))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const report = await getEventReport(reportId, eventId);
  if (!report) return Response.json({ error: "报告不存在" }, { status: 404 });

  const body = await req.json() as {
    parentType: "report" | "note" | "reply";
    parentId: string;
    content: string;
    mentions?: Mention[];
  };

  if (!body.content?.trim()) return Response.json({ error: "内容不能为空" }, { status: 400 });
  if (!["report", "note", "reply"].includes(body.parentType))
    return Response.json({ error: "无效的父级类型" }, { status: 400 });

  const eventPermCtx = await loadEventPermContext(session.userId, eventId);

  let allowed = false;
  if (body.parentType === "report") {
    allowed = canReplyToReport(session.isAdmin, eventPermCtx.isFollower, eventPermCtx.isInCall);
  } else if (body.parentType === "note") {
    const note = await getReportNote(body.parentId, reportId);
    if (!note) return Response.json({ error: "Note 不存在" }, { status: 404 });
    allowed = canReplyToReportNote(session.isAdmin, eventPermCtx.isFollower, eventPermCtx.isInCall, eventPermCtx.memberDeptIds, note.departmentId);
  } else {
    allowed = canReplyToReply(session.isAdmin, eventPermCtx.isFollower, eventPermCtx.isInCall);
  }

  if (!allowed) return Response.json({ error: "权限不足" }, { status: 403 });

  const mentions: Mention[] = body.mentions ?? [];
  const id = `rpl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const reply = await createReportReply({
    id, reportId,
    parentType: body.parentType,
    parentId: body.parentId,
    userId: session.userId,
    authorName: session.name,
    content: body.content.trim(),
    mentions,
  });

  // Fire-and-forget: notify @mentioned users via unified interface (inbox + optional DM).
  if (mentions.length > 0) {
    const replyPath = `${SERVER_URL}/production/${productionId}/reports/${reportId}#reply-${id}`;
    const mentionUserIds = [...new Set(mentions.map(m => m.userId))];
    const eventRow = await getProductionEvent(eventId, productionId).catch(() => null);
    const eventTitle = eventRow?.title ?? "";
    void notifyUsers({
      userIds: mentionUserIds,
      kind: "comment_mention",
      productionId,
      entityType: "report_reply",
      entityId: id,
      title: `${session.name} 在报告「${report.title}」中提到了你`,
      body: body.content.trim(),
      viewHref: replyPath,
      category: "info",
      buildExternalMessage: async (_userId, target) => {
        const actionUrl = target.adapter.buildActionUrl(replyPath);
        const card = buildReplyMentionCard(session.name, report.title, eventTitle, body.content.trim(), actionUrl);
        return {
          text: `${session.name} 在报告「${report.title}」中提到了你`,
          title: "评论提及",
          primaryUrl: actionUrl,
          richContent: card,
        };
      },
    }).catch(e => console.error("[reply-mention] notify failed:", e));
  }

  return Response.json({ reply }, { status: 201 });
}
