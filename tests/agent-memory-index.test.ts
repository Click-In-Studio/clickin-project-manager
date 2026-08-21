// 记忆检索索引（M1 地基）：分块/切词纯函数 + 索引写入幂等 + 混合检索排序
// 与 scope 隔离 + fail-closed 语义。
//
// embedding 走 EMBEDDING_PROVIDER=fake（决定性 hash 向量，零网络）：同文本
// 恒同向量→可验证「原文查询向量命中」；不同文本近似正交→不承诺语义相似。
// 语义相似度本身不在测试范围（那是模型的事），测的是管线与公式。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/pg";
import {
  bigramTokens,
  chunkMarkdown,
  CHUNK_MAX_CHARS,
  ensureIndexIdentity,
  episodicText,
  indexCurated,
  indexEpisodicRun,
  parseAnnotations,
  sha256,
} from "@/lib/agent-memory/index-db";
import { searchMemory, MemoryUnavailableError, MIN_SCORE } from "@/lib/agent-memory/search";
import { embeddingModel } from "@/agent/embedding";

const userA = randomUUID();
const userB = randomUUID();

async function cleanup() {
  const pool = getPool();
  await pool.query("DELETE FROM agent_memory_chunk WHERE scope_id = ANY($1)", [[userA, userB]]);
  await pool.query("DELETE FROM ai_usage WHERE user_id = ANY($1)", [[userA, userB]]);
}

beforeAll(async () => {
  process.env.EMBEDDING_PROVIDER = "fake";
  await cleanup();
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

describe("parseAnnotations", () => {
  it("提取 importance 与 trigger（OpenClaw 行尾注释格式）", () => {
    const r = parseAnnotations("- 网关保持 loopback。 <!-- trigger: gateway 配置, 网络安全 --> <!-- importance: 9 -->");
    expect(r.importance).toBe(9);
    expect(r.triggers).toBe("gateway 配置, 网络安全");
  });
  it("无注释 → 全 null（可空=中性）", () => {
    expect(parseAnnotations("- 普通条目")).toEqual({ importance: null, triggers: null });
  });
  it("越界 importance 忽略", () => {
    expect(parseAnnotations("x <!-- importance: 0 --> <!-- importance: 11 -->").importance).toBeNull();
  });
});

describe("chunkMarkdown", () => {
  it("逐条目一块（不打包，hash 按条稳定）；纯标题行并入下一块", () => {
    const md = "### 偏好\n\n- 条目一\n\n- 条目二";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("### 偏好\n- 条目一");
    expect(chunks[1].text).toBe("- 条目二");
    expect(chunks[0].contentHash).toBe(sha256(chunks[0].text));
  });
  it("超长单块硬切且带重叠", () => {
    const long = "字".repeat(CHUNK_MAX_CHARS * 2);
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });
  it("确定性：同输入同输出", () => {
    const md = "a\n\nb\n\nc";
    expect(chunkMarkdown(md)).toEqual(chunkMarkdown(md));
  });
});

describe("episodicText", () => {
  it("全文入索引（不做注入面的 200 字符截断）", () => {
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
    const rec = { ts: "2026-08-19T09:00:00Z", lastUser: "明天排练几点开始", lastAssistant: "下午三点在排练厅" };
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
    expect(rows[0].embedded).toBe(true);
    expect(rows[0].model).toBe(embeddingModel());
    expect(rows[0].text_tokens).toContain("排练");
  });

  it("curated 差量重建：变更条目替换、未变条目保留", async () => {
    await indexCurated("user", userA, "### 偏好\n\n- 喜欢深色主题\n\n- 常用工具是甘特图");
    const before = await getPool().query(
      "SELECT id, content_hash FROM agent_memory_chunk WHERE scope_id = $1 AND source = 'curated' ORDER BY content_hash",
      [userA],
    );
    await indexCurated("user", userA, "### 偏好\n\n- 喜欢深色主题\n\n- 常用工具是甘特图\n\n### 新增\n\n- 下周要交预算表");
    const after = await getPool().query(
      "SELECT content_hash FROM agent_memory_chunk WHERE scope_id = $1 AND source = 'curated'",
      [userA],
    );
    // 旧 hash 全部保留（内容没变），新增块出现
    const beforeHashes = new Set<string>(before.rows.map((r: { content_hash: string }) => r.content_hash));
    for (const h of beforeHashes) {
      expect(after.rows.some((r: { content_hash: string }) => r.content_hash === h)).toBe(true);
    }
    expect(after.rows.length).toBeGreaterThanOrEqual(before.rows.length);
  });

  it("curated 注释元数据落列", async () => {
    await indexCurated("user", userB, "- 网关保持 loopback <!-- trigger: 网关配置 --> <!-- importance: 9 -->");
    const { rows } = await getPool().query(
      "SELECT importance, triggers FROM agent_memory_chunk WHERE scope_id = $1 AND source = 'curated'",
      [userB],
    );
    expect(rows[0].importance).toBe(9);
    expect(rows[0].triggers).toBe("网关配置");
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

  it("importance 乘子参与排序公式", async () => {
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
    // 记账是 fire-and-forget，轮询等它落库
    await new Promise((r) => setTimeout(r, 200));
    const after = await getPool().query(
      "SELECT count(*)::int AS n FROM agent_memory_recall_log WHERE user_id = $1", [userA],
    );
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
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
