import { observeRetrieval } from "../runtime/observation";
// 记忆混合检索（my.memory_search 的实现）。
//
// 排序公式照抄 OpenClaw builtin 引擎（权重/阈值为 dist 实测值；关键词分是
// 我们的 bigram 命中占比而非 BM25，0..1 归一语义一致）：
//   最终得分 = (0.7·向量余弦 + 0.3·关键词) × 新近度衰减 × importance 乘子
// - 新近度：episodic 30 天半衰期（按 observed_at）；当前长期条目不衰减
// - importance：旧索引的可空元数据，新归档不接受模型标注，NULL=中性 1.0；映射 0.75+0.05n
//   （1→0.8 … 10→1.25，我们自选的温和乘子，OpenClaw 未公开其映射）
// - minScore 0.35、top 6
//
// fail-closed（照抄）：显式配置的 embedding 供应商请求失败 → 抛
// MemoryUnavailableError，工具明确报"不可用"，绝不静默退化成纯关键词；
// EMBEDDING_PROVIDER=none / 无 key 才是合法的纯关键词模式（结果附注明）。
// 索引身份不符 → 向量车道暂停、关键词车道继续（附注明）。

import { createHash } from "node:crypto";
import { getPool } from "@/lib/pg";
import { creditsFromEmbeddingTokens } from "@/lib/account/plan";
import { EmbeddingUnavailableError, embedQuery, embeddingMode, embeddingModel } from "@/lib/agent/memory/embedding";
import { bigramTokens, ensureIndexIdentity } from "./index-db";
import { requireMemoryAccess, VISIBLE_HISTORY } from "./memory-db";

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
  source: "episodic";
  text: string;
  score: number;
  observedAt: Date;
};

type LaneRow = {
  id: string;
  source: "episodic";
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

async function searchMemoryImpl(userId: string, query: string, productionId: string | null, metrics: MemoryMetrics): Promise<MemorySearchResult> {
  const accessStarted = performance.now();
  try { await requireMemoryAccess(userId, productionId); }
  finally { metrics.stages.access = performance.now() - accessStarted; }
  const vectorStarted = performance.now();
  const pool = getPool();
  let note: string | null = null;

  // ── 向量车道可用性判定 + 查询嵌入 ──
  let queryVec: string | null = null;
  try {
    const mode = embeddingMode();
    if (mode === "none") {
      metrics.vectorReason = "not_configured";
      note = "（embedding 未配置，本次为纯关键词检索）";
    } else if (!(await ensureIndexIdentity())) {
      metrics.vectorReason = "index_identity_mismatch";
      note = "（索引与当前 embedding 配置不符，向量车道暂停待重建，本次为纯关键词检索）";
    } else {
      // fail-closed：这里失败直接抛，不落回纯关键词
      try {
        const q = await embedQuery(query);
        queryVec = `[${q.embedding.join(",")}]`;
        if (q.totalTokens > 0) {
          pool
            .query("INSERT INTO ai_usage (user_id, kind, model, tokens, billed_credits) VALUES ($1, 'embedding_query', $2, $3, $4)", [
              userId, embeddingModel(), q.totalTokens, creditsFromEmbeddingTokens(q.totalTokens),
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
  } finally { metrics.stages.vector = performance.now() - vectorStarted; }
  const queryStarted = performance.now();
  const qtokens = [...new Set(bigramTokens(query))];
  const tokenScoreSql = `(SELECT avg((c.text_tokens LIKE '%' || tt.tok || '%')::int) FROM unnest($4::text[]) AS tt(tok))`;
  type ScoredRow = LaneRow & { vscore: number; tscore: number };
  const { rows } = await pool.query<ScoredRow>(
    `SELECT c.id,c.source,c.text,c.observed_at,c.importance,
      CASE WHEN c.embedding IS NULL OR $3::vector IS NULL THEN 0 ELSE 1-(c.embedding<=>$3::vector) END AS vscore,
      COALESCE(${tokenScoreSql},0) AS tscore FROM agent_memory_chunk c WHERE ${VISIBLE_HISTORY}
      ORDER BY GREATEST(CASE WHEN c.embedding IS NULL OR $3::vector IS NULL THEN 0 ELSE 1-(c.embedding<=>$3::vector) END,COALESCE(${tokenScoreSql},0)) DESC LIMIT ${LANE_CANDIDATES}`,
    [userId, productionId, queryVec, qtokens]);

  metrics.stages.candidates = performance.now() - queryStarted;
  metrics.candidateCount = rows.length;
  const scoringStarted = performance.now();
  // 单车道缺席时另一路独跑（该路权重升为 1.0，OpenClaw 同语义）
  const vWeight = queryVec ? VECTOR_WEIGHT : 0;
  const tWeight = queryVec ? TEXT_WEIGHT : 1;

  const hits: MemoryHit[] = [];
  for (const row of rows) {
    const weighted = vWeight * Number(row.vscore) + tWeight * Number(row.tscore);
    const hybrid = Math.max(weighted, KEYWORD_SOLO_WEIGHT * Number(row.tscore));
    const score = hybrid * recencyMultiplier(row.source, new Date(row.observed_at)) * importanceMultiplier(row.importance);
    metrics.scores.push({ id: row.id, source: row.source, score, vector: Number(row.vscore), lexical: Number(row.tscore) });
    if (score < MIN_SCORE) continue;
    hits.push({ id: row.id, source: row.source, text: row.text, score, observedAt: new Date(row.observed_at) });
  }
  metrics.stages.scoring = performance.now() - scoringStarted;
  hits.sort((a,b) => b.score-a.score);
  const top = hits.slice(0, MAX_RESULTS);

  // 召回记账（Phase B 晋升门的信号源；失败不反噬检索）
  if (top.length > 0) {
    const queryHash = createHash("sha256").update(query).digest("hex").slice(0, 32);
    Promise.all(
      top.filter(h => h.source === "episodic").map((h) =>
        pool.query("INSERT INTO agent_memory_recall_log (chunk_id, user_id, query_hash) VALUES ($1, $2, $3)", [
          h.id, userId, queryHash,
        ]),
      ),
    ).catch((err) => console.error("[memory-search] 召回记账失败（忽略）:", err));
  }

  return { hits: top, note };
}

type MemoryMetrics = {
  stages: Record<string, number>; candidateCount?: number; vectorReason?: string;
  scores: Array<{ id: string; source: string; score: number; vector: number | null; lexical: number }>;
};
export async function searchMemory(userId: string, query: string, productionId: string | null = null): Promise<MemorySearchResult> {
  const observation = await observeRetrieval("memory_retrieval", "explicit", userId);
  const metrics: MemoryMetrics = { stages: {}, scores: [] };
  try {
    const result = await searchMemoryImpl(userId, query, productionId, metrics);
    await observation.finish({ ...metrics, status: "ok", reason: metrics.vectorReason ?? null,
      returnedCount: result.hits.length, returnedIds: result.hits.map(h => h.id),
      threshold: MIN_SCORE, limit: MAX_RESULTS, candidateLimit: LANE_CANDIDATES });
    return result;
  } catch (err) {
    await observation.finish({ ...metrics, status: "error", reason: err instanceof MemoryUnavailableError ? "embedding_unavailable" : "retrieval_failed" });
    throw err;
  }
}

/** MCP 工具输出格式化。 */
export function formatSearchResult(result: MemorySearchResult, query: string): string {
  const lines: string[] = [];
  if (result.hits.length === 0) {
    lines.push(`没有找到与「${query}」相关的记忆。`);
  } else {
    lines.push(`与「${query}」相关的记忆（按相关度排序）：`);
    for (const h of result.hits) {
      const kind = "历史对话记录（不代表当前有效约定）";
      const when = h.observedAt.toISOString().slice(0, 10);
      const text = h.text.length > SNIPPET_MAX_CHARS ? `${h.text.slice(0, SNIPPET_MAX_CHARS)}…` : h.text;
      lines.push(`\n【${kind} · ${when} · 相关度 ${h.score.toFixed(2)}】\n${text}`);
    }
  }
  if (result.note) lines.push(`\n${result.note}`);
  return lines.join("\n");
}
