import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getAnnouncement, markAnnouncementRead } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; announcementId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, announcementId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const existing = await getAnnouncement(announcementId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "公告不存在" }, { status: 404 });
  }

  await markAnnouncementRead(announcementId, session.userId);
  return Response.json({ ok: true });
}
