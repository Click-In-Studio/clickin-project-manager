import { type NextRequest } from "next/server";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getReportReply, deleteReportReply } from "@/lib/event-db";
import { canModerateNotes, hasEventDomainView } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; eventId: string; reportId: string; replyId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, reportId, replyId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const reply = await getReportReply(replyId, reportId);
  if (!reply) return Response.json({ error: "回复不存在" }, { status: 404 });

  const isModerator = await canModerateNotes(permCtx, productionId, eventId);
  if (reply.userId !== session.userId && !isModerator)
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteReportReply(replyId, reportId);
  return Response.json({ ok: true });
}
