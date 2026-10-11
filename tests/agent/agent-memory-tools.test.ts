import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getPool } from "@/lib/pg";
import { buildTools, exposedName, type RunHandle } from "@/lib/agent/runtime/tools";
import { tieredToolNames } from "@/lib/agent/runtime/tool-tiers";
import { TOOL_CATALOG } from "@/lib/agent/tools/tool-catalog";
import { TOOL_LABELS } from "@/lib/agent/agent-tool-labels";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { shortId, makeProduction, cleanupProduction } from "../_support/factories";
import { readMemoryScope, mutateMemoryEntry } from "@/lib/agent/memory/memory-db";
import { appendRunRecord } from "@/lib/agent/memory/store";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
let uid: string;
let session: string;
let oldRun: string;
beforeAll(async () => {
  uid = (await upsertFeishuUser(`memory-tools-${shortId()}`, "工具记忆用户", null, false)).userId;
  session = createNewSessionKey(uid);
  await PgSessionStorage.create({ id: session, userId: uid, productionId: null });
  oldRun = `memory_run_${shortId()}`;
  await getPool().query("INSERT INTO agent_run(id,session_id,status,started_at) VALUES($1,$2,'running',now()-interval '1 minute')", [oldRun, session]);
});
afterAll(async () => {
  await getPool().query("DELETE FROM agent_session WHERE user_id=$1", [uid]);
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [uid]);
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id=$1", [uid]);
});
function tools(runId: string) {
  const run = { runId, sessionId: session, signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false } as RunHandle;
  return buildTools({ userId: uid, productionId: null, run });
}
describe("记忆工具实际接线与审计", () => {
  it("注册表、目录、显示名和审计域齐备，写默认需要确认且无人值守deny", () => {
    const all = tools(oldRun);
    for (const name of ["my.memory_read", "my.memory_write"]) {
      expect(all.some(t => t.name === exposedName(name))).toBe(true);
      expect(TOOL_CATALOG.some(t => t.name === name)).toBe(true);
      expect(TOOL_LABELS[name.replace(/\./g, "-")]).toBeTruthy();
    }
    const write = all.find(t => t.name === exposedName("my.memory_write"))!;
    expect(write).toMatchObject({ readOnly: false, unattended: "deny" });
    expect(write.selfScribe).toBeUndefined();
    const tier = tieredToolNames({ hasProduction: true, pageKey: null, prompt: null,
      recalled: ["my.memory_write"], available: ["my.memory_read", "my.memory_write"] });
    expect(tier.active).toEqual(expect.arrayContaining(["my.memory_read", "my.memory_write"]));
    expect(readFileSync("lib/agent/runtime/tools.ts", "utf8")).toContain("...MEMORY_DEFS");
    expect(readFileSync("lib/agent/memory/inject.ts", "utf8")).not.toContain("triggerRecall");
  });
  it("写入只标为active，产生mutation正文计数；旧run被用户删除边界挡住，新run可写", async () => {
    const callId = `memory_call_${shortId()}`;
    const write = tools(oldRun).find(t => t.name === exposedName("my.memory_write"))!;
    await write.execute(callId, { scope: "general", body: "先给结论", userEdited: true, source: "verified" }, new AbortController().signal);
    let entry = (await readMemoryScope(uid, null)).entries[0];
    expect(entry).toMatchObject({ source: "active", userEdited: false });
    const audit = (await getPool().query("SELECT scope,after,changes FROM agent_mutation WHERE tool_call_id=$1 AND user_id=$2", [callId, uid])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].scope).toBe("memory");
    expect(audit[0].after).not.toHaveProperty("body");
    await write.execute(`updated_${shortId()}`, { scope: "general", id: entry.id, revision: entry.revision, body: "先给结论再说明事实来源" }, new AbortController().signal);
    entry = (await readMemoryScope(uid, null)).entries[0];
    expect(entry).toMatchObject({ body: "先给结论再说明事实来源", source: "active", userEdited: false, revision: 1 });
    await mutateMemoryEntry(uid, null, { action: "delete", id: entry.id, revision: entry.revision, actor: "user" });
    await expect(write.execute(`denied_${shortId()}`, { scope: "general", body: "从旧上下文再记一次" }, new AbortController().signal)).rejects.toThrow(/旧会话/);
    await appendRunRecord(uid, { runId: oldRun, ts: new Date().toISOString(), lastUser: "旧会话晚完成" });
    expect((await getPool().query("SELECT id FROM agent_memory_chunk WHERE scope_id=$1", [uid])).rows).toHaveLength(0);
    await getPool().query("UPDATE agent_run SET status='completed' WHERE id=$1", [oldRun]);
    const resumed = `memory_run_${shortId()}`;
    await getPool().query("INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')", [resumed, session]);
    await expect(tools(resumed).find(t => t.name === exposedName("my.memory_write"))!.execute(`resumed_${shortId()}`, { scope: "general", body: "原会话恢复的旧要求" }, new AbortController().signal)).rejects.toThrow(/旧会话/);
    await appendRunRecord(uid, { runId: resumed, ts: new Date().toISOString(), lastUser: "原会话旧历史续写" });
    expect((await getPool().query("SELECT id FROM agent_memory_chunk WHERE scope_id=$1", [uid])).rows).toHaveLength(0);
    session = createNewSessionKey(uid);
    await PgSessionStorage.create({ id: session, userId: uid, productionId: null });
    const newRun = `memory_run_${shortId()}`;
    await getPool().query("INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')", [newRun, session]);
    await tools(newRun).find(t => t.name === exposedName("my.memory_write"))!.execute(`new_${shortId()}`, { scope: "general", body: "新对话重新表达" }, new AbortController().signal);
    expect((await readMemoryScope(uid, null)).entries[0].body).toBe("新对话重新表达");
  });
  it("旧项目会话不能改写通用记忆绕过项目截断", async () => {
    const { prodId } = await makeProduction(uid);
    const key = createNewSessionKey(uid, prodId);
    await PgSessionStorage.create({ id: key, userId: uid, productionId: prodId });
    const runId = `memory_project_run_${shortId()}`;
    await getPool().query("INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')", [runId, key]);
    try {
      const id = await mutateMemoryEntry(uid, prodId, { action: "create", body: "项目旧要求", actor: "user" });
      await mutateMemoryEntry(uid, prodId, { action: "delete", id, revision: 0, actor: "user" });
      const run = { runId, sessionId: key, signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false } as RunHandle;
      const write = buildTools({ userId: uid, productionId: prodId, run }).find(t => t.name === exposedName("my.memory_write"))!;
      await expect(write.execute(`bypass_${shortId()}`, { scope: "general", body: "旧要求转成通用" }, run.signal)).rejects.toThrow(/旧会话/);
    } finally { await cleanupProduction(prodId).catch(() => {}); }
  });

});
