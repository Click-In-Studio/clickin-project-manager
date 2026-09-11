/**
 * Snapshot plumbing for migrate-merge-event-department.sql.
 *
 * Pre-migration detection: event_department table still exists.
 * Factory data (created in global-setup before applying the migration):
 *   - production P with production_dept row 「镜像部门」 (org side)
 *   - event_department rows: 「镜像部门」 (same-name mirror) + 「孤儿组」 (kind='group', no org twin)
 *   - event_department_member rows on both (mirror: member+poc; orphan: poc with is_member=false)
 *   - production_dept_member row for the SAME (user, mirror) pair with is_poc=false
 *     (merge must OR it up to true)
 *   - FK rows: event_report_note + event_tech_req + schedule_item_department on mirror dept
 *   - production_member_grant row resource_type='dept' anchored at the OLD event id
 *   - chat_id only on the event side (merge must carry it over)
 */
import type { Pool } from "pg";
import path from "path";

export const MERGE_EVENT_DEPT_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "tests/.merge-event-department-snapshot.json",
);

export type MergeEventDeptSnapshot = {
  prodId: string;
  userId: string;
  mirrorOldId: string;   // event_department.id of the same-name mirror
  mirrorNewId: string;   // production_dept.id it must map to
  orphanOldId: string;   // event_department.id of the kind='group' orphan
  orphanName: string;
  mirrorChatId: string;
  reportNoteId: string;
  techReqId: string;
  scheduleItemId: string;
};

export async function isMergeEventDeptPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'event_department'`,
  );
  return rows.length > 0;
}

export async function createMergeEventDeptPreMigrationData(
  pool: Pool,
  userId: string,
): Promise<MergeEventDeptSnapshot> {
  const prodId = "medmig01";
  await pool.query(
    `INSERT INTO production (id, name, owner_id) VALUES ($1, '并表迁移工厂', $2)
     ON CONFLICT (id) DO NOTHING`,
    [prodId, userId],
  );
  await pool.query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')
     ON CONFLICT DO NOTHING`,
    [prodId, userId],
  );

  // Org-side mirror dept
  const { rows: [{ id: mirrorNewId }] } = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, '镜像部门') RETURNING id`,
    [prodId],
  );
  // Same (user, dept) already member org-side as NON-poc — merge must OR to true
  await pool.query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
     VALUES ($1, $2, $3, false)`,
    [prodId, mirrorNewId, userId],
  );

  // Event-side rows
  const mirrorOldId = "edmigmirror1";
  const orphanOldId = "edmigorphan1";
  const orphanName = "孤儿组";
  const mirrorChatId = "oc_mig_chat_1";
  await pool.query(
    `INSERT INTO event_department (id, production_id, name, kind, chat_id) VALUES
       ($1, $3, '镜像部门', 'dept', $5),
       ($2, $3, $4, 'group', NULL)`,
    [mirrorOldId, orphanOldId, prodId, orphanName, mirrorChatId],
  );
  await pool.query(
    `INSERT INTO event_department_member (department_id, user_id, is_member, is_poc) VALUES
       ($1, $3, true, true),
       ($2, $3, false, true)`,
    [mirrorOldId, orphanOldId, userId],
  );

  // FK rows anchored at the old event id
  const { rows: [{ id: eventId }] } = await pool.query<{ id: string }>(
    `INSERT INTO production_event (id, production_id, title, created_by, status)
     VALUES ('evmedmig1', $1, '并表工厂事件', $2, 'published') RETURNING id`,
    [prodId, userId],
  );
  const reportNoteId = "ernmedmig1";
  const { rows: [{ id: wikiId }] } = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, '并表工厂wiki', '', $2) RETURNING id`,
    [prodId, userId],
  );
  await pool.query(
    `INSERT INTO event_report (id, event_id, wiki_id) VALUES ('rptmedmig1', $1, $2)`,
    [eventId, wikiId],
  );
  await pool.query(
    `INSERT INTO event_report_note (id, report_id, department_id, wiki_id, created_via)
     VALUES ($1, 'rptmedmig1', $2, $3, 'dept')`,
    [reportNoteId, mirrorOldId, wikiId],
  );
  const techReqId = "etrmedmig1";
  await pool.query(
    `INSERT INTO event_tech_req (id, event_id, department_id, title, status)
     VALUES ($1, $2, $3, '并表工厂需求', 'pending')`,
    [techReqId, eventId, mirrorOldId],
  );
  const scheduleItemId = "esimedmig1";
  await pool.query(
    `INSERT INTO event_schedule_item (id, event_id, title) VALUES ($1, $2, '并表工厂条目')`,
    [scheduleItemId, eventId],
  );
  await pool.query(
    `INSERT INTO schedule_item_department (item_id, dept_id) VALUES ($1, $2)`,
    [scheduleItemId, mirrorOldId],
  );

  // dept permission instance row anchored at the OLD id
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'dept', $3, 'notes', 'create', 'auto')`,
    [prodId, userId, mirrorOldId],
  );

  return {
    prodId, userId, mirrorOldId, mirrorNewId, orphanOldId, orphanName,
    mirrorChatId, reportNoteId, techReqId, scheduleItemId,
  };
}
