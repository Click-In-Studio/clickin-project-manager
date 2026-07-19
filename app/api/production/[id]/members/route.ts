import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  listProductionMembers,
  addProductionMember,
  removeProductionMember,
  setMemberRoles,
  updateUserContact,
  setMemberPhoto,
  isProductionArchived,
} from "@/lib/db";

function requireAdmin(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });
  return session;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const members = await listProductionMembers(id);
  return Response.json({ members });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { userId, roles } = (await req.json()) as { userId?: string; roles?: string[] };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });
  await addProductionMember(id, userId);
  if (roles?.length) await setMemberRoles(id, userId, roles);
  return Response.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const { userId, roles, email, phone, photoUrl } = (await req.json()) as {
    userId?: string;
    roles?: string[];
    email?: string | null;
    phone?: string | null;
    photoUrl?: string | null;
  };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  const isSelf = session.userId === userId;
  if (!session.isAdmin && !isSelf) return Response.json({ error: "权限不足" }, { status: 403 });

  if (roles !== undefined) {
    if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberRoles(id, userId, roles);
  }
  if (email !== undefined || phone !== undefined) {
    await updateUserContact(userId, email ?? null, phone ?? null);
  }
  if (photoUrl !== undefined) {
    await setMemberPhoto(id, userId, photoUrl);
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { userId } = (await req.json()) as { userId?: string };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });
  await removeProductionMember(id, userId);
  return Response.json({ ok: true });
}
