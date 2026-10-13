import path from "node:path";
import { mkdirSync } from "node:fs";
import type { Pool } from "pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { newSessionId, newRunId } from "@/lib/agent/runtime/ids";
import type { MigrationHookContext } from "../_support/global-setup";
export const SNAPSHOT_PATH = path.resolve(
  "node_modules/.cache/add-agent-model-selection-snapshot.json",
);
export type Snapshot = {
  prodId: string;
  sessionId: string;
  rows: Array<Record<string, unknown>>;
};
export async function createPreMigrationData({
  pool,
  testOwner,
}: MigrationHookContext): Promise<Snapshot> {
  mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  const { prodId } = await makeProduction(testOwner);
  const sessionId = newSessionId();
  await pool.query(
    "INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)",
    [sessionId, testOwner, prodId],
  );
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    await pool.query(
      "INSERT INTO agent_run(id,session_id,status,model,initial_message) VALUES($1,$2,'completed',$3,'迁移前原文')",
      [newRunId(), sessionId, model],
    );
  }
  const rows = (
    await pool.query(
      "SELECT to_jsonb(r) AS row FROM agent_run r WHERE session_id=$1 ORDER BY id",
      [sessionId],
    )
  ).rows.map((row) => row.row);
  return { prodId, sessionId, rows };
}
export async function cleanup(_pool: Pool, snapshot: Snapshot) {
  await cleanupProduction(snapshot.prodId).catch(() => {});
}
