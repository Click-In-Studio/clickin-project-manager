/**
 * Pre-migration snapshot for migrate-drop-task-milestone invariance tests.
 *
 * isMigrationNeeded: 旧 task_milestone 表仍存在（已迁移库中它已被 DROP）。
 * createPreMigrationData: 裸 SQL 造存量形态——task + milestone + task_milestone 边，
 *   外加 phase / task_phase / phase_milestone 各一行（add-phase.sql 先于本迁移应用，
 *   工厂时已存在）——验证 DROP 只带走边表，周边实体与新边一根毫毛不少。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const DROP_TASK_MILESTONE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "drop-task-milestone-migration-snapshot.json",
);

export type DropTaskMilestoneSnapshot = {
  prodId: string;
  taskId: string;
  milestoneId: string;
  phaseId: string;
};

export async function isDropTaskMilestonePreMigrationSchema(pool: Pool): Promise<boolean> {
  const tbl = await pool.query(`SELECT to_regclass('public.task_milestone') AS t`);
  return tbl.rows[0]?.t != null;
}

export async function createDropTaskMilestonePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<DropTaskMilestoneSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);

  const taskId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query(
    "INSERT INTO task (id, production_id, title, description) VALUES ($1, $2, $3, '')",
    [taskId, prodId, "迁移工厂任务"],
  );

  const milestoneId = `ms${faker.string.alphanumeric(6).toLowerCase()}`;
  await pool.query(
    "INSERT INTO milestone (id, production_id, name, end_date) VALUES ($1, $2, '迁移工厂里程碑', '2027-01-01')",
    [milestoneId, prodId],
  );
  await pool.query(
    "INSERT INTO task_milestone (task_id, milestone_id) VALUES ($1, $2)",
    [taskId, milestoneId],
  );

  const phaseId = `ph${faker.string.alphanumeric(6).toLowerCase()}`;
  await pool.query(
    "INSERT INTO phase (id, production_id, name, start_date, end_date) VALUES ($1, $2, '迁移工厂阶段', '2026-09-01', NULL)",
    [phaseId, prodId],
  );
  await pool.query(
    "INSERT INTO task_phase (task_id, phase_id) VALUES ($1, $2)",
    [taskId, phaseId],
  );
  await pool.query(
    "INSERT INTO phase_milestone (phase_id, milestone_id) VALUES ($1, $2)",
    [phaseId, milestoneId],
  );

  return { prodId, taskId, milestoneId, phaseId };
}
