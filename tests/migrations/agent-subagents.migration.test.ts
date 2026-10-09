import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  makeProduction,
  cleanupProduction,
  shortId,
} from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { newRunId } from "@/lib/agent/runtime/ids";
import { queueSubagent } from "@/lib/agent/runtime/subagent-db";
let userId: string;
let prodId: string;
beforeAll(async () => {
  ({ userId } = await upsertFeishuUser(
    `sa-migration-${shortId()}`,
    "迁移验收",
    null,
    false,
  ));
  ({ prodId } = await makeProduction(userId));
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});
describe("子 Agent schema 与完整性", () => {
  it("同一会话只能有一个活动上下文写者；排队行不占执行名额", async () => {
    const key = createNewSessionKey(userId, prodId);
    await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    await getPool().query(
      "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')",
      [newRunId(), key],
    );
    await expect(
      getPool().query(
        "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'compacting')",
        [newRunId(), key],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      getPool().query(
        "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'queued')",
        [newRunId(), key],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
  it("删除父会话级联删除子会话、轮次、轨迹与队列，父子身份保持一致", async () => {
    const key = createNewSessionKey(userId, prodId);
    await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    const run = newRunId();
    await getPool().query(
      "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')",
      [run, key],
    );
    const child = await queueSubagent({
      parentSessionId: key,
      parentRunId: run,
      task: "长材料",
      message: "研读",
    });
    const identities = await getPool().query(
      "SELECT user_id,production_id,parent_session_id FROM agent_session WHERE id=$1",
      [child],
    );
    expect(identities.rows[0]).toEqual({
      user_id: userId,
      production_id: prodId,
      parent_session_id: key,
    });
    await getPool().query("DELETE FROM agent_session WHERE id=$1", [key]);
    for (const [table, column] of [
      ["agent_session", "id"],
      ["agent_subagent", "id"],
      ["agent_run", "session_id"],
      ["agent_session_entry", "session_id"],
      ["agent_session_inbox", "session_id"],
    ]) {
      expect(
        (
          await getPool().query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [
            child,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });
});
