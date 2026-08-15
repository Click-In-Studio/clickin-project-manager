/**
 * Snapshot plumbing for migrate-task-standalone.sql.
 *
 * Pre-migration detection: event_tech_req table still exists.
 * Factory data (created in global-setup before applying the migration; the
 * global-setup block must run AFTER the merge-event-department block — the
 * factory writes the post-merge schema where department_id is already UUID):
 *   - production P + production_dept D + production_event E (with start/end)
 *   - event_schedule_item S on E
 *   - event_tech_req T1: explicit, dept D, assignee TEST_USER, item link S
 *   - event_tech_req T2: dept_auto awaiting, dept D, no assignee/items
 *   - resource_dept_manage row with the buggy legacy resource_type='tech_req'
 *     anchored at T1 (migration must fold it into 'task')
 *   - asset A + asset_mount M with mount_type='event_tech_req' on T1
 *     (migration must rewrite the value to 'task')
 */
import type { Pool } from "pg";
import path from "path";

export const TASK_STANDALONE_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "tests/.task-standalone-snapshot.json",
);

export type TaskStandaloneSnapshot = {
  prodId: string;
  userId: string;
  deptId: string;
  eventId: string;
  eventStart: string;
  eventEnd: string;
  scheduleItemId: string;
  explicitReqId: string;
  deptAutoReqId: string;
  assetMountId: string;
};

export async function isTaskStandalonePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'event_tech_req'`,
  );
  return rows.length > 0;
}

export async function createTaskStandalonePreMigrationData(
  pool: Pool,
  userId: string,
): Promise<TaskStandaloneSnapshot> {
  const prodId = "tskmig01";
  await pool.query(
    `INSERT INTO production (id, name, owner_id) VALUES ($1, 'task独立化迁移工厂', $2)
     ON CONFLICT (id) DO NOTHING`,
    [prodId, userId],
  );
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')
     ON CONFLICT DO NOTHING`,
    [prodId, userId],
  );

  const { rows: [{ id: deptId }] } = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, 'task迁移部门') RETURNING id`,
    [prodId],
  );

  const eventStart = "2026-09-01T10:00:00.000Z";
  const eventEnd = "2026-09-01T18:00:00.000Z";
  const eventId = "evtskmig1";
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, created_by, status, start_time, end_time)
     VALUES ($1, $2, 'task迁移工厂事件', $3, 'published', $4, $5)`,
    [eventId, prodId, userId, eventStart, eventEnd],
  );

  const scheduleItemId = "esitskmig1";
  await pool.query(
    `INSERT INTO event_schedule_item (id, event_id, title, start_time, end_time)
     VALUES ($1, $2, 'task迁移工厂条目', $3, $4)`,
    [scheduleItemId, eventId, "2026-09-01T13:00:00.000Z", "2026-09-01T15:00:00.000Z"],
  );

  const explicitReqId = "etrtskmig1";
  const deptAutoReqId = "etrtskmig2";
  await pool.query(
    `INSERT INTO event_tech_req (id, event_id, department_id, title, description, status, created_via) VALUES
       ($1, $3, $4, 'task迁移显式需求', '迁移前描述', 'in_progress', 'explicit'),
       ($2, $3, $4, '', '', 'awaiting', 'dept_auto')`,
    [explicitReqId, deptAutoReqId, eventId, deptId],
  );
  await pool.query(
    `INSERT INTO event_tech_assignee (req_id, user_id, name) VALUES ($1, $2, 'task迁移指派人')`,
    [explicitReqId, userId],
  );
  await pool.query(
    `INSERT INTO event_tech_req_item (req_id, item_id) VALUES ($1, $2)`,
    [explicitReqId, scheduleItemId],
  );

  // Legacy buggy row: writeTechReqGrants used to write the event-inherited
  // managing dept with resource_type='tech_req' (readers only query 'task').
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'tech_req', $3, '*', $4)`,
    [prodId, deptId, explicitReqId, userId],
  );

  const assetMountId = "amtskmig1";
  await pool.query(
    `INSERT INTO asset (id, production_id, uploader_user_id, file_name)
     VALUES ('astskmig1', $1, $2, 'task迁移附件.png')`,
    [prodId, userId],
  );
  // asset 域完整性不变量（asset-rest 测试层 2）：uploader 须有 person 归属行
  await pool.query(
    `INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, established_by)
     VALUES ($1, $2, 'asset', 'astskmig1', $2)
     ON CONFLICT DO NOTHING`,
    [prodId, userId],
  );
  await pool.query(
    `INSERT INTO asset_mount (id, asset_id, production_id, mount_type, mount_id, created_by)
     VALUES ($1, 'astskmig1', $2, 'event_tech_req', $3, $4)`,
    [assetMountId, prodId, explicitReqId, userId],
  );

  return {
    prodId, userId, deptId, eventId, eventStart, eventEnd,
    scheduleItemId, explicitReqId, deptAutoReqId, assetMountId,
  };
}
