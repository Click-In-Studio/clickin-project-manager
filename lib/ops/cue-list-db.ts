/**
 * Cue 表（cue_list 表）数据层：CRUD、成员可见 / 可编辑清单、表级授权行的读写，
 * 以及创建定式（创建者行集 + 部门归属）。剧本导入时按列建表 / 落 cue 的事务件
 * 也在这里——它先建 cue_list 再插 cue，归属按「谁的表」定。
 *
 * cue 本体（锚点、CoW 修订、随剧本块漂移）在 cue-db.ts；cue 类型模版的发键在
 * cue-template-db.ts；策略开关在 perm/policy-db.ts（两处仍按原样动态 import）。
 */
import { getPool } from "../pg";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { CueList, CueListPermissionRow } from "./cue-list-types";

type CueListRow = {
  id: string; production_id: string; name: string; notes: string;
  abbr: string | null; template: string | null;
  created_by: string; created_by_name: string; created_at: Date;
};

function rowToCueList(r: CueListRow): CueList {
  return {
    id: r.id, productionId: r.production_id, name: r.name, notes: r.notes,
    abbr: r.abbr, template: r.template,
    createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listCueLists(productionId: string): Promise<CueList[]> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.production_id = $1
     ORDER BY cl.created_at`,
    [productionId]
  );
  return res.rows.map(rowToCueList);
}

/**
 * Returns cue lists for a production with per-list canEdit/canManage（批A REST 语义）。
 * 目录三态：seeAll=false 时只返回用户持有 meta/cues view 行（含通配）的表；
 * seeAll=true（admin/owner）返回全量。
 * canEdit = 覆盖 cues 的 edit 行；canManage = 显式 grants edit 行。
 */
export async function listCueListsWithAccess(
  productionId: string,
  userId: string,
  opts: { seeAll?: boolean } = {},
): Promise<(CueList & { canEdit: boolean; canManage: boolean })[]> {
  const res = await getPool().query<CueListRow & { can_edit: boolean; can_manage: boolean }>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at,
            EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub IN ('cues', '*')
                AND rg.permission_level = 'edit'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ) AS can_edit,
            EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub = 'grants'
                AND rg.permission_level = 'edit'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ) AS can_manage
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.production_id = $1
       AND ($3 OR EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.production_id = cl.production_id
                AND rg.resource_type = 'cue_list'
                AND rg.resource_id IN (cl.id, '*')
                AND rg.resource_sub IN ('meta', 'cues', '*')
                AND rg.permission_level = 'view'
                AND rg.user_id = $2
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
            ))
     ORDER BY cl.created_at`,
    [productionId, userId, opts.seeAll === true],
  );
  return res.rows.map((r) => ({ ...rowToCueList(r), canEdit: r.can_edit, canManage: r.can_manage }));
}

export async function createCueList(data: {
  id: string; productionId: string; name: string; notes: string;
  abbr: string | null; template: string | null; createdBy: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cue_list (id, production_id, name, notes, abbr, template, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [data.id, data.productionId, data.name, data.notes, data.abbr, data.template, data.createdBy],
    );
    await seedCueListCreatorAccessInTx(client, data);
    // §3.5 受益发键定式：∀ (dept, template) 声明行 → 实例区间键
    if (data.template) {
      const { applyCueTemplateGrants } = await import("./cue-template-db");
      await applyCueTemplateGrants(client, data.productionId, data.id, data.template);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCueList(id: string, productionId: string): Promise<CueList | null> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.abbr, cl.template,
            cl.created_by, COALESCE(up.name, '') AS created_by_name, cl.created_at
     FROM cue_list cl
     LEFT JOIN user_profile up ON up.user_id = cl.created_by
     WHERE cl.id = $1 AND cl.production_id = $2`,
    [id, productionId]
  );
  if (!res.rows.length) return null;
  return rowToCueList(res.rows[0]);
}

/** Returns the set of role names defined for a production (from production_role table). */
/**
 * Returns true if the user can edit this cue list（批A REST 语义）：
 * 持有 (id|'*') 上覆盖 cues 的 edit 动词行（'*' 整树或显式 cues）。
 * 存量 edit 行（sub='*' level='edit'）天然是合法树行；原 manage 行经迁移拆解。
 */
export async function hasListAccess(cueListId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ has_access: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM production_member_grant rg
       JOIN cue_list cl ON cl.id = $1 AND cl.production_id = rg.production_id
       WHERE rg.resource_type = 'cue_list'
         AND rg.resource_id IN ($1, '*')
         AND rg.resource_sub IN ('cues', '*')
         AND rg.permission_level = 'edit'
         AND rg.user_id = $2
         AND NOT rg.is_revoked
         AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ) AS has_access`,
    [cueListId, userId],
  );
  return res.rows[0]?.has_access === true;
}

/**
 * Returns user IDs of all members with active edit or manage grants on a cue list.
 * Used for cue warning notifications.
 */
export async function listCueListRoleMembers(cueListId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT rg.user_id
     FROM production_member_grant rg
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND rg.resource_sub IN ('cues', '*')
       AND rg.permission_level = 'edit'
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())`,
    [cueListId],
  );
  return res.rows.map((r) => r.user_id);
}

export async function updateCueList(
  id: string, productionId: string,
  fields: { name?: string; notes?: string; abbr?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, productionId];
  if (fields.name  !== undefined) sets.push(`name  = $${vals.push(fields.name)}`);
  if (fields.notes !== undefined) sets.push(`notes = $${vals.push(fields.notes)}`);
  if ("abbr" in fields) sets.push(`abbr = $${vals.push(fields.abbr ?? null)}`);
  if (!sets.length) return;
  await getPool().query(
    `UPDATE cue_list SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    vals
  );
}

export async function deleteCueList(id: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM cue_list WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
}

export async function listCueListPermissions(cueListId: string): Promise<CueListPermissionRow[]> {
  const res = await getPool().query<{ user_id: string; permission_level: string }>(
    `SELECT DISTINCT rg.user_id, rg.permission_level
     FROM production_member_grant rg
     WHERE rg.resource_type = 'cue_list'
       AND rg.resource_id = $1
       AND rg.resource_sub IN ('cues', '*')
       AND rg.permission_level = 'edit'
       AND NOT rg.is_revoked
       AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ORDER BY rg.user_id`,
    [cueListId],
  );
  return res.rows.map((r) => ({ userId: r.user_id, canEdit: true }));
}

export async function setCueListPermission(
  cueListId: string,
  userId: string,
  canEdit: boolean | null,
  grantedBy?: string,
): Promise<void> {
  if (canEdit === true) {
    // 批A：编辑授权 = 动词行集（view + edit + cues create/delete）
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT cl.production_id, $2, 'cue_list', $1, s.sub, s.verb, 'direct', $3
       FROM cue_list cl,
            (VALUES ('*', 'view'), ('*', 'edit'), ('cues', 'create'), ('cues', 'delete')) AS s(sub, verb)
       WHERE cl.id = $1
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [cueListId, userId, grantedBy ?? null],
    );
  } else {
    await getPool().query(
      `UPDATE production_member_grant
       SET is_revoked = true, revoked_reason = 'manual'
       WHERE resource_type = 'cue_list'
         AND resource_id = $1
         AND user_id = $2
         AND NOT is_revoked`,
      [cueListId, userId],
    );
  }
}

// ── 剧本导入的 cue 列（importScriptToVersion 事务内调用）──────────────────────

export type ImportedCueColumn = {
  name: string;
  cues: Array<{ afterBlockId: string | null; content: string }>;
};

export async function seedCueListCreatorAccessInTx(
  client: PoolClient,
  data: { id: string; productionId: string; template: string | null; createdBy: string },
): Promise<void> {
  // #236：创建者行集先过策略开关。注意 grant_source 虽写 self_confirmed，这是**创建
  // 定式**发的、不是用户点「自我确认」，故属形状 A 的论域（真正的自确认写点不接开关）。
  const { policyFilteredRows } = await import("../perm/policy-db");
  const cueRows = await policyFilteredRows(
    data.productionId, "cue_list", "creator",
    [["*", "view"], ["*", "edit"], ["*", "delete"],
     ["cues", "create"], ["cues", "delete"], ["grants", "edit"]],
    client,
  );
  await client.query(
    `WITH creator_grants AS (
       INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT $1, $3, 'cue_list', $2, s.sub, s.verb, 'self_confirmed', $3
       FROM UNNEST($5::text[], $6::text[]) AS s(sub, verb)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING
     ), eligible_depts AS (
       -- §3.5：归属匹配改读声明表（can_create 部门）；数组列已迁移退役中
       SELECT pdm.dept_id
       FROM production_dept_member pdm
       JOIN dept_cue_list_template t
         ON t.dept_id = pdm.dept_id AND t.production_id = pdm.production_id
       WHERE pdm.user_id = $3
         AND pdm.production_id = $1
         AND t.template = $4::text AND t.can_create
     ), dept_manage AS (
       INSERT INTO resource_dept_manage
         (production_id, dept_id, resource_type, resource_id, established_by)
       SELECT $1, dept_id, 'cue_list', $2, $3 FROM eligible_depts
       ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub)
       DO NOTHING
     ), dept_permissions AS (
       INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       -- source='resource'：由该表的归属信号在管（#274），权限中心折叠只读
       SELECT $1, eligible_depts.dept_id, k.key, 'resource'
       FROM eligible_depts
       CROSS JOIN (VALUES
         ('node:cue_list/' || $2 || '@view'),
         ('node:cue_list/' || $2 || '@edit'),
         ('node:cue_list/' || $2 || '/cues@create'),
         ('node:cue_list/' || $2 || '/cues@delete')
       ) AS k(key)
       ON CONFLICT (dept_id, permission_key) DO NOTHING
     )
     INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, established_by)
     SELECT $1, $3, 'cue_list', $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM eligible_depts)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [data.productionId, data.id, data.createdBy, data.template,
     cueRows.map((r) => r[0]), cueRows.map((r) => r[1])],
  );
}

export async function importCueColumnsInTx(
  client: PoolClient,
  productionId: string,
  versionId: string,
  createdBy: string,
  columns: ImportedCueColumn[],
): Promise<void> {
  const existingLists = await client.query<{ id: string; name: string; template: string | null }>(
    "SELECT id, name, template FROM cue_list WHERE production_id = $1 ORDER BY created_at",
    [productionId],
  );
  const normalizedKey = (value: string) => value.trim().toLocaleLowerCase();
  const listByKey = new Map<string, { id: string; name: string; template: string | null }>();
  for (const list of existingLists.rows) {
    listByKey.set(normalizedKey(list.name), list);
    if (list.template) listByKey.set(normalizedKey(list.template), list);
  }

  const resolvedColumns: Array<ImportedCueColumn & { listId: string }> = [];
  for (const column of columns) {
    const key = normalizedKey(column.name);
    let list = listByKey.get(key);
    if (!list) {
      const id = `cl${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      // #227：模版类型读 production 级注册表
      const typeRows = await client.query<{ key: string }>(
        "SELECT key FROM production_cue_template_type WHERE production_id = $1",
        [productionId],
      );
      const template = typeRows.rows.find((t) => normalizedKey(t.key) === key)?.key ?? null;
      await client.query(
        `INSERT INTO cue_list (id, production_id, name, notes, abbr, template, created_by)
         VALUES ($1, $2, $3, '', NULL, $4, $5)`,
        [id, productionId, column.name, template, createdBy],
      );
      await seedCueListCreatorAccessInTx(client, { id, productionId, template, createdBy });
      if (template) {
        const { applyCueTemplateGrants } = await import("./cue-template-db");
        await applyCueTemplateGrants(client, productionId, id, template);
      }
      list = { id, name: column.name, template };
      listByKey.set(key, list);
    }
    resolvedColumns.push({ ...column, listId: list.id });
  }

  const afterBlockIds = [...new Set(resolvedColumns.flatMap((column) =>
    column.cues.flatMap((cue) => cue.afterBlockId ? [cue.afterBlockId] : []),
  ))];
  const snapshotByBlockId = new Map<string, string>();
  if (afterBlockIds.length > 0) {
    const snapshots = await client.query<{ block_id: string; snapshot_id: string }>(
      `SELECT block_id, snapshot_id
       FROM script_version
       WHERE version_id = $1 AND block_id = ANY($2::text[])`,
      [versionId, afterBlockIds],
    );
    for (const row of snapshots.rows) snapshotByBlockId.set(row.block_id, row.snapshot_id);
    const missingBlockId = afterBlockIds.find((blockId) => !snapshotByBlockId.has(blockId));
    if (missingBlockId) throw new Error(`Imported Cue anchor block is missing: ${missingBlockId}`);
  }

  const listIds = [...new Set(resolvedColumns.map((column) => column.listId))];
  const existingNumbers = listIds.length > 0
    ? await client.query<{ cue_list_id: string; number: string }>(
        "SELECT cue_list_id, number FROM cue WHERE cue_list_id = ANY($1::text[])",
        [listIds],
      )
    : { rows: [] as Array<{ cue_list_id: string; number: string }> };
  const usedNumbersByList = new Map<string, Set<string>>();
  for (const row of existingNumbers.rows) {
    const used = usedNumbersByList.get(row.cue_list_id) ?? new Set<string>();
    used.add(row.number);
    usedNumbersByList.set(row.cue_list_id, used);
  }

  const cueRows: Array<{
    id: string;
    listId: string;
    number: string;
    content: string;
    snapshotId: string | null;
  }> = [];
  for (const column of resolvedColumns) {
    const usedNumbers = usedNumbersByList.get(column.listId) ?? new Set<string>();
    usedNumbersByList.set(column.listId, usedNumbers);
    let nextNumber = 1;
    for (const cue of column.cues) {
      while (usedNumbers.has(String(nextNumber))) nextNumber++;
      const number = String(nextNumber++);
      usedNumbers.add(number);
      const id = `cue${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      const snapshotId = cue.afterBlockId ? snapshotByBlockId.get(cue.afterBlockId)! : null;
      cueRows.push({ id, listId: column.listId, number, content: cue.content.trim(), snapshotId });
    }
  }
  if (cueRows.length === 0) return;
  await client.query(
    `INSERT INTO cue (
       id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind, end_snapshot_id, end_offset
     )
     SELECT imported.id, imported.id, imported.list_id, imported.number, '', imported.content,
            'gap', imported.snapshot_id, NULL, 'gap', imported.snapshot_id, NULL
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       AS imported(id, list_id, number, content, snapshot_id)`,
    [
      cueRows.map(row => row.id),
      cueRows.map(row => row.listId),
      cueRows.map(row => row.number),
      cueRows.map(row => row.content),
      cueRows.map(row => row.snapshotId),
    ],
  );
  await client.query(
    `INSERT INTO cue_version (revision_id, version_id, cue_id)
     SELECT cue_id, $2::text, cue_id FROM unnest($1::text[]) AS imported(cue_id)`,
    [cueRows.map(row => row.id), versionId],
  );
}
