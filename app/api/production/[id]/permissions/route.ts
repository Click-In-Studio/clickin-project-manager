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
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  }
  return { session, deny: null };
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
  const { deny } = await requireManage(req, productionId);
  if (deny) return deny;

  const { openId, permission, granted } = (await req.json()) as {
    openId?: string;
    permission?: string;
    granted?: boolean | null;
  };

  if (!openId || !permission) {
    return Response.json({ error: "openId 和 permission 为必填" }, { status: 400 });
  }

  await setPermissionOverride(productionId, openId, permission as Permission, granted ?? null);
  return Response.json({ ok: true });
}
