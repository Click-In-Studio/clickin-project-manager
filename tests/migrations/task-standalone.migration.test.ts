/**
 * Migration tests for migrate-task-standalone.sql.
 *
 * Operating modes:
 *   Migration path (CI): global-setup detects event_tech_req still exists,
 *     inserts factory rows, applies the migration, writes snapshot.
 *     All three layers run.
 *   Normal path (already-migrated DB): snapshot absent — schema/integrity run,
 *     invariance skips (it.skipIf).
 *
 * Layers:
 *   1. Schema    — event_tech_req family gone, task family present;
 *                  production_id NOT NULL / event_id nullable SET NULL /
 *                  start_time+end_time; schedule_item_id dropped;
 *                  task_dependency exists（task_milestone 已由后续 phase 迁移退役）
 *   2. Integrity — no orphan production_id / join rows; no 'tech_req' or
 *                  'event_tech_req' vocabulary residue in grants tables
 *   3. Invariance — production_id backfilled from the original event;
 *                  assignee/item links survive the rename; dead 'tech_req'
 *                  managing row folded to 'task'; asset mount value rewritten
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  TASK_STANDALONE_SNAPSHOT_PATH,
  type TaskStandaloneSnapshot,
} from "./task-standalone-snapshot";

let snapshot: TaskStandaloneSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(TASK_STANDALONE_SNAPSHOT_PATH, "utf8"),
  ) as TaskStandaloneSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("event_tech_req family is gone; task family exists", async () => {
    const { rows: gone } = await getPool().query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('event_tech_req', 'event_tech_req_item', 'event_tech_assignee')
    `);
    expect(gone).toHaveLength(0);
    // task_milestone 后来被 migrate-drop-task-milestone.sql 退役（task 换轨挂 phase），
    // 不再断言它存在——那属于 drop-task-milestone.migration.test.ts 的管辖。
    const { rows: present } = await getPool().query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('task', 'task_schedule_item', 'task_assignee',
                           'task_dependency')
    `);
    expect(present).toHaveLength(4);
  });

  it("task.production_id is TEXT NOT NULL; event_id nullable", async () => {
    const { rows } = await getPool().query<{
      column_name: string; data_type: string; is_nullable: string;
    }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'task' AND column_name IN ('production_id', 'event_id')
      ORDER BY column_name
    `);
    expect(rows).toHaveLength(2);
    const eventId = rows.find(r => r.column_name === "event_id")!;
    const productionId = rows.find(r => r.column_name === "production_id")!;
    expect(productionId.data_type).toBe("text");
    expect(productionId.is_nullable).toBe("NO");
    expect(eventId.is_nullable).toBe("YES");
  });

  it("task.event_id FK is ON DELETE SET NULL; production_id FK CASCADE", async () => {
    const { rows } = await getPool().query<{ conname: string; confdeltype: string }>(`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'task'::regclass AND contype = 'f'
        AND conname IN ('task_event_id_fkey', 'task_production_id_fkey')
    `);
    expect(rows).toHaveLength(2);
    // confdeltype: 'n' = SET NULL, 'c' = CASCADE
    expect(rows.find(r => r.conname === "task_event_id_fkey")!.confdeltype).toBe("n");
    expect(rows.find(r => r.conname === "task_production_id_fkey")!.confdeltype).toBe("c");
  });

  it("task has nullable start_time/end_time; schedule_item_id is dropped", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'task'
        AND column_name IN ('start_time', 'end_time', 'schedule_item_id')
    `);
    expect(rows.map(r => r.column_name).sort()).toEqual(["end_time", "start_time"]);
    for (const r of rows) expect(r.is_nullable).toBe("YES");
  });

  it("join tables use task_id column (req_id gone)", async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('task_schedule_item', 'task_assignee')
        AND column_name IN ('task_id', 'req_id')
      ORDER BY table_name
    `);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.column_name).toBe("task_id");
  });

  it("task_dependency forbids self-reference", async () => {
    await expect(
      getPool().query(
        `INSERT INTO task_dependency (blocking_id, blocked_id) VALUES ('x-self', 'x-self')`,
      ),
    ).rejects.toThrow(/task_dependency_no_self_check|violates check constraint/);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("every task.production_id points at an existing production", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM task t
      WHERE NOT EXISTS (SELECT 1 FROM production p WHERE p.id = t.production_id)
      LIMIT 5
    `);
    expect(rows).toHaveLength(0);
  });

  it("every bound task's event belongs to the same production", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM task t
      JOIN production_event pe ON pe.id = t.event_id
      WHERE pe.production_id <> t.production_id
      LIMIT 5
    `);
    expect(rows).toHaveLength(0);
  });

  it("no 'tech_req' / 'event_tech_req' vocabulary residue in grant tables", async () => {
    for (const [table, column] of [
      ["production_member_grant", "resource_type"],
      ["resource_dept_manage", "resource_type"],
      ["resource_person_manage", "resource_type"],
      ["node_mount", "mount_type"],  // #420 后表名终态
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE ${column} IN ('tech_req', 'event_tech_req') LIMIT 1`,
      );
      expect(rows, `${table}.${column} 不应残留旧词汇`).toHaveLength(0);
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("production_id backfilled from the original event; fields preserved", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{
      production_id: string; event_id: string; title: string; description: string;
      status: string; created_via: string; department_id: string;
      start_time: Date | null; end_time: Date | null;
    }>(
      `SELECT production_id, event_id, title, description, status, created_via,
              department_id, start_time, end_time
       FROM task WHERE id = $1`,
      [s.explicitReqId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].production_id).toBe(s.prodId);
    expect(rows[0].event_id).toBe(s.eventId);
    expect(rows[0].title).toBe("task迁移显式需求");
    expect(rows[0].description).toBe("迁移前描述");
    expect(rows[0].status).toBe("in_progress");
    expect(rows[0].created_via).toBe("explicit");
    expect(rows[0].department_id).toBe(s.deptId);
    // 迁移不发明自身时间——回落链是读侧行为
    expect(rows[0].start_time).toBeNull();
    expect(rows[0].end_time).toBeNull();
  });

  it.skipIf(!snapshot)("dept_auto awaiting row survives with backfilled production_id", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ production_id: string; status: string; created_via: string }>(
      `SELECT production_id, status, created_via FROM task WHERE id = $1`,
      [s.deptAutoReqId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].production_id).toBe(s.prodId);
    expect(rows[0].status).toBe("awaiting");
    expect(rows[0].created_via).toBe("dept_auto");
  });

  it.skipIf(!snapshot)("assignee and schedule-item links survive the rename", async () => {
    const s = snapshot!;
    const { rows: assignees } = await getPool().query<{ user_id: string; name: string }>(
      `SELECT user_id, name FROM task_assignee WHERE task_id = $1`,
      [s.explicitReqId],
    );
    expect(assignees).toHaveLength(1);
    expect(assignees[0].user_id).toBe(s.userId);
    expect(assignees[0].name).toBe("task迁移指派人");

    const { rows: items } = await getPool().query<{ item_id: string }>(
      `SELECT item_id FROM task_schedule_item WHERE task_id = $1`,
      [s.explicitReqId],
    );
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBe(s.scheduleItemId);
  });

  it.skipIf(!snapshot)("dead 'tech_req' managing row folded into 'task'", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ resource_type: string }>(
      `SELECT resource_type FROM resource_dept_manage
       WHERE production_id = $1 AND dept_id = $2 AND resource_id = $3`,
      [s.prodId, s.deptId, s.explicitReqId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_type).toBe("task");
  });

  it.skipIf(!snapshot)("asset mount_type rewritten event_tech_req → task", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ mount_type: string; mount_id: string }>(
      `SELECT mount_type, mount_id FROM node_mount WHERE id = $1`, // #420 后表名终态
      [s.assetMountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mount_type).toBe("task");
    expect(rows[0].mount_id).toBe(s.explicitReqId);
  });

  it.skipIf(!snapshot)("deleting the bound event detaches (SET NULL), not deletes", async () => {
    const s = snapshot!;
    await getPool().query(`DELETE FROM production_event WHERE id = $1`, [s.eventId]);
    const { rows } = await getPool().query<{ event_id: string | null }>(
      `SELECT event_id FROM task WHERE id = $1`,
      [s.explicitReqId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBeNull();
    // schedule item 随 event 级联消失 → 绑定边随 item 级联清空
    const { rows: items } = await getPool().query(
      `SELECT 1 FROM task_schedule_item WHERE task_id = $1`,
      [s.explicitReqId],
    );
    expect(items).toHaveLength(0);
  });
});
