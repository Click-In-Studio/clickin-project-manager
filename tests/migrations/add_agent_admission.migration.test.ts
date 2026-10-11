import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { SNAPSHOT_PATH, type Snapshot } from "./add_agent_admission.snapshot";
import { newRunId, newSessionId } from "@/lib/agent/runtime/ids";
const snapshot: Snapshot | null = existsSync(SNAPSHOT_PATH) ? JSON.parse(readFileSync(SNAPSHOT_PATH,"utf8")) : null;
let prodId: string;
let runId: string;
beforeAll(async () => {
  const userId=(await upsertFeishuUser(`admission-migration-${newRunId()}`,"迁移测试",null,false)).userId;
  const prod = await makeProduction(userId); prodId = prod.prodId;
  const session = newSessionId(); runId = newRunId();
  await getPool().query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [session, userId, prodId]);
  await getPool().query("INSERT INTO agent_run(id,session_id) VALUES($1,$2)", [runId,session]);
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
describe("统一资源准入迁移", () => {
  it("schema 与操作完整性：资源/状态受限、操作幂等键唯一、删除 run 级联", async () => {
    const id = newRunId();
    await getPool().query("INSERT INTO agent_admission(id,run_id,operation_key,resource) VALUES($1,$2,'one','llm')", [id,runId]);
    await expect(getPool().query("INSERT INTO agent_admission(id,run_id,operation_key,resource) VALUES($1,$2,'one','llm')", [newRunId(),runId])).rejects.toMatchObject({ code: "23505" });
    await expect(getPool().query("UPDATE agent_admission SET resource='cpu' WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(getPool().query("UPDATE agent_admission SET state='lost' WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
    await getPool().query("DELETE FROM agent_run WHERE id=$1", [runId]);
    expect((await getPool().query("SELECT 1 FROM agent_admission WHERE id=$1", [id])).rowCount).toBe(0);
  });
  it.skipIf(!snapshot)("迁移不改变原 run 与父子关系、计费和输入；只回填来源优先级", async () => {
    for (const before of snapshot!.rows) {
      const row = (await getPool().query("SELECT to_jsonb(r) AS row FROM agent_run r WHERE id=$1", [before.id])).rows[0].row;
      expect(row.admission_class).toBe(before.subagent_id ? "subagent" : before.schedule_id ? "schedule" : "interactive");
      expect(row.execution_epoch).toBe(0); expect(row.input_wait).toBeNull();
      delete row.admission_class; delete row.execution_epoch; delete row.input_wait;
      expect(row).toEqual(before);
    }
  });
});
