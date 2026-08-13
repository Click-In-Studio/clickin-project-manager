import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getAnnouncement,
  getUnreadMemberIds,
  getProductionName,
} from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { notifyAnnouncementRemind } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; announcementId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, announcementId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "announcement", "*", "*", "edit"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const [existing, productionName, unreadUserIds] = await Promise.all([
    getAnnouncement(announcementId),
    getProductionName(productionId),
    getUnreadMemberIds(announcementId, productionId),
  ]);

  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "公告不存在" }, { status: 404 });
  }

  if (!unreadUserIds.length) {
    return Response.json({ ok: true, sent: 0, message: "所有成员已读，无需催读" });
  }

  const result = await notifyAnnouncementRemind({
    unreadUserIds,
    announcementId,
    announcementTitle: existing.title,
    productionId,
    productionName: productionName ?? "项目",
  });

  return Response.json({ ok: true, sent: result.inboxCount, externalSent: result.externalSent });
}
