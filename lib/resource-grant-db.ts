/**
 * Resource Grant DB — 资源实例级访问权限查询与自我确认。
 *
 * 支持 cue_list / event / report / tech_req / note 等资源类型。
 *
 * 免审批区间（自我确认条件）：
 *   - edit 级：user 是某个 resource_dept_manage 管理该资源的 dept 的成员，
 *              且该 dept 的 permissions[] 含 '<resource_type>:edit'，或 user 是该 dept 的 POC
 *   - manage 级：user 是上述 dept 的 POC
 */
import { getPool } from "./pg";

// ─── Generic resource grant helpers ──────────────────────────────────────────

/**
 * Returns the highest active permission level for a user on any resource instance,
 * or null if no active grant exists.
 */
export async function getResourceGrantLevel(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ permission_level: string }>(
    `SELECT rg.permission_level
     FROM resource_grant rg
     JOIN resource_permission_level rpl
       ON rpl.resource_type = rg.resource_type
       AND rpl.permission_level = rg.permission_level
     WHERE rg.production_id = $1
       AND rg.user_id = $2
       AND rg.resource_type = $3
       AND rg.resource_id = $4
       AND NOT rg.is_revoked
     ORDER BY rpl.sort_order DESC
     LIMIT 1`,
    [productionId, userId, resourceType, resourceId],
  );
  return rows[0]?.permission_level ?? null;
}

/**
 * Checks if the user's highest active level on a resource meets or exceeds the required level.
 * sort_order defines the ordering (higher = more permissive).
 */
export async function hasResourceGrantLevel(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  requiredLevel: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM resource_grant rg
       JOIN resource_permission_level rpl
         ON rpl.resource_type = rg.resource_type
         AND rpl.permission_level = rg.permission_level
       JOIN resource_permission_level rpl_req
         ON rpl_req.resource_type = $3
         AND rpl_req.permission_level = $5
       WHERE rg.production_id = $1
         AND rg.user_id = $2
         AND rg.resource_type = $3
         AND rg.resource_id = $4
         AND NOT rg.is_revoked
         AND rpl.sort_order >= rpl_req.sort_order
     ) AS ok`,
    [productionId, userId, resourceType, resourceId, requiredLevel],
  );
  return rows[0]?.ok ?? false;
}

/**
 * Checks whether user is in the free-approval zone for a resource.
 * permKey: the permission key that must appear in dept.permissions[]
 *   (e.g. 'event:edit', 'report:edit', 'tech_req:edit')
 * For manage level, only POC qualifies; for edit level, POC or dept-permission qualifies.
 */
export async function checkResourceFreeApprovalZone(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  permKey: string,
  level: "edit" | "manage",
): Promise<boolean> {
  if (level === "manage") {
    const { rows } = await getPool().query(
      `SELECT 1
       FROM resource_dept_manage rdm
       JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
       WHERE rdm.production_id = $1
         AND rdm.resource_type = $2
         AND rdm.resource_id = $3
         AND pdm.user_id = $4
         AND pdm.is_poc = true
       LIMIT 1`,
      [productionId, resourceType, resourceId, userId],
    );
    return rows.length > 0;
  }
  const { rows } = await getPool().query(
    `SELECT 1
     FROM resource_dept_manage rdm
     JOIN production_dept_member pdm ON pdm.dept_id = rdm.dept_id
     JOIN production_dept pd ON pd.id = pdm.dept_id
     WHERE rdm.production_id = $1
       AND rdm.resource_type = $2
       AND rdm.resource_id = $3
       AND pdm.user_id = $4
       AND (pdm.is_poc = true OR $5 = ANY(pd.permissions))
     LIMIT 1`,
    [productionId, resourceType, resourceId, userId, permKey],
  );
  return rows.length > 0;
}

/**
 * Writes a self_confirmed resource_grant for any resource type.
 * Idempotent: ON CONFLICT DO NOTHING.
 */
export async function selfConfirmResourceGrant(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  level: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, $4, '*', $5, 'self_confirmed', $2)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, userId, resourceType, resourceId, level],
  );
}

// ─── Typed level helpers ──────────────────────────────────────────────────────

export type EventLevel = "view" | "edit" | "publish" | "edit_published" | "revoke" | "manage";
export type ReportLevel = "view" | "edit" | "publish" | "edit_published" | "revoke" | "manage";
export type TechReqLevel = "view" | "edit" | "assign" | "manage";
export type NoteLevel = "view" | "edit" | "manage";

export type ResourceAccessResult<L extends string> =
  | { canAccess: true; level: L }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "manage" | "edit" }
  | { canAccess: false; canSelfConfirm: false };

/**
 * Full access check for an event resource:
 *   1. Active grant found → { canAccess: true, level }
 *   2. In manage free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage' }
 *   3. In edit free-approval zone → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'edit' }
 *   4. No zone → { canAccess: false, canSelfConfirm: false }
 */
export async function getEventAccess(
  userId: string,
  productionId: string,
  eventId: string,
): Promise<ResourceAccessResult<EventLevel>> {
  const level = (await getResourceGrantLevel(userId, productionId, "event", eventId)) as EventLevel | null;
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkResourceFreeApprovalZone(userId, productionId, "event", eventId, "event:edit", "manage"),
    checkResourceFreeApprovalZone(userId, productionId, "event", eventId, "event:edit", "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

export async function getReportAccess(
  userId: string,
  productionId: string,
  reportId: string,
): Promise<ResourceAccessResult<ReportLevel>> {
  const level = (await getResourceGrantLevel(userId, productionId, "report", reportId)) as ReportLevel | null;
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkResourceFreeApprovalZone(userId, productionId, "report", reportId, "report:edit", "manage"),
    checkResourceFreeApprovalZone(userId, productionId, "report", reportId, "report:edit", "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

export async function getTechReqAccess(
  userId: string,
  productionId: string,
  reqId: string,
): Promise<ResourceAccessResult<TechReqLevel>> {
  const level = (await getResourceGrantLevel(userId, productionId, "tech_req", reqId)) as TechReqLevel | null;
  if (level) return { canAccess: true, level };
  const [canManage, canEdit] = await Promise.all([
    checkResourceFreeApprovalZone(userId, productionId, "tech_req", reqId, "tech_req:edit", "manage"),
    checkResourceFreeApprovalZone(userId, productionId, "tech_req", reqId, "tech_req:edit", "edit"),
  ]);
  if (canManage) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "manage" };
  if (canEdit) return { canAccess: false, canSelfConfirm: true, selfConfirmLevel: "edit" };
  return { canAccess: false, canSelfConfirm: false };
}

// ─── Grant-write helpers for new resource creation ────────────────────────────

/**
 * Writes initial resource_grant + resource_dept_manage when a new event is created.
 * Called inside or after the INSERT transaction.
 *   - creator gets manage grant
 *   - all production_depts with 'event:edit' in permissions get resource_dept_manage
 */
export async function writeEventGrants(
  eventId: string,
  productionId: string,
  createdBy: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'event', $3, '*', 'manage', 'direct', $2)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, createdBy, eventId],
  );
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     SELECT $1, pd.id, 'event', $2, '*', $3
     FROM production_dept pd
     WHERE pd.production_id = $1
       AND 'event:edit' = ANY(pd.permissions)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, eventId, createdBy],
  );
}

/**
 * Writes initial resource_grant + resource_dept_manage when a new report is created.
 * Inherits the same managing depts as the parent event.
 */
export async function writeReportGrants(
  reportId: string,
  productionId: string,
  createdBy: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'report', $3, '*', 'manage', 'direct', $2)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, createdBy, reportId],
  );
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     SELECT $1, pd.id, 'report', $2, '*', $3
     FROM production_dept pd
     WHERE pd.production_id = $1
       AND 'event:edit' = ANY(pd.permissions)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, reportId, createdBy],
  );
}

/**
 * Writes initial resource_grant + resource_dept_manage when a new tech_req is created.
 *   - POC(s) of the assigned dept get manage grant
 *   - Assigned dept gets resource_dept_manage
 *   - All SM depts (event:edit) get resource_dept_manage
 * eventDeptId is an event_department.id (TEXT); we map to production_dept by name.
 * createdBy is the requesting user (session.userId) used as established_by.
 */
export async function writeTechReqGrants(
  reqId: string,
  productionId: string,
  eventDeptId: string | null,
  createdBy: string,
): Promise<void> {
  const pool = getPool();
  if (eventDeptId) {
    // Map event_department → production_dept by name, then write grants for POCs
    await pool.query(
      `INSERT INTO resource_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT DISTINCT $1, pdm.user_id, 'tech_req', $2, '*', 'manage', 'direct', pdm.user_id
       FROM event_department ed
       JOIN production_dept pd_mapped
         ON pd_mapped.production_id = $1 AND pd_mapped.name = ed.name
       JOIN production_dept_member pdm
         ON pdm.dept_id = pd_mapped.id AND pdm.is_poc = true
       WHERE ed.id = $3
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, reqId, eventDeptId],
    );
    await pool.query(
      `INSERT INTO resource_dept_manage
         (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
       SELECT DISTINCT $1, pd_mapped.id, 'tech_req', $2, '*', $4
       FROM event_department ed
       JOIN production_dept pd_mapped
         ON pd_mapped.production_id = $1 AND pd_mapped.name = ed.name
       WHERE ed.id = $3
       ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
      [productionId, reqId, eventDeptId, createdBy],
    );
  }
  // SM depts always get resource_dept_manage
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     SELECT $1, pd.id, 'tech_req', $2, '*', $3
     FROM production_dept pd
     WHERE pd.production_id = $1
       AND 'event:edit' = ANY(pd.permissions)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, reqId, createdBy],
  );
}

export type CueListLevel = "manage" | "edit" | "mount" | "view";

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
 * Grants or revokes a user's direct access to a cue list at a specific level.
 * grant=true  → upsert resource_grant(level, direct)
 * grant=false/null → revoke ALL active grants for this user on this cue list
 */
export async function setCueListGrant(
  cueListId: string,
  productionId: string,
  userId: string,
  grant: boolean | null,
  grantedBy: string,
  level: CueListLevel = "edit",
): Promise<void> {
  if (grant === true) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE resource_grant
         SET is_revoked = true, revoked_reason = 'manual'
         WHERE production_id = $1 AND user_id = $2
           AND resource_type = 'cue_list' AND resource_id = $3
           AND NOT is_revoked`,
        [productionId, userId, cueListId],
      );
      await client.query(
        `INSERT INTO resource_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         VALUES ($1, $2, 'cue_list', $3, '*', $4, 'direct', $5)`,
        [productionId, userId, cueListId, level, grantedBy],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
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
