import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import {
  listProductionMembers,
  addProductionMember,
  removeProductionMember,
  setMemberRoles,
  updateUserContact,
  setMemberPhoto,
  setMemberSupervisor,
  setMemberStatus,
  setMemberTags,
  isProductionArchived,
  getProductionPermissionContext,
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

  const { userId, roles, email, phone, photoUrl, supervisorId, tagIds, status } =
    (await req.json()) as {
      userId?: string;
      roles?: string[];
      email?: string | null;
      phone?: string | null;
      photoUrl?: string | null;
      supervisorId?: string | null;
      tagIds?: string[];
      status?: "active" | "suspended";
    };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  const isSelf = session.userId === userId;
  const access = session.isAdmin
    ? null
    : await getProductionPermissionContext(session.userId, false, id);
  if (!session.isAdmin && !access) return Response.json({ error: "权限不足" }, { status: 403 });

  // 人事编辑门（角色/tag/上级）与人事处置门（停用/恢复）分离；
  // 联系方式/照片：本人或人事编辑门。
  const canEditMember =
    session.isAdmin ||
    !!(access && (access.permCtx.isAdmin || access.permCtx.isOwner ||
      await hasGrant(access.permCtx.userId, id, "member", "*", "roles", "edit")));
  const canRemoveMember =
    session.isAdmin ||
    !!(access && (access.permCtx.isAdmin || access.permCtx.isOwner ||
      await hasGrant(access.permCtx.userId, id, "member", "*", "*", "delete")));

  if (roles !== undefined) {
    if (!canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberRoles(id, userId, roles);
  }
  if (tagIds !== undefined) {
    if (!canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberTags(id, userId, tagIds);
  }
  if (supervisorId !== undefined) {
    if (!canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberSupervisor(id, userId, supervisorId);
  }
  if (status !== undefined) {
    if (status !== "active" && status !== "suspended") {
      return Response.json({ error: "status 非法" }, { status: 400 });
    }
    if (!canRemoveMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberStatus(id, userId, status);
  }
  if (email !== undefined || phone !== undefined) {
    if (!isSelf && !canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await updateUserContact(userId, email ?? null, phone ?? null);
  }
  if (photoUrl !== undefined) {
    if (!isSelf && !canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberPhoto(id, userId, photoUrl);
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  if (await isProductionArchived(id)) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const { userId } = (await req.json()) as { userId?: string };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  if (!session.isAdmin) {
    const access = await getProductionPermissionContext(session.userId, false, id);
    if (!access || !(access.permCtx.isAdmin || access.permCtx.isOwner || await hasGrant(access.permCtx.userId, id, "member", "*", "*", "delete"))) {
      return Response.json({ error: "权限不足" }, { status: 403 });
    }
  }

  await removeProductionMember(id, userId);
  return Response.json({ ok: true });
}
