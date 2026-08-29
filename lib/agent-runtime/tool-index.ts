// 工具索引（#367）：主动召回与 find_tools 兜底共用的一份检索面。
//
// 两条车道取 max（与 lib/agent-memory/trigger.ts 同款判据）：
//   词法  = 触发短语的 CJK bigram 命中占比（tool-catalog.triggers）
//   向量  = 用户消息 ↔ 例句/一句话 的余弦（tool-catalog.examples），每条例句独立嵌入取 max
// 向量车道复用记忆检索的 embedding 供应商（agent/embedding.ts）；文档侧向量启动后
// 按 (model, content_hash) 缓存进 agent_memory_embedding_cache，进程内再缓存一份。
// 供应商未配置/挂了 → 只剩词法（fail-open 到弱一路，不断轮次）。
//
// 260 个工具也是这个形态：语料线性增长，每轮只嵌一次查询。

import { createHash } from "node:crypto";
import { getPool } from "@/lib/pg";
import { embedDocuments, embedQuery, embeddingMode, embeddingModel } from "@/agent/embedding";
import { TOOL_CATALOG, TOOL_FAMILIES, TOOL_RECALL_THRESHOLD, type ToolCatalogEntry } from "@/lib/mcp/tool-catalog";
import { bigramTokens } from "@/lib/agent-memory/trigger-lexical";

/** 向量车道阈值。text-embedding-v4 实测（2026-08-29 本机探针）：真命中 0.65–0.82，
 *  无关噪声 0.35–0.60（"今天天气怎么样" → call_times 0.42），分布很压缩，0.62 是噪声上沿之上
 *  的第一个整数位。召回只是提示（工具面多带 ≤3 个），漏了还有 find_tools 兜底，宁紧勿松。
 *  AGENT_TOOL_RECALL_DEBUG=1 打分数日志可继续标定。 */
export const TOOL_VECTOR_THRESHOLD = Number(process.env.AGENT_TOOL_VEC_THRESHOLD ?? 0.65);
/** 每轮最多召回的族数。族是整族入面（wiki 族 ~10 个 schema），2 个族已是 20 个工具的上限。 */
export const TOOL_RECALL_MAX_FAMILIES = 2;

export interface ToolHit {
  name: string;
  family: string;
  oneliner: string;
  score: number;
  lexical: number;
  vector: number | null;
}

/** 族级命中：分 = 族内工具最高分；tools 是整族（含未直接命中的兄弟） */
export interface FamilyHit {
  family: string;
  label: string;
  score: number;
  /** 族内得分最高的工具（日志/标定用） */
  top: ToolHit;
  tools: Array<{ name: string; oneliner: string }>;
}

type Doc = { name: string; text: string; hash: string; vec: number[] | null };

let docs: Doc[] | null = null;
let docsPromise: Promise<Doc[]> | null = null;

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function docTexts(entry: ToolCatalogEntry): string[] {
  return [entry.oneliner, ...(entry.examples ?? [])];
}

/** 文档侧向量：先查缓存表，缺的批量嵌入后回写。任何失败 → 该批无向量（词法仍在）。 */
async function loadDocs(): Promise<Doc[]> {
  const all: Doc[] = [];
  for (const e of TOOL_CATALOG) for (const text of docTexts(e)) all.push({ name: e.name, text, hash: hashOf(text), vec: null });
  if (embeddingMode() === "none") return all;
  try {
    const pool = getPool();
    // fake 模式（测试替身）的向量绝不能和真模型的缓存混在一个键下：测试跑过一遍就会把
    // 本地库里真模型名下的行换成哈希向量，之后真召回全部近似正交（余弦 ~0.05）。
    const model = embeddingMode() === "fake" ? `fake:${embeddingModel()}` : embeddingModel();
    const cached = await pool.query<{ content_hash: string; embedding: string }>(
      `SELECT content_hash, embedding::text AS embedding FROM agent_memory_embedding_cache WHERE model = $1 AND content_hash = ANY($2::text[])`,
      [model, all.map((d) => d.hash)],
    );
    const byHash = new Map(cached.rows.map((r) => [r.content_hash, JSON.parse(r.embedding) as number[]]));
    const missing = all.filter((d) => !byHash.has(d.hash));
    if (missing.length > 0) {
      const { embeddings } = await embedDocuments(missing.map((d) => d.text));
      for (let i = 0; i < missing.length; i++) {
        byHash.set(missing[i].hash, embeddings[i]);
        await pool.query(
          `INSERT INTO agent_memory_embedding_cache (model, content_hash, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING`,
          [model, missing[i].hash, `[${embeddings[i].join(",")}]`],
        );
      }
    }
    for (const d of all) d.vec = byHash.get(d.hash) ?? null;
  } catch (err) {
    console.error("[tool-index] document embeddings unavailable, lexical only:", err);
  }
  return all;
}

async function ensureDocs(): Promise<Doc[]> {
  if (docs) return docs;
  if (!docsPromise) docsPromise = loadDocs().then((d) => (docs = d)).finally(() => { docsPromise = null; });
  return docsPromise;
}

/** 测试/热更新：丢弃进程内缓存（DB 缓存保留）。 */
export function resetToolIndex(): void {
  docs = null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot; // 两侧都是单位向量
}

function lexicalScore(phrase: string, promptTokens: Set<string>): number {
  const toks = bigramTokens(phrase);
  if (toks.length === 0) return 0;
  let hit = 0;
  for (const t of toks) if (promptTokens.has(t)) hit++;
  return hit / toks.length;
}

/** 查询侧向量（失败 → null，词法单路）。userId 用于 ai_usage 记账。 */
async function queryVector(prompt: string, userId: string | null): Promise<number[] | null> {
  if (embeddingMode() === "none") return null;
  try {
    const q = await embedQuery(prompt);
    if (q.totalTokens > 0 && userId) {
      void getPool().query(
        "INSERT INTO ai_usage (user_id, kind, model, tokens) VALUES ($1, 'embedding_query', $2, $3)",
        [userId, embeddingModel(), q.totalTokens],
      ).catch(() => {});
    }
    return q.embedding;
  } catch (err) {
    console.error("[tool-index] query embedding failed, lexical only:", err);
    return null;
  }
}

/** 全量打分（不截断、不设阈值），供召回与搜索各自裁剪。 */
export async function scoreTools(prompt: string, opts: { hasProduction: boolean; userId?: string | null }): Promise<ToolHit[]> {
  const [allDocs, qvec] = await Promise.all([ensureDocs(), queryVector(prompt, opts.userId ?? null)]);
  const promptTokens = new Set(bigramTokens(prompt));
  const hits: ToolHit[] = [];
  for (const entry of TOOL_CATALOG) {
    if (entry.scope === "production" && !opts.hasProduction) continue;
    let lexical = 0;
    for (const t of entry.triggers) lexical = Math.max(lexical, lexicalScore(t, promptTokens));
    let vector: number | null = null;
    if (qvec) {
      for (const d of allDocs) {
        if (d.name !== entry.name || !d.vec) continue;
        vector = Math.max(vector ?? 0, cosine(qvec, d.vec));
      }
    }
    const score = Math.max(lexical, vector ?? 0);
    hits.push({ name: entry.name, family: entry.family, oneliner: entry.oneliner, score, lexical, vector });
  }
  hits.sort((a, b) => b.score - a.score);
  if (process.env.AGENT_TOOL_RECALL_DEBUG === "1") {
    console.log(`[tool-index] "${prompt.slice(0, 40)}" → ${hits.slice(0, 5).map((h) => `${h.name}=${h.score.toFixed(2)}(l${h.lexical.toFixed(2)}/v${h.vector === null ? "-" : h.vector.toFixed(2)})`).join(" ")}`);
  }
  return hits;
}

/** 主动召回（族粒度）：族内任一工具 词法 ≥ 0.72 或 向量 ≥ 阈值 → 整族入面；按族分取前 N 族。 */
export async function recallFamilies(prompt: string, opts: { hasProduction: boolean; userId?: string | null }): Promise<FamilyHit[]> {
  if (!prompt.trim()) return [];
  const hits = await scoreTools(prompt, opts);
  const byFamily = new Map<string, FamilyHit>();
  for (const h of hits) {
    const passes = h.lexical >= TOOL_RECALL_THRESHOLD || (h.vector !== null && h.vector >= TOOL_VECTOR_THRESHOLD);
    if (!passes || byFamily.has(h.family)) continue; // hits 已按分降序，首个即族内最高
    byFamily.set(h.family, {
      family: h.family,
      label: TOOL_FAMILIES[h.family]?.label ?? h.family,
      score: h.score,
      top: h,
      tools: TOOL_CATALOG.filter((e) => e.family === h.family && (opts.hasProduction || e.scope !== "production"))
        .map((e) => ({ name: e.name, oneliner: e.oneliner })),
    });
  }
  return [...byFamily.values()].sort((a, b) => b.score - a.score).slice(0, TOOL_RECALL_MAX_FAMILIES);
}

/** find_tools 兜底：不设阈值，按分取前 N（模型自己判断哪个对）。 */
export async function searchTools(query: string, opts: { hasProduction: boolean; userId?: string | null; limit?: number }): Promise<ToolHit[]> {
  const hits = await scoreTools(query, opts);
  return hits.filter((h) => h.score > 0).slice(0, opts.limit ?? 5);
}
