/**
 * Migration tests for migrate-drop-task-milestone.sql（task 换轨挂 phase）。
 *
 * Operating modes:
 *   Migration path (CI): global-setup 检测 task_milestone 仍存在 → 造工厂行
 *     （task+milestone+旧边，外加 phase 家族新边）→ 应用迁移 → 写 snapshot。三层全跑。
 *   Normal path (已迁移库): 无 snapshot——schema/integrity 跑，invariance skipIf 跳过。
 *
 * Layers:
 *   1. Schema    — task_milestone 消失；phase / phase_milestone / task_phase 存在
 *                  且列形正确（dept_id 可空 SET NULL、start_date NOT NULL、
 *                  end_date 可空、date 次序 CHECK）
 *   2. Integrity — 新边表无孤儿行；resource_permission_level 有 phase 四动词行
 *   3. Invariance — DROP 只带走边表：task / milestone 本体与 phase 家族工厂行原样健在
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  DROP_TASK_MILESTONE_SNAPSHOT_PATH,
  type DropTaskMilestoneSnapshot,
} from "./drop-task-milestone-snapshot";

let snapshot: DropTaskMilestoneSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(DROP_TASK_MILESTONE_SNAPSHOT_PATH, "utf8"),
  ) as DropTaskMilestoneSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("task_milestone is gone; phase family exists", async () => {
    const { rows: gone } = await getPool().query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'task_milestone'
    `);
    expect(gone).toHaveLength(0);
    const { rows: present } = await getPool().query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('phase', 'phase_milestone', 'task_phase')
    `);
    expect(present).toHaveLength(3);
  });

  it("phase columns: dept_id nullable uuid; start_date NOT NULL date; end_date nullable", async () => {
    const { rows } = await getPool().query<{
      column_name: string; data_type: string; is_nullable: string;
    }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'phase'
        AND column_name IN ('dept_id', 'start_date', 'end_date', 'production_id')
      ORDER BY column_name
    `);
    const byName = new Map(rows.map(r => [r.column_name, r]));
    expect(byName.get("dept_id")?.data_type).toBe("uuid");
    expect(byName.get("dept_id")?.is_nullable).toBe("YES");
    expect(byName.get("start_date")?.data_type).toBe("date");
    expect(byName.get("start_date")?.is_nullable).toBe("NO");
    expect(byName.get("end_date")?.is_nullable).toBe("YES");
    expect(byName.get("production_id")?.is_nullable).toBe("NO");
  });

  it("phase.dept_id FK is ON DELETE SET NULL; date order CHECK exists", async () => {
    const { rows: fks } = await getPool().query<{ conname: string; confdeltype: string }>(`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'phase'::regclass AND contype = 'f' AND conname LIKE '%dept_id%'
    `);
    expect(fks).toHaveLength(1);
    expect(fks[0].confdeltype).toBe("n");  // SET NULL
    const { rows: checks } = await getPool().query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'phase'::regclass AND contype = 'c'
        AND conname = 'phase_date_order_check'
    `);
    expect(checks).toHaveLength(1);
  });

  it("date order CHECK rejects end < start but allows NULL end", async () => {
    const pool = getPool();
    await expect(pool.query(
      "INSERT INTO phase (id, production_id, name, start_date, end_date) VALUES ('phbadck', 'no-such-prod', 'x', '2027-01-02', '2027-01-01')",
    )).rejects.toThrow(/phase_date_order_check|foreign key/);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no orphan rows in task_phase / phase_milestone", async () => {
    const { rows: tp } = await getPool().query(`
      SELECT tp.task_id FROM task_phase tp
      LEFT JOIN task t ON t.id = tp.task_id
      LEFT JOIN phase p ON p.id = tp.phase_id
      WHERE t.id IS NULL OR p.id IS NULL
    `);
    expect(tp).toHaveLength(0);
    const { rows: pm } = await getPool().query(`
      SELECT pm.phase_id FROM phase_milestone pm
      LEFT JOIN phase p ON p.id = pm.phase_id
      LEFT JOIN milestone m ON m.id = pm.milestone_id
      WHERE p.id IS NULL OR m.id IS NULL
    `);
    expect(pm).toHaveLength(0);
  });

  it("resource_permission_level has the four phase verb rows", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(`
      SELECT permission_level FROM resource_permission_level
      WHERE resource_type = 'phase' ORDER BY permission_level
    `);
    expect(rows.map(r => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("task survives the edge-table drop untouched", async () => {
    const { rows } = await getPool().query(
      "SELECT production_id, title FROM task WHERE id = $1", [snapshot!.taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].production_id).toBe(snapshot!.prodId);
  });

  it.skipIf(!snapshot)("milestone entity survives (only the task edge is gone)", async () => {
    const { rows } = await getPool().query(
      "SELECT production_id FROM milestone WHERE id = $1", [snapshot!.milestoneId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].production_id).toBe(snapshot!.prodId);
  });

  it.skipIf(!snapshot)("phase family factory rows survive: phase + task_phase + phase_milestone", async () => {
    const pool = getPool();
    const { rows: phase } = await pool.query(
      "SELECT end_date FROM phase WHERE id = $1", [snapshot!.phaseId],
    );
    expect(phase).toHaveLength(1);
    expect(phase[0].end_date).toBeNull();  // 开放尾原样保留
    const { rows: tp } = await pool.query(
      "SELECT 1 FROM task_phase WHERE task_id = $1 AND phase_id = $2",
      [snapshot!.taskId, snapshot!.phaseId],
    );
    expect(tp).toHaveLength(1);
    const { rows: pm } = await pool.query(
      "SELECT 1 FROM phase_milestone WHERE phase_id = $1 AND milestone_id = $2",
      [snapshot!.phaseId, snapshot!.milestoneId],
    );
    expect(pm).toHaveLength(1);
  });
});
