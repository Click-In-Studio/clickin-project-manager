/**
 * production_dept CRUD and permission helpers.
 *
 * Design:
 * - 单一数据源（migrate-merge-event-department 后）：event_department 已并入
 *   production_dept（kind 列承接 'group' 用户组语义），成员/POC 只有本表一份。
 * - 部门权限行在 production_dept_permission（区间；伞语义沿 parent_id 下传），
 *   cue 声明在 dept_cue_list_template——本表不再携带数组权限列。
 * - POC notes 三行（dept/<D>/notes@create|edit|delete）随任期在 setDeptMembers 发/收。
 * - Dissolution guard: dept cannot be deleted while resource_dept_manage has records.
 * - POC conflict: a user can be POC of parallel depts; ancestor/descendant conflicts are resolved.
 */

import { getPool } from "./pg";
import type { Pool, PoolClient } from "pg";
type Permission = string;

import { RESERVED_TYPES } from "./grant-template";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProductionDept = {
  id: string;
  productionId: string;
  name: string;
  parentId: string | null;
  /** 'dept' = 部门（可被提 notes）；'group' = 用户组（仅选人） */
  kind: "dept" | "group";
  displayOrder: number;
  chatId: string | null;
  createdAt: Date;
  memberUserIds: string[];
  pocUserIds: string[];
};

export type DeptMember = {
  userId: string;
  isPoc: boolean;
};

export type DeptMemberInput = {
  userId: string;
  isPoc: boolean;
};

/** Full dept tree row (no member lists). */
type DeptRow = {
  id: string;
  production_id: string;
  name: string;
  parent_id: string | null;
  kind: "dept" | "group";
  display_order: number;
  chat_id: string | null;
  created_at: Date;
};

type MemberRow = {
  dept_id: string;
  user_id: string;
  is_poc: boolean;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function toDept(row: DeptRow, members: MemberRow[]): ProductionDept {
  const mine = members.filter((m) => m.dept_id === row.id);
  return {
    id: row.id,
    productionId: row.production_id,
    name: row.name,
    parentId: row.parent_id,
    kind: row.kind,
    displayOrder: row.display_order,
    chatId: row.chat_id,
    createdAt: row.created_at,
    memberUserIds: mine.map((m) => m.user_id),
    pocUserIds: mine.filter((m) => m.is_poc).map((m) => m.user_id),
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Load all depts for a production, including member lists. */
export async function listProductionDepts(productionId: string): Promise<ProductionDept[]> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, parent_id, kind,
              display_order, chat_id, created_at
       FROM production_dept
       WHERE production_id = $1
       ORDER BY display_order, name`,
      [productionId],
    ),
    pool.query<MemberRow>(
      `SELECT dept_id, user_id, is_poc
       FROM production_dept_member WHERE production_id = $1`,
      [productionId],
    ),
  ]);
  return deptRes.rows.map((r) => toDept(r, memberRes.rows));
}

/** Load a single dept. Returns null if not found. */
export async function getProductionDept(
  deptId: string,
  productionId: string,
): Promise<ProductionDept | null> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, parent_id, kind,
              display_order, chat_id, created_at
       FROM production_dept WHERE id = $1 AND production_id = $2`,
      [deptId, productionId],
    ),
    pool.query<MemberRow>(
      `SELECT dept_id, user_id, is_poc
       FROM production_dept_member WHERE dept_id = $1`,
      [deptId],
    ),
  ]);
  if (deptRes.rows.length === 0) return null;
  return toDept(deptRes.rows[0], memberRes.rows);
}

export type CreateDeptParams = {
  productionId: string;
  name: string;
  parentId?: string | null;
  kind?: "dept" | "group";
  displayOrder?: number;
};

export async function createProductionDept(params: CreateDeptParams): Promise<ProductionDept> {
  const pool = getPool();
  const { rows } = await pool.query<DeptRow>(
    `INSERT INTO production_dept
       (production_id, name, parent_id, kind, display_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, name, parent_id, kind,
               display_order, chat_id, created_at`,
    [
      params.productionId,
      params.name,
      params.parentId ?? null,
      params.kind ?? "dept",
      params.displayOrder ?? 0,
    ],
  );
  return toDept(rows[0], []);
}

export type UpdateDeptFields = Partial<{
  name: string;
  parentId: string | null;
  kind: "dept" | "group";
  displayOrder: number;
}>;

export async function updateProductionDept(
  deptId: string,
  productionId: string,
  fields: UpdateDeptFields,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [deptId, productionId];
  if (fields.name !== undefined) { sets.push(`name = $${vals.push(fields.name)}`); }
  if ("parentId" in fields) { sets.push(`parent_id = $${vals.push(fields.parentId ?? null)}`); }
  if (fields.kind !== undefined) { sets.push(`kind = $${vals.push(fields.kind)}`); }
  if (fields.displayOrder !== undefined) { sets.push(`display_order = $${vals.push(fields.displayOrder)}`); }
  if (sets.length === 0) return;

  await getPool().query(
    `UPDATE production_dept SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    vals,
  );
}

export type DeleteDeptResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "has_resource_manage" };

/**
 * Delete a dept.
 * Blocked if resource_dept_manage still has records for this dept (PRD: dept dissolution guard).
 */
export async function deleteProductionDept(
  deptId: string,
  productionId: string,
): Promise<DeleteDeptResult> {
  const pool = getPool();
  const deptRes = await pool.query(
    "SELECT id FROM production_dept WHERE id = $1 AND production_id = $2",
    [deptId, productionId],
  );
  if (deptRes.rows.length === 0) return { ok: false, reason: "not_found" };

  const rdmRes = await pool.query(
    "SELECT 1 FROM resource_dept_manage WHERE dept_id = $1 LIMIT 1",
    [deptId],
  );
  if (rdmRes.rows.length > 0) return { ok: false, reason: "has_resource_manage" };

  await pool.query("DELETE FROM production_dept WHERE id = $1 AND production_id = $2", [
    deptId,
    productionId,
  ]);
  return { ok: true };
}

// ─── Member management ────────────────────────────────────────────────────────

export async function getDeptMembers(deptId: string): Promise<DeptMember[]> {
  const { rows } = await getPool().query<MemberRow>(
    "SELECT dept_id, user_id, is_poc FROM production_dept_member WHERE dept_id = $1",
    [deptId],
  );
  return rows.map((r) => ({ userId: r.user_id, isPoc: r.is_poc }));
}

/**
 * Replace the full member list for a dept atomically.
 * Also handles:
 * - POC conflict resolution (ancestor/descendant rules)
 * - Cascade revocation of self_confirmed grants for removed members
 */
export async function setDeptMembers(
  deptId: string,
  productionId: string,
  members: DeptMemberInput[],
  client?: PoolClient,
): Promise<{ pocConflictsResolved: string[] }> {
  const pool = client ?? getPool();

  // Snapshot before for diff
  const { rows: before } = await pool.query<MemberRow>(
    "SELECT user_id, is_poc FROM production_dept_member WHERE dept_id = $1",
    [deptId],
  );
  const beforeMemberSet = new Set(before.map((r) => r.user_id));
  const beforePocSet = new Set(before.filter((r) => r.is_poc).map((r) => r.user_id));
  const afterMemberSet = new Set(members.map((m) => m.userId));
  const afterPocSet = new Set(members.filter((m) => m.isPoc).map((m) => m.userId));

  // Delete removed members
  const removedUserIds = [...beforeMemberSet].filter((id) => !afterMemberSet.has(id));
  if (removedUserIds.length > 0) {
    await pool.query(
      "DELETE FROM production_dept_member WHERE dept_id = $1 AND user_id = ANY($2)",
      [deptId, removedUserIds],
    );
    // Cascade revoke self_confirmed grants for removed members
    await revokeGrantsForDeptRemoval(deptId, productionId, removedUserIds, pool);
  }

  // Upsert remaining/new members
  for (const m of members) {
    await pool.query(
      `INSERT INTO production_dept_member
         (production_id, user_id, dept_id, is_poc)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, dept_id) DO UPDATE SET
         is_poc        = EXCLUDED.is_poc,
         production_id = EXCLUDED.production_id`,
      [productionId, m.userId, deptId, m.isPoc],
    );
  }

  // POC conflict resolution for newly-added POCs
  const newPocUserIds = [...afterPocSet].filter((id) => !beforePocSet.has(id));
  const pocConflictsResolved: string[] = [];
  for (const userId of newPocUserIds) {
    const resolved = await resolvePocConflict(userId, deptId, productionId, pool);
    pocConflictsResolved.push(...resolved);
  }

  // Revoke self_confirmed grants for users who lost POC status
  const lostPocUserIds = [...beforePocSet].filter((id) => afterMemberSet.has(id) && !afterPocSet.has(id));
  if (lostPocUserIds.length > 0) {
    await revokeGrantsForPocLoss(deptId, productionId, lostPocUserIds, pool);
  }

  // POC 上任/卸任 diff（批C C3，原 event 侧写路径逻辑并入）：
  // dept/<D>/notes@create|edit|delete 三行随任期发/收。行是 production 级
  // （未参与 event 的部门也可被提 note）；卸任显式撤销，不走 sweep
  // （auto 行不在 recompute 的 self_confirmed 扫描面内）。
  const promoted = newPocUserIds;
  const demoted = [...beforePocSet].filter((id) => !afterPocSet.has(id));
  if (promoted.length > 0) {
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source)
       SELECT $1, u, 'dept', $2, 'notes', v.verb, 'auto'
       FROM unnest($3::uuid[]) AS u
       CROSS JOIN (VALUES ('create'), ('edit'), ('delete')) AS v(verb)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, deptId, promoted],
    );
  }
  if (demoted.length > 0) {
    await pool.query(
      `UPDATE production_member_grant
       SET is_revoked = true, revoked_reason = 'poc_change'
       WHERE resource_type = 'dept' AND resource_id = $1 AND resource_sub = 'notes'
         AND grant_source = 'auto' AND is_revoked = false
         AND user_id = ANY($2::uuid[])`,
      [deptId, demoted],
    );
  }

  return { pocConflictsResolved };
}

// ─── Chat ID ──────────────────────────────────────────────────────────────────

export async function setDeptChatId(deptId: string, chatId: string): Promise<void> {
  await getPool().query(
    "UPDATE production_dept SET chat_id = $1 WHERE id = $2",
    [chatId, deptId],
  );
}

export async function getDeptChatIds(productionId: string): Promise<{ deptId: string; chatId: string }[]> {
  const { rows } = await getPool().query<{ id: string; chat_id: string }>(
    "SELECT id, chat_id FROM production_dept WHERE production_id = $1 AND chat_id IS NOT NULL",
    [productionId],
  );
  return rows.map((r) => ({ deptId: r.id, chatId: r.chat_id }));
}

// ─── Tree traversal ───────────────────────────────────────────────────────────
// （数组权限机制已退役——permissions 列已 DROP；区间行/伞语义在
//  production_dept_permission + recompute，本段仅保留结构遍历工具。）

type DeptPermRow = { id: string; parent_id: string | null };

/**
 * Load the full dept tree for a production (all depts, no member data).
 * Used for tree traversal (ancestor/descendant lookups).
 */
export async function loadDeptTree(
  productionId: string,
  pool: Pool | PoolClient = getPool(),
): Promise<DeptPermRow[]> {
  const { rows } = await pool.query<DeptPermRow>(
    "SELECT id, parent_id FROM production_dept WHERE production_id = $1",
    [productionId],
  );
  return rows;
}

/** Return all depts in the subtree rooted at deptId (inclusive). */
export function collectDescendants(deptId: string, tree: DeptPermRow[]): DeptPermRow[] {
  const byParent = new Map<string, DeptPermRow[]>();
  for (const d of tree) {
    if (d.parent_id) {
      if (!byParent.has(d.parent_id)) byParent.set(d.parent_id, []);
      byParent.get(d.parent_id)!.push(d);
    }
  }

  const result: DeptPermRow[] = [];
  const queue = [deptId];
  const byId = new Map(tree.map((d) => [d.id, d]));

  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) {
      result.push(node);
      const children = byParent.get(id) ?? [];
      queue.push(...children.map((c) => c.id));
    }
  }
  return result;
}

/** Return all ancestor dept IDs (exclusive of deptId itself). */
export function collectAncestors(deptId: string, tree: DeptPermRow[]): string[] {
  const byId = new Map(tree.map((d) => [d.id, d]));
  const ancestors: string[] = [];
  let cur = byId.get(deptId);
  while (cur?.parent_id) {
    ancestors.push(cur.parent_id);
    cur = byId.get(cur.parent_id);
  }
  return ancestors;
}


// ─── POC conflict resolution ──────────────────────────────────────────────────

/**
 * When user becomes POC of newDeptId, check for ancestor/descendant conflicts.
 *
 * Rules (PRD):
 *   - newDept is ancestor of existing POC dept → keep new, revoke old (broader scope wins)
 *   - newDept is descendant of existing POC dept → keep old, skip new
 *   - no relationship → both allowed (parallel depts)
 *
 * Returns list of dept IDs where POC was removed due to conflict.
 */
export async function resolvePocConflict(
  userId: string,
  newDeptId: string,
  productionId: string,
  pool: Pool | PoolClient = getPool(),
): Promise<string[]> {
  const tree = await loadDeptTree(productionId, pool);

  const { rows: existingPocRows } = await pool.query<{ dept_id: string }>(
    `SELECT dept_id FROM production_dept_member
     WHERE user_id = $1 AND production_id = $2 AND is_poc = true AND dept_id <> $3`,
    [userId, productionId, newDeptId],
  );

  const newAncestors = new Set(collectAncestors(newDeptId, tree));
  const newDescendants = new Set(collectDescendants(newDeptId, tree).map((d) => d.id));

  const toRemovePoc: string[] = [];

  for (const { dept_id: existingDeptId } of existingPocRows) {
    if (newDescendants.has(existingDeptId)) {
      // new is ancestor of existing → existing is narrower, remove existing POC
      toRemovePoc.push(existingDeptId);
    } else if (newAncestors.has(existingDeptId)) {
      // new is descendant of existing → existing is broader, demote new
      await pool.query(
        "UPDATE production_dept_member SET is_poc = false WHERE user_id = $1 AND dept_id = $2",
        [userId, newDeptId],
      );
      return [newDeptId];
    }
    // else: parallel depts — both allowed, do nothing
  }

  if (toRemovePoc.length > 0) {
    await pool.query(
      "UPDATE production_dept_member SET is_poc = false WHERE user_id = $1 AND dept_id = ANY($2)",
      [userId, toRemovePoc],
    );
    await revokeGrantsForPocLoss(newDeptId, productionId, [userId], pool);
  }

  return toRemovePoc;
}

// ─── Grant cascade revocation ─────────────────────────────────────────────────


/**
 * Recompute a user's free-approval zone after a role/dept/POC change and
 * soft-revoke any self_confirmed grants that are no longer covered.
 *
 * - atomic_permission_grant: revoke keys not in the combined (dept ∪ role) zone.
 * - production_member_grant: revoke rows where the user's remaining depts no longer
 *   cover the resource via resource_dept_manage AND the user is not a person
 *   manager of the resource (resource_person_manage).
 *
 * 存续规则：self_confirmed 行的存续 ⟺ 资格/归属覆盖仍在。四路覆盖任一成立即保留：
 *   ① dept 归属（resource_dept_manage × 仍在该 dept）
 *   ② person 归属（resource_person_manage 本人行）
 *   ③ zone 资格（三张 permission 表的节点键仍命中该行——批A：成员基础通配行
 *      由 role 区间键保护，dept/role 变动不误撤）
 *   ④ 无 ①②③ → 收走
 *
 * Does NOT touch 'approval', 'direct', or 'assigned' grants (PRD spec).
 */
export async function recomputeAndRevokeGrants(
  userId: string,
  productionId: string,
  reason: "role_change" | "dept_change" | "poc_change",
  pool: Pool | PoolClient = getPool(),
): Promise<void> {
  // 终局（批G G-2）：atomic 表已 DROP，撤销面只余 production_member_grant 行
  await pool.query(
    `UPDATE production_member_grant rg
     SET is_revoked = true, revoked_reason = $3
     WHERE rg.production_id = $1
       AND rg.user_id = $2
       AND rg.grant_source = 'self_confirmed'
       AND rg.is_revoked = false
       AND NOT EXISTS (
         SELECT 1
         FROM resource_dept_manage rdm
         JOIN production_dept_member pdm
           ON pdm.dept_id = rdm.dept_id
          AND pdm.user_id = rg.user_id
          AND pdm.production_id = rg.production_id
         WHERE rdm.production_id = rg.production_id
           AND rdm.resource_type = rg.resource_type
           AND rdm.resource_id IN (rg.resource_id, '*')
           AND rdm.resource_sub IN (rg.resource_sub, '*')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM resource_person_manage rpm
         WHERE rpm.production_id = rg.production_id
           AND rpm.user_id = rg.user_id
           AND rpm.resource_type = rg.resource_type
           AND rpm.resource_id IN (rg.resource_id, '*')
           AND rpm.resource_sub IN (rg.resource_sub, '*')
       )
       -- ③ zone 资格覆盖：三张 permission 表任一持有命中该行的节点键（含通配形态；
       --    保留段 grants/publication 不被 sub 通配覆盖）
       AND NOT EXISTS (
         SELECT 1 FROM (
           -- base 候选（id 通配 × sub 通配，保留段 sub 不被 '*' 覆盖）
           SELECT unnest(ARRAY[
             'node:' || rg.resource_type || '/' || rg.resource_id
               || CASE WHEN rg.resource_sub = '*' THEN '' ELSE '/' || rg.resource_sub END
               || '@' || rg.permission_level,
             'node:' || rg.resource_type || '/*'
               || CASE WHEN rg.resource_sub = '*' THEN '' ELSE '/' || rg.resource_sub END
               || '@' || rg.permission_level
           ] || CASE WHEN rg.resource_sub = '*'
                       OR rg.resource_sub IN ('grants', 'publication', 'assignees', 'imports')
                       OR rg.resource_sub LIKE 'grants/%'
                       OR rg.resource_sub LIKE 'publication/%'
                       OR rg.resource_sub LIKE 'assignees/%'
                       OR rg.resource_sub LIKE 'imports/%'
                THEN ARRAY[]::text[]
                ELSE ARRAY[
                  'node:' || rg.resource_type || '/' || rg.resource_id || '@' || rg.permission_level,
                  'node:' || rg.resource_type || '/*@' || rg.permission_level
                ] END) AS base_key
         ) base
         -- 批G 通配区间：type 通配（RESERVED_TYPES 治理域除外）× verb 通配
         CROSS JOIN LATERAL (VALUES
           (base.base_key),
           (CASE WHEN rg.resource_type <> ALL($4::text[])
                 THEN regexp_replace(base.base_key, '^node:[^/]+/[^/@]+', 'node:*/*') END)
         ) AS t(k1)
         CROSS JOIN LATERAL (VALUES
           (t.k1),
           (regexp_replace(t.k1, '@[a-z]+$', '@*'))
         ) AS cand(key)
         WHERE cand.key IS NOT NULL AND cand.key IN (
           SELECT prp.permission_key
           FROM production_member_role pmr
           JOIN production_role_permission prp ON prp.role_id = pmr.role_id
           WHERE pmr.production_id = rg.production_id AND pmr.user_id = rg.user_id
           UNION ALL
           SELECT pdp.permission_key
           FROM production_dept_permission pdp
           WHERE pdp.production_id = rg.production_id
             AND pdp.dept_id IN (
               WITH RECURSIVE chain AS (
                 SELECT pd.id, pd.parent_id
                 FROM production_dept_member pdm
                 JOIN production_dept pd ON pd.id = pdm.dept_id
                 WHERE pdm.production_id = rg.production_id AND pdm.user_id = rg.user_id
                 UNION
                 SELECT pd2.id, pd2.parent_id
                 FROM production_dept pd2 JOIN chain c ON pd2.id = c.parent_id
               )
               SELECT id FROM chain
             )
           UNION ALL
           SELECT pmp.permission
           FROM production_member_permission pmp
           WHERE pmp.production_id = rg.production_id AND pmp.user_id = rg.user_id
             AND pmp.granted = true
         )
       )`,
    [productionId, userId, reason, [...RESERVED_TYPES]],
  );
}

/**
 * Revoke ALL active grants for a member being removed from a production,
 * and clean up their role/dept/tag associations.
 * Called inside a transaction by removeProductionMember before the member row is deleted.
 */
export async function revokeAllGrantsForMember(
  productionId: string,
  userId: string,
  pool: Pool | PoolClient = getPool(),
): Promise<void> {
  await pool.query(
    `UPDATE production_member_grant SET is_revoked = true, revoked_reason = 'member_removed'
     WHERE production_id = $1 AND user_id = $2 AND is_revoked = false`,
    [productionId, userId],
  );
  await pool.query(
    "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2",
    [productionId, userId],
  );
  await pool.query(
    "DELETE FROM production_dept_member WHERE production_id = $1 AND user_id = $2",
    [productionId, userId],
  );
  await pool.query(
    "DELETE FROM production_member_tag_assignment WHERE production_id = $1 AND user_id = $2",
    [productionId, userId],
  );
}

/**
 * When a user is removed from a dept, revoke self_confirmed grants no longer
 * covered by any remaining dept or role.
 */
export async function revokeGrantsForDeptRemoval(
  deptId: string,
  productionId: string,
  removedUserIds: string[],
  pool: Pool | PoolClient = getPool(),
): Promise<void> {
  if (removedUserIds.length === 0) return;
  for (const userId of removedUserIds) {
    await recomputeAndRevokeGrants(userId, productionId, "dept_change", pool);
  }
}

/**
 * When a user loses POC status in a dept, revoke self_confirmed grants that
 * were exclusively in the POC zone (not covered by remaining membership zone).
 * Also revokes production_member_grant rows no longer covered by any dept membership.
 */
export async function revokeGrantsForPocLoss(
  deptId: string,
  productionId: string,
  userIds: string[],
  pool: Pool | PoolClient = getPool(),
): Promise<void> {
  if (userIds.length === 0) return;
  for (const userId of userIds) {
    await recomputeAndRevokeGrants(userId, productionId, "poc_change", pool);
  }
}

// ─── Resource dept manage helpers ─────────────────────────────────────────────

export type ResourceDeptManageEntry = {
  id: string;
  deptId: string;
  resourceType: string;
  resourceId: string;
  resourceSub: string;
  establishedBy: string;
};

export async function listResourceDeptManage(
  productionId: string,
  resourceType: string,
  resourceId?: string,
): Promise<ResourceDeptManageEntry[]> {
  const { rows } = await getPool().query<{
    id: string;
    dept_id: string;
    resource_type: string;
    resource_id: string;
    resource_sub: string;
    established_by: string;
  }>(
    `SELECT id, dept_id, resource_type, resource_id, resource_sub, established_by
     FROM resource_dept_manage
     WHERE production_id = $1
       AND resource_type = $2
       AND resource_id = ANY($3)`,
    [productionId, resourceType, resourceId ? [resourceId, "*"] : ["*"]],
  );
  return rows.map((r) => ({
    id: r.id,
    deptId: r.dept_id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    resourceSub: r.resource_sub,
    establishedBy: r.established_by,
  }));
}

export async function addResourceDeptManage(params: {
  productionId: string;
  deptId: string;
  resourceType: string;
  resourceId?: string;
  resourceSub?: string;
  establishedBy: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      params.productionId,
      params.deptId,
      params.resourceType,
      params.resourceId ?? "*",
      params.resourceSub ?? "*",
      params.establishedBy,
    ],
  );
}

export async function removeResourceDeptManage(
  productionId: string,
  deptId: string,
  resourceType: string,
  resourceId?: string,
  resourceSub?: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM resource_dept_manage
     WHERE production_id = $1 AND dept_id = $2 AND resource_type = $3
       AND resource_id = $4 AND resource_sub = $5`,
    [
      productionId,
      deptId,
      resourceType,
      resourceId ?? "*",
      resourceSub ?? "*",
    ],
  );
}

// ─── Approval config ──────────────────────────────────────────────────────────

export async function getOrCreateApprovalConfig(
  productionId: string,
): Promise<{ ttlHours: number }> {
  const pool = getPool();
  const { rows } = await pool.query<{ ttl_hours: number }>(
    `INSERT INTO production_approval_config (production_id, ttl_hours)
     VALUES ($1, 24)
     ON CONFLICT (production_id) DO UPDATE SET production_id = EXCLUDED.production_id
     RETURNING ttl_hours`,
    [productionId],
  );
  return { ttlHours: rows[0].ttl_hours };
}

export async function updateApprovalConfig(
  productionId: string,
  ttlHours: number,
  updatedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_approval_config (production_id, ttl_hours, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (production_id) DO UPDATE SET
       ttl_hours  = EXCLUDED.ttl_hours,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [productionId, ttlHours, updatedBy],
  );
}

// ─── Dept user lookup (used by approval routing) ──────────────────────────────

/** Returns the current POC user IDs for a dept (needed for approval routing). */
export async function getDeptPocUserIds(deptId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    "SELECT user_id FROM production_dept_member WHERE dept_id = $1 AND is_poc = true",
    [deptId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Given a resource, compute the approval routing chain:
 * 1. Current personal manage grant holders for the resource
 * 2. → resource_dept_manage managing depts' current POCs
 * 3. → each dept's parent POC (recursive upward)
 * 4. → Production Owner (final fallback)
 *
 * Returns ordered tiers; Phase 6 will use this to send notifications.
 */
export async function computeApprovalRoutingChain(
  productionId: string,
  resourceType: string,
  resourceId: string,
): Promise<{ tier: number; userIds: string[] }[]> {
  const pool = getPool();

  // Tier 1: personal manage grant holders
  const { rows: manageGrantors } = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM production_member_grant
     WHERE production_id = $1
       AND resource_type = $2
       AND resource_id   = ANY($3)
       AND resource_sub  = '*'
       AND permission_level = 'manage'
       AND is_revoked = false
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, resourceType, [resourceId, "*"]],
  );

  // Tier 2+: resource_dept_manage POC chain (recursive up the dept tree)
  const { rows: manageDepts } = await pool.query<{ dept_id: string }>(
    `SELECT DISTINCT dept_id FROM resource_dept_manage
     WHERE production_id = $1
       AND resource_type = $2
       AND resource_id = ANY($3)`,
    [productionId, resourceType, [resourceId, "*"]],
  );

  const tree = await loadDeptTree(productionId, pool);
  const visited = new Set<string>();
  const tiers: { tier: number; userIds: string[] }[] = [
    { tier: 1, userIds: manageGrantors.map((r) => r.user_id) },
  ];

  // Walk up the dept tree tier by tier
  let currentDeptIds = manageDepts.map((r) => r.dept_id);
  let tierNum = 2;
  const byId = new Map(tree.map((d) => [d.id, d]));

  while (currentDeptIds.length > 0) {
    const pocIds: string[] = [];
    for (const deptId of currentDeptIds) {
      if (visited.has(deptId)) continue;
      visited.add(deptId);
      const pocs = await getDeptPocUserIds(deptId);
      pocIds.push(...pocs);
    }
    if (pocIds.length > 0) tiers.push({ tier: tierNum++, userIds: [...new Set(pocIds)] });

    // Move to parent depts
    const nextDeptIds: string[] = [];
    for (const deptId of currentDeptIds) {
      const parent = byId.get(deptId)?.parent_id;
      if (parent && !visited.has(parent)) nextDeptIds.push(parent);
    }
    currentDeptIds = nextDeptIds;
  }

  return tiers;
}
