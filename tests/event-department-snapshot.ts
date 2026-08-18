/**
 * Pre-migration snapshot for migrate-event-department invariance tests.
 *
 * isEventDeptPreMigrationSchema: true when production_dept_member is empty
 *   AND event_department has rows (data hasn't been migrated yet).
 *
 * createEventDeptPreMigrationData: inserts an event_department + member row
 *   using existing schema, returns the key values for invariance verification.
 *
 * Invariance test verifies that after migration:
 *   - Every (production_id, dept_name) from event_department (kind='dept')
 *     has a corresponding production_dept row.
 *   - Every (is_member=true) event_department_member row has a corresponding
 *     production_dept_member row, matched by (production_id, dept_name, user_id).
 *   - is_poc is preserved.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const EVENT_DEPT_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "event-department-migration-snapshot.json",
);

export type EventDeptSnapshot = {
  production: { id: string };
  dept: {
    oldId: string;      // TEXT id in event_department
    name: string;
    displayOrder: number;
  };
  members: Array<{
    userId: string;
    isPoc: boolean;
    isMember: boolean;
  }>;
};

/**
 * Pre-migration when event_department has 'dept'-kind rows that don't yet have
 * a corresponding production_dept row (matched by production_id + name).
 * We compare a specific factory dept by name to avoid false positives from
 * pre-existing data in the DB.
 */
export async function isEventDeptPreMigrationSchema(pool: Pool): Promise<boolean> {
  // production_dept 空只说明"没数据"，新库恒空——必须同时确认老 schema 事实：
  // 该迁移读取 event_report.created_by（wiki 拆分后此列不存在，迁移不可重放）。
  const [{ rows: deptRows }, { rows: colRows }] = await Promise.all([
    pool.query("SELECT 1 FROM production_dept LIMIT 1"),
    pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'event_report' AND column_name = 'created_by'
    `),
  ]);
  return deptRows.length === 0 && colRows.length > 0;
}

export async function createEventDeptPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<EventDeptSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const deptId = `dept_${faker.string.alphanumeric(8)}`;
  const deptName = `迁移测试部门_${faker.string.alphanumeric(4)}`;

  // Create production
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId,
    faker.company.name(), testUserId,
  ]);
  await pool.query(
    "INSERT INTO version (id, production_id, name, created_at) VALUES ($1, $2, $3, NOW())",
    [`${prodId}_v1`, prodId, "initial"],
  );
  await pool.query("UPDATE production SET active_version_id = $1 WHERE id = $2", [
    `${prodId}_v1`,
    prodId,
  ]);

  // Create production_member (needed for production_dept_member FK after migration)
  await pool.query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [prodId, testUserId],
  );

  // Create event_department (kind='dept')
  await pool.query(
    `INSERT INTO event_department (id, production_id, name, kind, display_order)
     VALUES ($1, $2, $3, 'dept', 1)`,
    [deptId, prodId, deptName],
  );

  // Create event_department_member (is_member=true, is_poc=true)
  await pool.query(
    `INSERT INTO event_department_member (department_id, user_id, is_member, is_poc)
     VALUES ($1, $2, true, true)`,
    [deptId, testUserId],
  );

  return {
    production: { id: prodId },
    dept: { oldId: deptId, name: deptName, displayOrder: 1 },
    members: [{ userId: testUserId, isPoc: true, isMember: true }],
  };
}
