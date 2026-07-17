import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getReportReply, deleteReportReply } from "@/lib/event-db";
import { canModerateNotes } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string; replyId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId, replyId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const reply = await getReportReply(replyId, reportId);
  if (!reply) return Response.json({ error: "回复不存在" }, { status: 404 });

  const isModerator = canModerateNotes(session.isAdmin, memberRoles);
  if (reply.openId !== session.openId && !isModerator)
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteReportReply(replyId, reportId);
  return Response.json({ ok: true });
}
