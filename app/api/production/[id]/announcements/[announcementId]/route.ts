import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getAnnouncement, updateAnnouncement, deleteAnnouncement } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; announcementId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, announcementId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, productionId, "announcement", "*", "*", "edit"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const existing = await getAnnouncement(announcementId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "公告不存在" }, { status: 404 });
  }

  const { title, content, isPinned } = await req.json() as {
    title?: string;
    content?: string;
    isPinned?: boolean;
  };

  await updateAnnouncement(announcementId, productionId, {
    title: title?.trim(),
    content,
    isPinned,
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, announcementId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, productionId, "announcement", "*", "*", "delete"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const existing = await getAnnouncement(announcementId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "公告不存在" }, { status: 404 });
  }

  await deleteAnnouncement(announcementId);
  return Response.json({ ok: true });
}
