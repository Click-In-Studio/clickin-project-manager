/**
 * Resource Grant DB — cue_list 访问权限查询与自我确认。
 *
 * 权限模型（cue_list）：
 *   manage > edit > view (sort_order 参考 resource_permission_level 表)
 *
 * 免审批区间（自我确认条件）：
 *   - edit 级：user 是某个 resource_dept_manage 管理该 cue_list 的 dept 的成员，
 *              且该 dept 的 permissions[] 含 'cue_list:edit'，或 user 是该 dept 的 POC
 *   - manage 级：user 是上述 dept 的 POC
 */
import { getPool } from "./pg";

export type CueListLevel = "manage" | "edit" | "view";

export type CueListAccessResult =
  | { canAccess: true; level: CueListLevel }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "manage" | "edit" }
  | { canAccess: false; canSelfConfirm: false };

/**
 * Returns the highest active permission level for a user on a specific cue list,
 * or null if no active grant exists.
 */
export async function getCueListGrantLevel(
  userId: string,
  productionId: string,
  cueListId: string,
): Promise<CueListLevel | null> {
  const { rows } = await getPool().query<{ permission_level: string }>(
    `SELECT rg.permission_level
     FROM resource_grant rg
     JOIN resource_permission_level rpl
       ON rpl.resource_type = rg.resource_type
       AND rpl.permission_level = rg.permission_level
     WHERE rg.production_id = $1
       AND rg.user_id = $2
       AND rg.resource_type = 'cue_list'
       AND rg.resource_id = $3
       AND NOT rg.is_revoked
     ORDER BY rpl.sort_order DESC
     LIMIT 1`,
    [productionId, userId, cueListId],
  );
  return (rows[0]?.permission_level ?? null) as CueListLevel | null;
}

/**
 * Checks whether user is in the free-approval zone for a given level on a cue list.
 * Free-approval zone = user is member of a dept that has resource_dept_manage for this cue list
 * AND (dept.permissions[] ⊇ 'cue_list:edit' OR user is POC of that dept).
 * For manage level, only POC qualifies.
 */
export async function checkCueListFreeApprovalZone(
  userId: string,
  productionId: string,
  cueListId: string,
  level: "edit" | "manage",
): Promise<boolean> {
  if (level === "manage") {
    const { rows } = await getPool().query(
      `SELECT 1
       FROM resource_dept_manage rdm
       JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
       WHERE rdm.production_id = $1
         AND rdm.resource_type = 'cue_list'
         AND rdm.resource_id = $2
         AND pdm.user_id = $3
         AND pdm.is_poc = true
       LIMIT 1`,
      [productionId, cueListId, userId],
    );
    return rows.length > 0;
  }

  // edit level: POC or dept has 'cue_list:edit' in permissions[]
  const { rows } = await getPool().query(
    `SELECT 1
     FROM resource_dept_manage rdm
     JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
     JOIN production_dept pd ON pd.id = pdm.dept_id
     WHERE rdm.production_id = $1
       AND rdm.resource_type = 'cue_list'
       AND rdm.resource_id = $2
       AND pdm.user_id = $3
       AND (pdm.is_poc = true OR 'cue_list:edit' = ANY(pd.permissions))
     LIMIT 1`,
    [productionId, cueListId, userId],
  );
  return rows.length > 0;
}

/**
 * Writes a self_confirmed resource_grant for the user on a cue list.
 * Idempotent: ON CONFLICT DO NOTHING (active-grant unique index).
 */
export async function selfConfirmCueListGrant(
  userId: string,
  productionId: string,
  cueListId: string,
  level: "edit" | "manage",
): Promise<void> {
  await getPool().query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'cue_list', $3, '*', $4, 'self_confirmed', $2)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, userId, cueListId, level],
  );
}

/**
 * Full access check for a cue list:
 *   1. Active grant found → { canAccess: true, level }
 *   2. In manage free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage' }
 *   3. In edit free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'edit' }
 *   4. No zone → { canAccess: false, canSelfConfirm: false }
 */
export async function getCueListAccess(
  userId: string,
  productionId: string,
  cueListId: string,
): Promise<CueListAccessResult> {
  const level = await getCueListGrantLevel(userId, productionId, cueListId);
  if (level) return { canAccess: true, level };

  const [canManage, canEdit] = await Promise.all([
    checkCueListFreeApprovalZone(userId, productionId, cueListId, "manage"),
    checkCueListFreeApprovalZone(userId, productionId, cueListId, "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit)   return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

/**
 * Returns all active resource_grant rows for a cue list, with user display name.
 * Used for the collaborator management panel.
 */
export async function listCueListGrants(
  cueListId: string,
): Promise<Array<{ userId: string; userName: string; level: CueListLevel }>> {
  const { rows } = await getPool().query<{ user_id: string; user_name: string; permission_level: string }>(
    `SELECT rg.user_id, COALESCE(fu.name, rg.user_id::text) AS user_name, rg.permission_level
     FROM resource_grant rg
     LEFT JOIN feishu_user fu ON fu.user_id = rg.user_id
     JOIN resource_permission_level rpl
       ON rpl.resource_type = rg.resource_type
       AND rpl.permission_level = rg.permission_level
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND NOT rg.is_revoked
     GROUP BY rg.user_id, fu.name, rg.permission_level, rpl.sort_order
     ORDER BY rpl.sort_order DESC`,
    [cueListId],
  );
  return rows.map((r) => ({ userId: r.user_id, userName: r.user_name, level: r.permission_level as CueListLevel }));
}

/**
 * Returns all resource_dept_manage entries for a cue list (which depts are in the free-approval zone).
 */
export async function listCueListDeptAccess(
  cueListId: string,
): Promise<Array<{ deptId: string; deptName: string }>> {
  const { rows } = await getPool().query<{ dept_id: string; dept_name: string }>(
    `SELECT rdm.dept_id, pd.name AS dept_name
     FROM resource_dept_manage rdm
     JOIN production_dept pd ON pd.id = rdm.dept_id
     WHERE rdm.resource_type = 'cue_list' AND rdm.resource_id = $1
     ORDER BY pd.name`,
    [cueListId],
  );
  return rows.map((r) => ({ deptId: r.dept_id, deptName: r.dept_name }));
}

/**
 * Adds a resource_dept_manage entry for a dept on a cue list (idempotent).
 */
export async function addCueListDeptAccess(
  cueListId: string,
  productionId: string,
  deptId: string,
  establishedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'cue_list', $3, '*', $4)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, deptId, cueListId, establishedBy],
  );
}

/**
 * Removes a resource_dept_manage entry for a dept on a cue list.
 */
export async function removeCueListDeptAccess(
  cueListId: string,
  deptId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM resource_dept_manage
     WHERE resource_type = 'cue_list' AND resource_id = $1 AND dept_id = $2`,
    [cueListId, deptId],
  );
}

/**
 * Grants or revokes a user's direct access to a cue list.
 * grant=true  → upsert resource_grant(edit, direct)
 * grant=false → revoke active grants for this user on this cue list
 * grant=null  → same as false (revoke)
 */
export async function setCueListGrant(
  cueListId: string,
  productionId: string,
  userId: string,
  grant: boolean | null,
  grantedBy: string,
): Promise<void> {
  if (grant === true) {
    await getPool().query(
      `INSERT INTO resource_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'cue_list', $3, '*', 'edit', 'direct', $4)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, userId, cueListId, grantedBy],
    );
  } else {
    await getPool().query(
      `UPDATE resource_grant
       SET is_revoked = true, revoked_reason = 'manual'
       WHERE production_id = $1
         AND user_id = $2
         AND resource_type = 'cue_list'
         AND resource_id = $3
         AND NOT is_revoked`,
      [productionId, userId, cueListId],
    );
  }
}
