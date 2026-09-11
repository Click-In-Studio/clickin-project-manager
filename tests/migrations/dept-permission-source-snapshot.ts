/**
 * Pre-migration snapshot for migrate-dept-permission-source（#274）。
 *
 * isMigrationNeeded: `production_dept_permission` 还没有 `source` 列。
 *
 * 工厂造的是**回填要分辨的四种行**，一行一个判据，其中第四行是这支迁移真正的考点：
 *   ① 有 cue 声明覆盖的实例键        → 应回填 'template'
 *   ② 有 resource_dept_manage 覆盖的 → 应回填 'resource'
 *   ③ 通配区间键                     → 保持 'manual'
 *   ④ **无声明、无归属信号的实例键**  → 保持 'manual'
 *
 * ④ 就是「制作人手动给某张 cue 表发了一枚键」的形态。它与 ① 键形完全同类，所以任何
 * 「具体实例 id ⇒ 自动行」的推断都会把它误判成别处在管、从而在界面上变成删不掉的只读行。
 * 这也正是本 issue 最终选择记录 source 而不是读时推断的原因。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const DEPT_PERMISSION_SOURCE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "dept-permission-source-migration-snapshot.json",
);

export type DeptPermissionSourceSnapshot = {
  prodId: string;
  deptId: string;
  /** 键 → 期望回填出的 source */
  expected: Record<string, "manual" | "template" | "resource">;
};

export async function isDeptPermissionSourcePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'production_dept_permission' AND column_name = 'source'
  `);
  return rows.length === 0;
}

export async function createDeptPermissionSourcePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<DeptPermissionSourceSnapshot> {
  const sid = () => `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const prodId = sid();
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);
  const { rows: deptRows } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, '回填工厂部') RETURNING id",
    [prodId],
  );
  const deptId = deptRows[0].id;

  // ① 声明覆盖的 cue 表
  const declaredCue = sid();
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, template, created_by)
     VALUES ($1, $2, '声明覆盖表', '音效', $3)`,
    [declaredCue, prodId, testUserId],
  );
  await pool.query(
    `INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions)
     VALUES ($1, $2, '音效', true, ARRAY['@view'])`,
    [prodId, deptId],
  );

  // ④ 无声明覆盖的 cue 表（人手动发键的那种）
  const manualCue = sid();
  await pool.query(
    `INSERT INTO cue_list (id, production_id, name, template, created_by)
     VALUES ($1, $2, '手动发键表', '催场', $3)`,
    [manualCue, prodId, testUserId],
  );

  // ② 归属信号覆盖的事件（resource_id 是 TEXT 无 FK，不必造真事件）
  const managedEvent = sid();
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'event', $3, '*', $4)`,
    [prodId, deptId, managedEvent, testUserId],
  );

  const expected: DeptPermissionSourceSnapshot["expected"] = {
    [`node:cue_list/${declaredCue}@view`]: "template",
    [`node:event/${managedEvent}@view`]: "resource",
    "node:asset/*@create": "manual",
    [`node:cue_list/${manualCue}@view`]: "manual",
  };
  for (const key of Object.keys(expected)) {
    await pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
       VALUES ($1, $2, $3)`,
      [prodId, deptId, key],
    );
  }

  return { prodId, deptId, expected };
}
