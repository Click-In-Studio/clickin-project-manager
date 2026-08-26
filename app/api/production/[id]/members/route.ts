import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import {
  listProductionMembers,
  addProductionMember,
  setMemberRoles,
  setMemberPhoto,
  setMemberSupervisor,
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

  const { userId, roles, photoUrl, supervisorId, tagIds } =
    (await req.json()) as {
      userId?: string;
      roles?: string[];
      photoUrl?: string | null;
      supervisorId?: string | null;
      tagIds?: string[];
    };
  if (!userId) return Response.json({ error: "缺少 userId" }, { status: 400 });

  const isSelf = session.userId === userId;
  const access = session.isAdmin
    ? null
    : await getProductionPermissionContext(session.userId, false, id);
  if (!session.isAdmin && !access) return Response.json({ error: "权限不足" }, { status: 403 });

  // 人事编辑门（角色/tag/上级）：照片是本人或人事编辑门。
  // 人事处置（停用/复职/确认离组/自助退出）不在这里——它是动词形，见
  // members/[userId]/status/route.ts。赋值形反推不出「谁在干什么」：
  // active → suspended 既可能是自助退出也可能是人事停用。
  const canEditMember =
    session.isAdmin ||
    !!(access && (access.permCtx.isAdmin || access.permCtx.isOwner ||
      await hasGrant(access.permCtx.userId, id, "member", "*", "roles", "edit")));

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
  if (photoUrl !== undefined) {
    if (!isSelf && !canEditMember) return Response.json({ error: "权限不足" }, { status: 403 });
    await setMemberPhoto(id, userId, photoUrl);
  }
  return Response.json({ ok: true });
}

// DELETE 已退役（#141）：成员记录不可删除。
//
// 此前它撤权 + 删行，定位是「误加入」——但审计上删行就是抹痕迹，而「谁在什么时候
// 被谁从剧组里拿掉」正是最该留下的一条。加错人也走 停用 → 确认离组：名册上多一条
// 离组记录，换的是任何人都无法抹掉痕迹。
