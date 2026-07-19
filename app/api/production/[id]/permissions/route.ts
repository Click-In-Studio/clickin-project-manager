import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext,
  getAllPermissionOverrides,
  setPermissionOverride,
  listProductionMembersWithRoles,
} from "@/lib/db";
import { hasPermission, type Permission } from "@/lib/roles";

type Ctx = { params: Promise<{ id: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived };
  }
  return { session, deny: null, isArchived };
}

/** GET — returns all members + all their overrides for the management UI. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const { deny } = await requireManage(req, productionId);
  if (deny) return deny;

  const [members, overrides] = await Promise.all([
    listProductionMembersWithRoles(productionId),
    getAllPermissionOverrides(productionId),
  ]);

  return Response.json({ members, overrides });
}

/** PATCH — set or clear a single override for one member. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const { userId, permission, granted } = (await req.json()) as {
    userId?: string;
    permission?: string;
    granted?: boolean | null;
  };

  if (!userId || !permission) {
    return Response.json({ error: "userId 和 permission 为必填" }, { status: 400 });
  }

  await setPermissionOverride(productionId, userId, permission as Permission, granted ?? null);
  return Response.json({ ok: true });
}
