import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getAnnouncement, getAnnouncementReadStatus } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string; announcementId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, announcementId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "announcement", "*", "*", "edit"))) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }

  const existing = await getAnnouncement(announcementId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "公告不存在" }, { status: 404 });
  }

  const members = await getAnnouncementReadStatus(announcementId, productionId);
  const read = members.filter(m => m.readAt !== null);
  const unread = members.filter(m => m.readAt === null);

  return Response.json({ read, unread, total: members.length });
}
