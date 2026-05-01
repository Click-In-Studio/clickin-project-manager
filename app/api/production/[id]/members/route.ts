import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  listProductionMembers,
  addProductionMember,
  removeProductionMember,
  setMemberRoles,
  updateUserContact,
  setMemberPhoto,
  upsertContactUser,
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
  const { openId, name, avatarUrl, email, phone, roles } = (await req.json()) as {
    openId?: string;
    name?: string;
    avatarUrl?: string | null;
    email?: string | null;
    phone?: string | null;
    roles?: string[];
  };
  if (!openId) return Response.json({ error: "缺少 openId" }, { status: 400 });
  // Upsert user info so the feishu_user row exists and contact info is current
  if (name) await upsertContactUser(openId, name, avatarUrl ?? null, email ?? null, phone ?? null);
  await addProductionMember(id, openId);
  if (roles?.length) await setMemberRoles(id, openId, roles);
  return Response.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const { openId, roles, email, phone, photoUrl } = (await req.json()) as {
    openId?: string;
    roles?: string[];
    email?: string | null;
    phone?: string | null;
    photoUrl?: string | null;
  };
  if (!openId) return Response.json({ error: "缺少 openId" }, { status: 400 });

  const isSelf = session.openId === openId;
  if (!session.isAdmin && !isSelf) return Response.json({ error: "权限不足" }, { status: 403 });

  if (roles !== undefined) {
    if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberRoles(id, openId, roles);
  }
  if (email !== undefined || phone !== undefined) {
    await updateUserContact(openId, email ?? null, phone ?? null);
  }
  if (photoUrl !== undefined) {
    await setMemberPhoto(id, openId, photoUrl);
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const { openId } = (await req.json()) as { openId?: string };
  if (!openId) return Response.json({ error: "缺少 openId" }, { status: 400 });
  await removeProductionMember(id, openId);
  return Response.json({ ok: true });
}
