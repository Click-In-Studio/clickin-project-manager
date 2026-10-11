import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";
export const SNAPSHOT_PATH = path.join(os.tmpdir(), "scoped-agent-memory-snapshot.json");
export type MemorySnapshot = { userId: string; curatedId: string; historyId: string; historyText: string };
export const createPreMigrationData: MigrationHook<MemorySnapshot>["createPreMigrationData"] = async ({ pool, testOwner, faker }) => {
  const text = `旧历史-${faker.string.alphanumeric(12)}`;
  const curated = await pool.query<{ id: string }>(
    "INSERT INTO agent_memory_chunk(scope_type,scope_id,source,text,text_tokens,content_hash,origin_class,session_kind,observed_at) VALUES('user',$1,'curated','旧混合偏好','旧混合 偏好',$2,'owner','interactive',now()) RETURNING id", [testOwner, faker.string.alphanumeric(64)]);
  const history = await pool.query<{ id: string }>(
    "INSERT INTO agent_memory_chunk(scope_type,scope_id,source,text,text_tokens,content_hash,origin_class,session_kind,observed_at) VALUES('user',$1,'episodic',$2,$2,$3,'owner','interactive',now()) RETURNING id", [testOwner, text, faker.string.alphanumeric(64)]);
  return { userId: testOwner, curatedId: curated.rows[0].id, historyId: history.rows[0].id, historyText: text };
};
export const cleanup: MigrationHook<MemorySnapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query("DELETE FROM agent_memory_chunk WHERE id=ANY($1::uuid[])", [[snapshot.curatedId, snapshot.historyId]]);
};
