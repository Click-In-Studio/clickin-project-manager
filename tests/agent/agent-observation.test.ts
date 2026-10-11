import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Context, StreamFn } from "../../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { newRunId, newSessionId } from "@/lib/agent/runtime/ids";
import { admittedStream, runInAdmission } from "@/lib/agent/runtime/admission";
import { CHAT_MODEL } from "@/lib/agent/runtime/config";
import { addObservationTools, setToolObservationSources } from "@/lib/agent/runtime/observation";
import { recallFamilies, searchTools } from "@/lib/agent/runtime/tool-index";
import * as embedding from "@/lib/agent/memory/embedding";
import * as index from "@/lib/agent/memory/index-db";
import { searchMemory, MemoryUnavailableError } from "@/lib/agent/memory/search";

let userId: string, prodId: string;
beforeAll(async () => {
  userId = (await upsertFeishuUser(`observation-${newRunId()}`, "运行观测测试", null, false)).userId;
  prodId = (await makeProduction(userId)).prodId;
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
async function makeRun(): Promise<string> {
  const sessionId = newSessionId(), runId = newRunId();
  await getPool().query("INSERT INTO agent_session(id,user_id,production_id) VALUES($1,$2,$3)", [sessionId,userId,prodId]);
  await getPool().query("INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')", [runId,sessionId]);
  return runId;
}
const secret = "绝不能存入观测的用户正文";
function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id,
    timestamp: Date.now(), content: [{ type: "text", text: secret }], stopReason, errorMessage: secret,
    usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 5, totalTokens: 47,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const context = (names: string[]): Context => ({ systemPrompt: secret,
  messages: [{ role: "user", content: secret, timestamp: Date.now() }],
  tools: names.map(name => ({ name, description: secret, parameters: { type: "object", properties: {} } })) });

describe("新运行的数据库观测", () => {
  it("记录实际请求与动态工具变化、缓存用量、失败；重放完成结果不新增请求", async () => {
    const runId = await makeRun();
    let calls = 0;
    const stream: StreamFn = () => {
      const output = createAssistantMessageEventStream();
      const result = message(++calls === 1 ? "length" : "error");
      queueMicrotask(() => {
        if (result.stopReason === "error") output.push({ type: "error", reason: "error", error: result });
        else output.push({ type: "done", reason: "length", message: result });
      });
      return output;
    };
    await runInAdmission(runId, new AbortController().signal, () => {}, async () => {
      setToolObservationSources({ resident: ["hot"], page: ["page"] }, "tiered");
      await recallFamilies("查看剧本", { hasProduction: true, userId });
      for await (const event of await admittedStream(stream)(CHAT_MODEL, context(["hot", "page"]))) void event;
      for (let i = 0; i < 100; i++) {
        const row = (await getPool().query("SELECT state FROM agent_admission WHERE run_id=$1", [runId])).rows[0];
        if (row?.state === "done") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // 同一 continuation 的持久化结果重放不应当作实际模型请求。
      for await (const event of await admittedStream(stream)(CHAT_MODEL, context(["hot", "page"]))) void event;
      await getPool().query("DELETE FROM agent_admission WHERE run_id=$1", [runId]);
      await searchTools(secret, { hasProduction: false, userId });
      addObservationTools("dynamic", ["dynamic"]);
      for await (const event of await admittedStream(stream)(CHAT_MODEL, context(["hot", "dynamic"]))) void event;
    });
    const rows = (await getPool().query("SELECT data,ended_at,elapsed_ms FROM agent_observation WHERE run_id=$1 AND kind='model_request' ORDER BY started_at", [runId])).rows;
    const retrievals = (await getPool().query("SELECT id,data FROM agent_observation WHERE run_id=$1 AND kind='tool_retrieval' ORDER BY started_at", [runId])).rows;
    expect(rows[0].data.retrievalIds).toEqual([retrievals[0].id]);
    expect(rows[1].data.retrievalIds).toEqual(retrievals.map(row => row.id));
    expect(retrievals[1].data.requestId).toBeTruthy();
    expect(calls).toBe(2);
    expect(rows.map(r => r.data.tools)).toEqual([["hot", "page"], ["hot", "dynamic"]]);
    expect(rows[1].data.sources.dynamic).toEqual(["dynamic"]);
    expect(rows[0].data.usage.inputIncludingCache).toBe(45);
    expect(rows.map(r => r.data.stopReason)).toEqual(["length", "error"]);
    expect(rows.every(r => r.ended_at && r.elapsed_ms >= 0)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it("自动与显式工具检索、记忆未命中均留存；区分未配置降级", async () => {
    const runId = await makeRun();
    await runInAdmission(runId, new AbortController().signal, () => {}, async () => {
      await recallFamilies("查看剧本", { hasProduction: true, userId });
      await searchTools(secret, { hasProduction: false, userId });
      await searchMemory(userId, secret);
    });
    const rows = (await getPool().query("SELECT kind,data FROM agent_observation WHERE run_id=$1 ORDER BY started_at", [runId])).rows;
    expect(rows.map(r => [r.kind,r.data.mode])).toEqual([
      ["tool_retrieval","automatic"], ["tool_retrieval","explicit"], ["memory_retrieval","explicit"],
    ]);
    expect(rows.every(r => r.data.status === "ok" && r.data.reason === "not_configured")).toBe(true);
    expect(rows[0].data.candidateCount).toBeGreaterThan(0);
    expect(rows[0].data.stages.queryEmbedding).toBeGreaterThanOrEqual(0);
    expect(rows[2].data.returnedCount).toBe(0);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it("工具向量失败仍以词法返回，记忆向量失败留存错误而不伪造未命中", async () => {
    const runId = await makeRun();
    const mode = vi.spyOn(embedding, "embeddingMode").mockReturnValue("fake");
    const identity = vi.spyOn(index, "ensureIndexIdentity").mockResolvedValue(true);
    const query = vi.spyOn(embedding, "embedQuery").mockRejectedValue(new embedding.EmbeddingUnavailableError(secret));
    try {
      await runInAdmission(runId, new AbortController().signal, () => {}, async () => {
        await recallFamilies("查看剧本", { hasProduction: true, userId });
        await expect(searchMemory(userId, secret)).rejects.toThrow(MemoryUnavailableError);
      });
      const rows = (await getPool().query("SELECT kind,data FROM agent_observation WHERE run_id=$1 ORDER BY started_at", [runId])).rows;
      expect(rows[0].data.status).toBe("ok");
      expect(rows[0].data.reason).toBe("query_embedding_failed");
      expect(rows[1].data.status).toBe("error");
      expect(rows[1].data.reason).toBe("embedding_unavailable");
      expect(rows[1].data.returnedCount).toBeUndefined();
      expect(JSON.stringify(rows)).not.toContain(secret);
    } finally { mode.mockRestore(); identity.mockRestore(); query.mockRestore(); }
  });
  it("删除命中的记忆后仍保留候选评分与命中记录", async () => {
    const runId = await makeRun(), chunkId = randomUUID();
    await getPool().query(`INSERT INTO agent_memory_chunk(id,scope_type,scope_id,source,text,text_tokens,content_hash,origin_class,session_kind,observed_at,scope_known)
      VALUES($1::uuid,'user',$2,'episodic',$3,'独立观测样本',$1::text,'owner','interactive',now(),true)`, [chunkId,userId,secret]);
    try {
      await runInAdmission(runId, new AbortController().signal, () => {}, async () => {
        const result = await searchMemory(userId, "独立观测样本");
        expect(result.hits.map(h => h.id)).toContain(chunkId);
      });
    } finally { await getPool().query("DELETE FROM agent_memory_chunk WHERE id=$1", [chunkId]); }
    const row = (await getPool().query("SELECT data FROM agent_observation WHERE run_id=$1 AND kind='memory_retrieval'", [runId])).rows[0];
    expect(row.data.returnedIds).toContain(chunkId);
    expect(row.data.scores.some((s: { id: string }) => s.id === chunkId)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
  });
  it("接线包含主脑、子任务与压缩，记忆性能记录没有正文外键", () => {
    const migration = readFileSync("db/migrations/20261011084751_add_agent_observation.sql", "utf8");
    expect(migration).not.toMatch(/REFERENCES agent_memory_chunk/);
    const admission = readFileSync("lib/agent/runtime/admission.ts", "utf8");
    expect(admission).toContain("withObservationRun(runId");
    expect(admission).toContain('observeModelRequest(model, context, "chat"');
    for (const file of ["service", "subagents"]) {
      expect(readFileSync(`lib/agent/runtime/${file}.ts`, "utf8")).toContain("admittedStream(");
    }
    const service = readFileSync("lib/agent/runtime/service.ts", "utf8");
    expect(service).toContain("observeCompactionCheck(");
    expect(service).toContain('observeModelRequest(args[0], args[1], "compaction"');
  });
});
