// 记忆混合检索（my.memory_search 的实现）。
//
// 排序公式照抄 OpenClaw builtin 引擎（权重/阈值为 dist 实测值；关键词分是
// 我们的 bigram 命中占比而非 BM25，0..1 归一语义一致）：
//   最终得分 = (0.7·向量余弦 + 0.3·关键词) × 新近度衰减 × importance 乘子
// - 新近度：episodic 30 天半衰期（按 observed_at）；curated 常青不衰减
// - importance：写入时标注（M2 起产出），NULL=中性 1.0；映射 0.75+0.05n
//   （1→0.8 … 10→1.25，我们自选的温和乘子，OpenClaw 未公开其映射）
// - minScore 0.35、top 6
//
// fail-closed（照抄）：显式配置的 embedding 供应商请求失败 → 抛
// MemoryUnavailableError，工具明确报"不可用"，绝不静默退化成纯关键词；
// EMBEDDING_PROVIDER=none / 无 key 才是合法的纯关键词模式（结果附注明）。
// 索引身份不符 → 向量车道暂停、关键词车道继续（附注明）。

import { createHash } from "node:crypto";
import { getPool } from "@/lib/pg";
import { EmbeddingUnavailableError, embedQuery, embeddingMode, embeddingModel } from "@/lib/agent-memory/embedding";
import { bigramTokens, ensureIndexIdentity } from "./index-db";

export const VECTOR_WEIGHT = 0.7;
export const TEXT_WEIGHT = 0.3;
export const MIN_SCORE = 0.35;
/** 强关键词兜底（对 OpenClaw 公式的有意识偏离）：向量车道活跃时纯关键词
 * 命中在加权和里封顶 0.3，过不了 minScore——精确检索 ID/人名/报错串这类
 * BM25 本职场景会被误杀（向量分对这类查询可以接近 0）。改为
 * score = max(加权和, 0.55·关键词分)：满分关键词命中独立过线（0.55），
 * 弱关键词（<0.64）仍靠不了这条通道。 */
export const KEYWORD_SOLO_WEIGHT = 0.55;
export const MAX_RESULTS = 6;
export const RECENCY_HALF_LIFE_DAYS = 30;
const LANE_CANDIDATES = 40;
const SNIPPET_MAX_CHARS = 500;

export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

export type MemoryHit = {
  id: string;
  source: "curated" | "episodic";
  text: string;
  score: number;
  observedAt: Date;
};

type LaneRow = {
  id: string;
  source: "curated" | "episodic";
  text: string;
  observed_at: Date;
  importance: number | null;
};

function importanceMultiplier(importance: number | null): number {
  return importance === null ? 1 : 0.75 + 0.05 * importance;
}

function recencyMultiplier(source: string, observedAt: Date): number {
  if (source !== "episodic") return 1;
  const ageDays = Math.max(0, (Date.now() - observedAt.getTime()) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

export type MemorySearchResult = {
  hits: MemoryHit[];
  /** 检索面状态附注（纯关键词模式/向量车道暂停时非空，拼进工具输出）。 */
  note: string | null;
};

export async function searchMemory(userId: string, query: string): Promise<MemorySearchResult> {
  const pool = getPool();
  const mode = embeddingMode();
  let note: string | null = null;

  // ── 向量车道可用性判定 + 查询嵌入 ──
  let queryVec: string | null = null;
  if (mode === "none") {
    note = "（embedding 未配置，本次为纯关键词检索）";
  } else if (!(await ensureIndexIdentity())) {
    note = "（索引与当前 embedding 配置不符，向量车道暂停待重建，本次为纯关键词检索）";
  } else {
    // fail-closed：这里失败直接抛，不落回纯关键词
    try {
      const q = await embedQuery(query);
      queryVec = `[${q.embedding.join(",")}]`;
      if (q.totalTokens > 0) {
        pool
          .query("INSERT INTO ai_usage (user_id, kind, model, tokens) VALUES ($1, 'embedding_query', $2, $3)", [
            userId, embeddingModel(), q.totalTokens,
          ])
          .catch((e) => console.error("[memory-search] 用量记账失败（忽略）:", e));
      }
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new MemoryUnavailableError(`记忆检索暂不可用（embedding 供应商异常：${err.message}）`);
      }
      throw err;
    }
  }

  // ── 候选集 = 双车道 top-N 的并集，之后对并集统一算**双车道真分**——
  // 只进了关键词 top-N 的行余弦分不能按 0 算，否则会被 minScore 误杀。
  // 关键词车道：查询与语料同一套 bigram 切词（见 index-db.ts bigramTokens，
  // pg_trgm 对连续中文近乎失效），得分=查询 token 的命中占比（0..1）。
  // token 字符集是 CJK/[a-z0-9] 构造保证，无 LIKE 元字符，可安全拼接。
  const qtokens = [...new Set(bigramTokens(query))];
  const tokenScoreSql = qtokens.length
    ? `(SELECT avg((c.text_tokens LIKE '%' || tt.tok || '%')::int)
        FROM unnest($TOK::text[]) AS tt(tok))`
    : "0";

  type ScoredRow = LaneRow & { vscore: number; tscore: number };
  let rows: ScoredRow[];
  if (queryVec) {
    const params: unknown[] = [queryVec, userId];
    let tokExpr = "0";
    if (qtokens.length) {
      params.push(qtokens);
      tokExpr = tokenScoreSql.replace("$TOK", `$${params.length}`);
    }
    ({ rows } = await pool.query<ScoredRow>(
      `WITH scored AS (
         SELECT c.id, c.source, c.text, c.observed_at, c.importance,
                CASE WHEN c.embedding IS NULL THEN 0
                     ELSE 1 - (c.embedding <=> $1::vector) END AS vscore,
                ${tokExpr} AS tscore
         FROM agent_memory_chunk c
         WHERE c.scope_type = 'user' AND c.scope_id = $2
       )
       SELECT * FROM scored
       ORDER BY GREATEST(vscore, tscore) DESC
       LIMIT ${LANE_CANDIDATES}`,
      params,
    ));
  } else {
    if (qtokens.length === 0) return { hits: [], note };
    const tokExpr = tokenScoreSql.replace("$TOK", "$2");
    ({ rows } = await pool.query<ScoredRow>(
      `SELECT c.id, c.source, c.text, c.observed_at, c.importance,
              0 AS vscore, ${tokExpr} AS tscore
       FROM agent_memory_chunk c
       WHERE c.scope_type = 'user' AND c.scope_id = $1
       ORDER BY tscore DESC LIMIT ${LANE_CANDIDATES}`,
      [userId, qtokens],
    ));
  }

  // 单车道缺席时另一路独跑（该路权重升为 1.0，OpenClaw 同语义）
  const vWeight = queryVec ? VECTOR_WEIGHT : 0;
  const tWeight = queryVec ? TEXT_WEIGHT : 1;

  const hits: MemoryHit[] = [];
  for (const row of rows) {
    const weighted = vWeight * Number(row.vscore) + tWeight * Number(row.tscore);
    const hybrid = Math.max(weighted, KEYWORD_SOLO_WEIGHT * Number(row.tscore));
    const score = hybrid * recencyMultiplier(row.source, new Date(row.observed_at)) * importanceMultiplier(row.importance);
    if (score < MIN_SCORE) continue;
    hits.push({ id: row.id, source: row.source, text: row.text, score, observedAt: new Date(row.observed_at) });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, MAX_RESULTS);

  // 召回记账（Phase B 晋升门的信号源；失败不反噬检索）
  if (top.length > 0) {
    const queryHash = createHash("sha256").update(query).digest("hex").slice(0, 32);
    Promise.all(
      top.map((h) =>
        pool.query("INSERT INTO agent_memory_recall_log (chunk_id, user_id, query_hash) VALUES ($1, $2, $3)", [
          h.id, userId, queryHash,
        ]),
      ),
    ).catch((err) => console.error("[memory-search] 召回记账失败（忽略）:", err));
  }

  return { hits: top, note };
}

/** MCP 工具输出格式化。 */
export function formatSearchResult(result: MemorySearchResult, query: string): string {
  const lines: string[] = [];
  if (result.hits.length === 0) {
    lines.push(`没有找到与「${query}」相关的记忆。`);
  } else {
    lines.push(`与「${query}」相关的记忆（按相关度排序）：`);
    for (const h of result.hits) {
      const kind = h.source === "curated" ? "长期记忆" : "对话记录";
      const when = h.observedAt.toISOString().slice(0, 10);
      const text = h.text.length > SNIPPET_MAX_CHARS ? `${h.text.slice(0, SNIPPET_MAX_CHARS)}…` : h.text;
      lines.push(`\n【${kind} · ${when} · 相关度 ${h.score.toFixed(2)}】\n${text}`);
    }
  }
  if (result.note) lines.push(`\n${result.note}`);
  return lines.join("\n");
}
