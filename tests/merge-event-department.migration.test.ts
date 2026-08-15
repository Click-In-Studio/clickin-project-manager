/**
 * Migration tests for migrate-merge-event-department.sql.
 *
 * Operating modes:
 *   Migration path (CI): global-setup detects event_department still exists,
 *     inserts factory rows on both sides, applies the migration, writes snapshot.
 *     All three layers run.
 *   Normal path (already-merged DB): snapshot absent — schema/integrity run,
 *     invariance skips (it.skipIf).
 *
 * Layers:
 *   1. Schema    — event_department(+member) gone; production_dept has kind and
 *                  lost the array columns; production_dept_member lost poc arrays;
 *                  six FK columns are UUID and point at production_dept
 *   2. Integrity — no orphan dept references anywhere in the FK family / grants
 *   3. Invariance — same-name mirror mapped (members OR'd, chat_id carried,
 *                  FK rows + dept grants rewritten); orphan group recreated
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  MERGE_EVENT_DEPT_SNAPSHOT_PATH,
  type MergeEventDeptSnapshot,
} from "./merge-event-department-snapshot";

let snapshot: MergeEventDeptSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(MERGE_EVENT_DEPT_SNAPSHOT_PATH, "utf8"),
  ) as MergeEventDeptSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("event_department and event_department_member are gone", async () => {
    const { rows } = await getPool().query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('event_department', 'event_department_member')
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_dept has kind TEXT NOT NULL DEFAULT 'dept'", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'production_dept' AND column_name = 'kind'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("dept");
  });

  it("production_dept lost permissions / allowed_cue_types", async () => {
    const { rows } = await getPool().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'production_dept'
        AND column_name IN ('permissions', 'allowed_cue_types')
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_dept_member lost poc_extra/poc_blocked arrays", async () => {
    const { rows } = await getPool().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'production_dept_member'
        AND column_name IN ('poc_extra_permissions', 'poc_blocked_permissions')
    `);
    expect(rows).toHaveLength(0);
  });

  it("all six FK columns are UUID referencing production_dept", async () => {
    // task 原名 event_tech_req——本迁移之后的 task-standalone 迁移改的名，
    // 这里断言的是当前终态列
    const { rows } = await getPool().query<{ table_name: string; data_type: string }>(`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('event_participant', 'department_id'),
        ('event_call_time', 'department_id'),
        ('task', 'department_id'),
        ('schedule_item_department', 'dept_id'),
        ('event_report_note', 'department_id')
      )
    `);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.data_type).toBe("uuid");

    const { rows: fks } = await getPool().query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'production_dept'
        AND tc.table_name IN ('event_participant', 'event_call_time', 'task',
                              'schedule_item_department', 'event_report_note')
    `);
    expect(Number(fks[0].count)).toBeGreaterThanOrEqual(5);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no dept grants anchored at ids missing from production_dept", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_member_grant g
      WHERE g.resource_type = 'dept' AND g.resource_id <> '*'
        AND NOT EXISTS (SELECT 1 FROM production_dept pd WHERE pd.id::text = g.resource_id)
      LIMIT 5
    `);
    expect(rows).toHaveLength(0);
  });

  it("no orphan production_dept_member rows", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_dept_member pdm
      WHERE NOT EXISTS (SELECT 1 FROM production_dept pd WHERE pd.id = pdm.dept_id)
      LIMIT 5
    `);
    expect(rows).toHaveLength(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("same-name mirror: FK rows rewritten to the org dept id", async () => {
    const s = snapshot!;
    const [note, req, sched] = await Promise.all([
      getPool().query<{ department_id: string }>(
        "SELECT department_id FROM event_report_note WHERE id = $1", [s.reportNoteId]),
      getPool().query<{ department_id: string }>(
        "SELECT department_id FROM task WHERE id = $1", [s.techReqId]),
      getPool().query<{ dept_id: string }>(
        "SELECT dept_id FROM schedule_item_department WHERE item_id = $1", [s.scheduleItemId]),
    ]);
    expect(note.rows[0].department_id).toBe(s.mirrorNewId);
    expect(req.rows[0].department_id).toBe(s.mirrorNewId);
    expect(sched.rows[0].dept_id).toBe(s.mirrorNewId);
  });

  it.skipIf(!snapshot)("dept grant instance id rewritten old → new", async () => {
    const s = snapshot!;
    const { rows: old } = await getPool().query(
      "SELECT 1 FROM production_member_grant WHERE resource_type='dept' AND resource_id = $1",
      [s.mirrorOldId]);
    expect(old).toHaveLength(0);
    const { rows: renewed } = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE resource_type='dept' AND resource_id = $1 AND user_id = $2
         AND resource_sub = 'notes' AND permission_level = 'create'`,
      [s.mirrorNewId, s.userId]);
    expect(renewed).toHaveLength(1);
  });

  it.skipIf(!snapshot)("membership merged with is_poc OR'd; chat_id carried over", async () => {
    const s = snapshot!;
    const { rows: member } = await getPool().query<{ is_poc: boolean }>(
      "SELECT is_poc FROM production_dept_member WHERE dept_id = $1 AND user_id = $2",
      [s.mirrorNewId, s.userId]);
    expect(member).toHaveLength(1);
    expect(member[0].is_poc).toBe(true);  // org side had false, event side true → OR

    const { rows: dept } = await getPool().query<{ chat_id: string | null }>(
      "SELECT chat_id FROM production_dept WHERE id = $1", [s.mirrorNewId]);
    expect(dept[0].chat_id).toBe(s.mirrorChatId);
  });

  it.skipIf(!snapshot)("orphan group recreated as production_dept kind='group' with its POC", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ id: string; kind: string }>(
      "SELECT id, kind FROM production_dept WHERE production_id = $1 AND name = $2",
      [s.prodId, s.orphanName]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("group");
    const { rows: poc } = await getPool().query<{ is_poc: boolean }>(
      "SELECT is_poc FROM production_dept_member WHERE dept_id = $1 AND user_id = $2",
      [rows[0].id, s.userId]);
    expect(poc).toHaveLength(1);
    expect(poc[0].is_poc).toBe(true);  // is_member=false POC 转正保留 POC 位
  });
});
