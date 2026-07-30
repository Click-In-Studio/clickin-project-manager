import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listAnnouncements, createAnnouncement } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `an${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(_req: NextRequest, ctx: Ctx) {
  const req = _req;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const announcements = await listAnnouncements(productionId);
  return Response.json({ announcements });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !hasPermission("announcement:create", access.permCtx)) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const { title, content } = await req.json() as { title?: string; content?: string };
  if (!title?.trim()) return Response.json({ error: "标题不能为空" }, { status: 400 });
  if (typeof content !== "string") return Response.json({ error: "内容不能为空" }, { status: 400 });

  const announcement = await createAnnouncement(
    uid(),
    productionId,
    title.trim(),
    content,
    session.userId,
  );
  return Response.json({ announcement }, { status: 201 });
}
