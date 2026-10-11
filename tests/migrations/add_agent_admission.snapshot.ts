import path from "node:path";
import type { Pool } from "pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { newSessionId, newRunId, newScheduleId } from "@/lib/agent/runtime/ids";
import type { MigrationHookContext } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.resolve("node_modules/.cache/add-agent-admission-snapshot.json");
export type Snapshot = { prodId: string; rows: Array<Record<string, unknown>> };
export async function createPreMigrationData({ pool, testOwner }: MigrationHookContext): Promise<Snapshot> {
  const { prodId } = await makeProduction(testOwner);
  const schedule = newScheduleId();
  await pool.query("INSERT INTO agent_schedule(id,user_id,production_id,name,prompt,schedule) VALUES($1,$2,$3,'迁移任务','检查','{}')", [schedule, testOwner, prodId]);
  const root = newSessionId();
  await pool.query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [root, testOwner, prodId]);
  const rootRun = newRunId();
  await pool.query("INSERT INTO agent_run(id,session_id,status,initial_message) VALUES($1,$2,'completed','迁移前输入')", [rootRun, root]);
  const child = newSessionId();
  await pool.query("INSERT INTO agent_session(id,user_id,production_id,parent_session_id) VALUES($1,$2,$3,$4)", [child, testOwner, prodId, root]);
  await pool.query("INSERT INTO agent_subagent(id,task) VALUES($1,'迁移前子任务')", [child]);
  const ids = [rootRun, newRunId(), newRunId()];
  await pool.query("INSERT INTO agent_run(id,session_id,status,subagent_id,budget_run_id) VALUES($1,$2,'completed',$2,$3)", [ids[1], child, rootRun]);
  const scheduledSession = newSessionId();
  await pool.query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [scheduledSession, testOwner, prodId]);
  await pool.query("INSERT INTO agent_run(id,session_id,status,schedule_id) VALUES($1,$2,'completed',$3)", [ids[2], scheduledSession, schedule]);
  await pool.query("UPDATE agent_run SET notification_delivered=true WHERE id=ANY($1::text[])", [ids]);
  const rows = (await pool.query("SELECT to_jsonb(r) AS row FROM agent_run r WHERE id=ANY($1::text[]) ORDER BY id", [ids])).rows.map((r) => r.row);
  return { prodId, rows };
}
export async function cleanup(_pool: Pool, snapshot: Snapshot): Promise<void> { await cleanupProduction(snapshot.prodId).catch(() => {}); }
