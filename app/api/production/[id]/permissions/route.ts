import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getAllPermissionOverrides,
  setPermissionOverride,
  listProductionMembersWithRoles,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "member", "*", "overrides", "edit"))) {
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived: access?.isArchived ?? false };
  }
  return { session, deny: null, isArchived: access.isArchived };
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

  await setPermissionOverride(productionId, userId, permission, granted ?? null);
  return Response.json({ ok: true });
}

/** POST — bulk-apply the same override to multiple members at once. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const { userIds, permission, granted } = (await req.json()) as {
    userIds?: string[];
    permission?: string;
    granted?: boolean | null;
  };

  if (!Array.isArray(userIds) || !userIds.length || !permission) {
    return Response.json({ error: "userIds（数组）和 permission 为必填" }, { status: 400 });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const userId of userIds) {
      if (granted === null || granted === undefined) {
        await client.query(
          "DELETE FROM production_member_permission WHERE production_id = $1 AND user_id = $2 AND permission = $3",
          [productionId, userId, permission],
        );
      } else {
        await client.query(
          `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (production_id, user_id, permission) DO UPDATE SET granted = EXCLUDED.granted`,
          [productionId, userId, permission, granted],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return Response.json({ ok: true, affected: userIds.length });
}
