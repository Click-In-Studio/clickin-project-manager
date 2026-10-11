// 历史检索索引：切词纯函数 + 索引写入幂等 + 混合检索排序
// 与 scope 隔离 + fail-closed 语义。
//
// embedding 走 EMBEDDING_PROVIDER=fake（决定性 hash 向量，零网络）：同文本
// 恒同向量→可验证「原文查询向量命中」；不同文本近似正交→不承诺语义相似。
// 语义相似度本身不在测试范围（那是模型的事），测的是管线与公式。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { shortId } from "../_support/factories";
import { mutateMemoryEntry } from "@/lib/agent/memory/memory-db";
import { getPool } from "@/lib/pg";
import {
  bigramTokens,
  ensureIndexIdentity,
  episodicText,
  indexEpisodicRun,
  embedMissing,
} from "@/lib/agent/memory/index-db";
import { searchMemory, MemoryUnavailableError, MIN_SCORE } from "@/lib/agent/memory/search";
import { embeddingModel } from "@/lib/agent/memory/embedding";

let userA: string;
let userB: string;

async function cleanup() {
  const pool = getPool();
  await pool.query("DELETE FROM agent_memory_chunk WHERE scope_id = ANY($1)", [[userA, userB]]);
  await pool.query("DELETE FROM agent_memory_scope WHERE user_id=ANY($1)", [[userA, userB]]);
  await pool.query("DELETE FROM ai_usage WHERE user_id = ANY($1)", [[userA, userB]]);
}

beforeAll(async () => {
  process.env.EMBEDDING_PROVIDER = "fake";
  userA = (await upsertFeishuUser(`memory-index-${shortId()}`, "索引甲", null, false)).userId;
  userB = (await upsertFeishuUser(`memory-index-${shortId()}`, "索引乙", null, false)).userId;
});

afterAll(async () => {
  await cleanup();
  delete process.env.EMBEDDING_PROVIDER;
});

// ── 纯函数 ───────────────────────────────────────────────────────────────────

describe("bigramTokens", () => {
  it("中文切 bigram、ASCII 整词小写", () => {
    expect(bigramTokens("和张三确认 Cue38")).toEqual(["和张", "张三", "三确", "确认", "cue38"]);
  });
  it("单字 CJK run 保留、纯符号为空", () => {
    expect(bigramTokens("灯")).toEqual(["灯"]);
    expect(bigramTokens("！？——")).toEqual([]);
  });
});

describe("episodicText", () => {
  it("收到的问答全文入索引", () => {
    const long = "长".repeat(500);
    const t = episodicText({ ts: "2026-08-20T10:00:00Z", lastUser: long, lastAssistant: "回" });
    expect(t).toContain(long);
  });
  it("双空返回 null", () => {
    expect(episodicText({ ts: "2026-08-20T10:00:00Z" })).toBeNull();
  });
});

// ── 索引写入 ─────────────────────────────────────────────────────────────────

describe("index writes", () => {
  it("episodic 同内容幂等（UNIQUE + DO NOTHING）", async () => {
    // ts 必须相对当前时间：searchMemory 对 episodic 按 observed_at 做 30 天半衰
    // 期衰减，硬编码日期会随真实时间流逝跌破 MIN_SCORE（2026-09-08 CI 红过一次：
    // 硬编码 08-19 在 20 天龄时衰减 ×0.63，向量分临界的查询刚好过不了线）。
    const rec = { ts: new Date(Date.now() - 86_400_000).toISOString(), lastUser: "明天排练几点开始", lastAssistant: "下午三点在排练厅" };
    await indexEpisodicRun(userA, rec);
    await indexEpisodicRun(userA, rec);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM agent_memory_chunk WHERE scope_id = $1 AND source = 'episodic'",
      [userA],
    );
    expect(rows[0].n).toBe(1);
  });

  it("episodic 携带 provenance 列与 embedding", async () => {
    const { rows } = await getPool().query(
      "SELECT origin_class, session_kind, model, embedding IS NOT NULL AS embedded, text_tokens FROM agent_memory_chunk WHERE scope_id = $1 AND source = 'episodic'",
      [userA],
    );
    expect(rows[0].origin_class).toBe("owner");
    expect(rows[0].session_kind).toBe("interactive");
    await embedMissing();
    const embedded = await getPool().query("SELECT model FROM agent_memory_chunk WHERE scope_id=$1", [userA]);
    expect(embedded.rows[0].model).toBe(embeddingModel());
    expect(rows[0].text_tokens).toContain("排练");
  });

  it("主动条目只存一份，不产生 curated 索引", async () => {
    await mutateMemoryEntry(userB, null, { action: "create", actor: "user", body: "网关 loopback 配置" });
    expect((await getPool().query("SELECT id FROM agent_memory_chunk WHERE scope_id=$1 AND source='curated'", [userB])).rows).toHaveLength(0);
  });
});

// ── 检索 ─────────────────────────────────────────────────────────────────────

describe("searchMemory", () => {
  it("原文查询经向量车道命中（fake：同文本恒同向量）", async () => {
    const { hits } = await searchMemory(userA, "明天排练几点开始");
    // 查询文本 ≠ chunk 全文（chunk 是 [时间]\n用户：…\n助手：… 包装），向量分
    // 不是 1；但关键词占比=1（查询 bigram 全命中）足以过线
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("排练厅");
  });

  it("scope 隔离：B 的查询看不到 A 的记忆", async () => {
    const { hits } = await searchMemory(userB, "明天排练几点开始");
    expect(hits.every((h) => !h.text.includes("排练厅"))).toBe(true);
  });

  it("当前条目通过关键词检索，不依赖模型评分", async () => {
    const { hits } = await searchMemory(userB, "网关 loopback 配置");
    expect(hits.length).toBeGreaterThan(0);
    // importance=9 → 乘子 1.2；关键词强命中 × 1.2 应显著高于 MIN_SCORE
    expect(hits[0].score).toBeGreaterThan(MIN_SCORE);
  });

  it("不相关查询过不了 minScore", async () => {
    const { hits } = await searchMemory(userB, "完全无关的火星话题内容");
    expect(hits).toHaveLength(0);
  });

  it("命中写入召回记账", async () => {
    const before = await getPool().query(
      "SELECT count(*)::int AS n FROM agent_memory_recall_log WHERE user_id = $1", [userA],
    );
    await searchMemory(userA, "明天排练几点开始");
    // 记账是 fire-and-forget，轮询等它落库（固定 200ms 在 CI 负载高时会漏，#490 撞过）
    let n = before.rows[0].n;
    for (let i = 0; i < 25 && n <= before.rows[0].n; i++) {
      await new Promise((r) => setTimeout(r, 100));
      n = (await getPool().query(
        "SELECT count(*)::int AS n FROM agent_memory_recall_log WHERE user_id = $1", [userA],
      )).rows[0].n;
    }
    expect(n).toBeGreaterThan(before.rows[0].n);
  });
});

// ── 降级与 fail-closed ──────────────────────────────────────────────────────

describe("degradation semantics", () => {
  beforeEach(() => {
    process.env.EMBEDDING_PROVIDER = "fake";
  });

  it("EMBEDDING_PROVIDER=none → 合法纯关键词模式（带附注）", async () => {
    process.env.EMBEDDING_PROVIDER = "none";
    const result = await searchMemory(userA, "排练厅");
    expect(result.note).toContain("纯关键词");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("显式 dashscope 但无 key → fail-closed 抛 MemoryUnavailableError", async () => {
    process.env.EMBEDDING_PROVIDER = "dashscope";
    delete process.env.EMBEDDING_API_KEY;
    await expect(searchMemory(userA, "排练厅")).rejects.toThrow(MemoryUnavailableError);
  });

  it("索引身份不符 → 向量车道暂停、关键词继续（带附注）", async () => {
    const pool = getPool();
    const { rows } = await pool.query("SELECT model FROM agent_memory_index_meta WHERE id = 1");
    expect(rows).toHaveLength(1);
    try {
      await pool.query("UPDATE agent_memory_index_meta SET model = 'other-model' WHERE id = 1");
      expect(await ensureIndexIdentity()).toBe(false);
      const result = await searchMemory(userA, "排练厅");
      expect(result.note).toContain("向量车道暂停");
      expect(result.hits.length).toBeGreaterThan(0);
    } finally {
      await pool.query("UPDATE agent_memory_index_meta SET model = $1 WHERE id = 1", [rows[0].model]);
    }
  });
});
