/**
 * 项目权限上下文：一次请求里「这个人在这个项目能干什么」的唯一装配口。
 *
 * getProductionPermissionContext 是成员判定的唯一入口——status='active' 闸门、owner
 * 旁路、职位 → 权限键（production_member_role → production_role_permission）、部门
 * 归属都在这一处装进 PermissionContext；判定本身在 permissions.ts / grant-check.ts。
 * 另附成员级权限 override 表（production_member_permission）的读写，管理后台用。
 *
 * 成员名册与档案（入组、职位、照片、标签、上级）在 member-db.ts，状态机在
 * member-status.ts；本文件只读它们写下的行。
 */
import { getPool } from "../pg";
import type { PermissionContext } from "./permissions";

type AtomicPermission = string;

export type ProductionAccess = {
  permCtx: PermissionContext;
  isArchived: boolean;
};

// getProductionMemberRoles 已删（#141）：全库零调用，而它返回的是不带 status 闸门
// 的成员判定——留着迟早有人拿它绕开闸门。成员判定的唯一入口是
// getProductionPermissionContext。

export async function setPermissionOverride(
  productionId: string,
  userId: string,
  permission: AtomicPermission,
  granted: boolean | null,
): Promise<void> {
  if (granted === null) {
    await getPool().query(
      "DELETE FROM production_member_permission WHERE production_id = $1 AND user_id = $2 AND permission = $3",
      [productionId, userId, permission],
    );
  } else {
    await getPool().query(
      `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_id, user_id, permission) DO UPDATE SET granted = EXCLUDED.granted`,
      [productionId, userId, permission, granted],
    );
  }
}

/** Bulk-load all overrides for all members in a production (for the management UI). */
export async function getAllPermissionOverrides(
  productionId: string,
): Promise<Record<string, Record<string, boolean>>> {
  const res = await getPool().query<{ user_id: string; permission: string; granted: boolean }>(
    "SELECT user_id, permission, granted FROM production_member_permission WHERE production_id = $1",
    [productionId],
  );
  const result: Record<string, Record<string, boolean>> = {};
  for (const row of res.rows) {
    result[row.user_id] ??= {};
    result[row.user_id][row.permission] = row.granted;
  }
  return result;
}

/**
 * New permission context for the atomic permission system.
 * Queries production_role_permission via role name JOIN; falls back to static
 * templates from lib/perm/permissions.ts when the production has no role records yet.
 * Also returns department membership for hasScopedPermission dept checks.
 */
export async function getProductionPermissionContext(
  userId: string,
  isAdmin: boolean,
  productionId: string,
): Promise<ProductionAccess | null> {
  const pool = getPool();

  const [memberRow, dbPermsRow, deptRow, productionRow] = await Promise.all([
    // Is user a member? And what are their role strings?
    //
    // status = 'active' 是访问闸门（#141）。suspended / exited 的成员行还在——
    // 名册要显示他们、历史要留痕、复职要零重配——但他们进不来。这一条不加，
    // 「停用」就只是名册上的一条删除线：人照样拿角色权限、部门权限与 resource grant。
    // 注意闸门只管 isMember：owner 走下面的 isOwner 分支，不受影响（owner 退出
    // 必须先转移 owner，见 #141）。
    pool.query<{ roles: string[] }>(
      "SELECT roles FROM production_member WHERE user_id = $1 AND production_id = $2 AND status = 'active'",
      [userId, productionId],
    ),
    // Try FK-backed permissions first (production_member_role populated after migration/setMemberRoles)
    pool.query<{ permission_key: string }>(
      `SELECT DISTINCT prp.permission_key
       FROM production_member_role pmr
       JOIN production_role_permission prp ON prp.role_id = pmr.role_id
       WHERE pmr.user_id = $1 AND pmr.production_id = $2`,
      [userId, productionId],
    ),
    // Department memberships（并表后单一 production_dept 数据源）
    pool.query<{ dept_id: string; is_poc: boolean }>(
      `SELECT pdm.dept_id, pdm.is_poc
       FROM production_dept_member pdm
       WHERE pdm.user_id = $1 AND pdm.production_id = $2`,
      [userId, productionId],
    ),
    pool.query<{ archived_at: Date | null; owner_id: string | null }>(
      "SELECT archived_at, owner_id FROM production WHERE id = $1",
      [productionId],
    ),
  ]);

  const prodRow = productionRow.rows[0];
  const isOwner = prodRow?.owner_id != null && prodRow.owner_id === userId;

  const isMember = memberRow.rows.length > 0;
  if (!isAdmin && !isOwner && !isMember) return null;

  let memberPermissions: Set<AtomicPermission> | null = null;

  if (isMember) {
    if (dbPermsRow.rows.length > 0) {
      // DB records exist: use exactly what's in production_role_permission.
      // Base permissions are now stored in role rows (db/add-base-perms-to-roles.sql, #158),
      // so no need to inject MEMBER_BASE_PERMISSIONS here.
      memberPermissions = new Set(
        dbPermsRow.rows.map((r) => r.permission_key as AtomicPermission),
      );
    } else {
      // 终局：代码模板已退役，无 FK 行 = 空区间
      memberPermissions = new Set();
    }
  }

  // overrides is reserved for future owner-granted direct permissions (Phase 7).
  const overrides = new Map<AtomicPermission, boolean>();

  const deptIds: string[] = [];
  const pocDeptIds: string[] = [];
  for (const row of deptRow.rows) {
    deptIds.push(row.dept_id);
    if (row.is_poc) pocDeptIds.push(row.dept_id);
  }

  // 终局（批G G-2）：区间三表经六步链消费、行经 hasGrant 消费——ctx 历史字段恒空
  const deptFreeApprovalZone = new Set<string>();
  const activeGrants = new Set<string>();

  return {
    permCtx: { userId, isAdmin, isOwner, memberPermissions, overrides, deptIds, pocDeptIds, deptFreeApprovalZone, activeGrants },
    isArchived: prodRow?.archived_at != null,
  };
}
