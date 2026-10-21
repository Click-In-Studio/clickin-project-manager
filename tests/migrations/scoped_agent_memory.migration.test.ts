import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type MemorySnapshot } from "./scoped_agent_memory.snapshot";
let snapshot: MemorySnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")); } catch { snapshot = null; }
describe("schema verification", () => {
  it("作用域和条目只有两张新表，历史序号与可信范围落在原索引", async () => {
    const cols = await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_name='agent_memory_chunk' AND column_name=ANY($1::text[])", [["production_id", "history_seq", "scope_known"]]);
    expect(cols.rows).toHaveLength(3);
    const tables = await getPool().query("SELECT table_name FROM information_schema.tables WHERE table_name=ANY($1::text[])", [["agent_memory_scope", "agent_memory_entry"]]);
    expect(tables.rows).toHaveLength(2);
  });
});
describe("integrity verification", () => {
  it("条目必须归属真实范围，不能写模型声称的来源类型", async () => {
    await expect(getPool().query("INSERT INTO agent_memory_entry(id,scope_id,source,body,brief,deleted_at) VALUES('bad-memory','missing','active','正文','正文',now())")).rejects.toThrow(/foreign key/);
    await expect(getPool().query("INSERT INTO agent_memory_entry(id,scope_id,source,body,brief,deleted_at) VALUES('bad-source','missing','verified','正文','正文',now())")).rejects.toThrow(/check constraint/);
  });
});
describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧混合摘要退出，历史文本原样保留且未验证范围不得暴露", async () => {
    const rows = await getPool().query("SELECT id,text,scope_known,production_id,history_seq FROM agent_memory_chunk WHERE id=ANY($1::uuid[])", [[snapshot!.curatedId, snapshot!.historyId]]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: snapshot!.historyId, text: snapshot!.historyText, scope_known: false, production_id: null });
    expect(Number(rows.rows[0].history_seq)).toBeGreaterThan(0);
  });
});
