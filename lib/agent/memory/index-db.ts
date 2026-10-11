// 历史归档索引：文本同步落库，向量由回填补齐；长期条目不再另建索引。
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { creditsFromEmbeddingTokens } from "@/lib/account/plan";
import {
  EMBEDDING_DIM,
  EmbeddingUnavailableError,
  embedDocuments,
  embeddingMode,
  embeddingModel,
  type EmbedResult,
} from "@/lib/agent/memory/embedding";
import type { RunRecord } from "./store";
import { lockMemoryUser, requireMemoryAccess, VISIBLE_HISTORY } from "./memory-db";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── 关键词车道分词（bigram）─────────────────────────────────────────────────
// pg_trgm 对连续中文近乎失效（短查询的 trigram 边界填充对不上无空格文本），
// 改用中文检索标准做法：CJK 逐对 bigram + ASCII/数字整词（小写）。索引侧
// 与查询侧共用本函数——两侧切法不一致=检索面静默失效。

// 分词实现抽到 trigger-lexical.ts（零依赖，供 lib/agent/tools/tool-catalog.ts 复用，
// #333 P2），索引与查询复用相同切词。
export { bigramTokens } from "./trigger-lexical";
import { bigramTokens } from "./trigger-lexical";

/** 落库形态：空格分隔（查询侧按 LIKE '%tok%' 命中占比评分）。 */
export function tokensText(text: string): string {
  return bigramTokens(text).join(" ");
}

/** episodic run 记录 → 索引文本（全文，不同于注入面的 200 字符截断——
 * 检索语料截太狠等于没有语料；上报侧插件已有 2000 字符/侧的采集上限）。 */
export function episodicText(rec: RunRecord): string | null {
  const user = (rec.lastUser ?? "").trim();
  const assistant = (rec.lastAssistant ?? "").trim();
  if (!user && !assistant) return null;
  const when = rec.ts ? rec.ts.slice(0, 16).replace("T", " ") : "";
  const prod = rec.productionId ? `（制作 ${rec.productionId}）` : "";
  return `[${when}]${prod}\n用户：${user || "（无）"}\n助手：${assistant || "（无）"}`;
}

// ── 索引身份 ─────────────────────────────────────────────────────────────────

/** 校验/初始化索引身份。返回 false = 运行时配置与既有索引不一致：向量车道
 * 必须拒绝服务（写入侧跳过嵌入、查询侧明确报暂停），等回填脚本重建后更新
 * meta——绝不静默混维度（OpenClaw index identity 语义）。 */
export async function ensureIndexIdentity(client?: PoolClient): Promise<boolean> {
  const db = client ?? getPool();
  const model = embeddingModel();
  const { rows } = await db.query<{ model: string; dim: number }>(
    "SELECT model, dim FROM agent_memory_index_meta WHERE id = 1",
  );
  if (rows.length === 0) {
    await db.query(
      `INSERT INTO agent_memory_index_meta (id, model, dim) VALUES (1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [model, EMBEDDING_DIM],
    );
    return true;
  }
  return rows[0].model === model && rows[0].dim === EMBEDDING_DIM;
}

// ── embedding（带缓存）──────────────────────────────────────────────────────

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** 用量归属：user 域记 user_id，production 域记 production_id——ai_usage 有
 * CHECK 至少归一个主体（review #297：无主行对告警/核算都是废数据）。 */
export type UsageAttribution = { userId?: string; productionId?: string };

export function scopeAttribution(scopeType: "user" | "production", scopeId: string): UsageAttribution {
  return scopeType === "user" ? { userId: scopeId } : { productionId: scopeId };
}

/** 用量账本（失败吞掉——记账绝不反噬业务路径）。 */
async function logUsage(kind: string, tokens: number, attr: UsageAttribution): Promise<void> {
  if (tokens <= 0) return;
  try {
    await getPool().query(
      "INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits) VALUES ($1, $2, $3, $4, $5, $6)",
      [attr.userId ?? null, attr.productionId ?? null, kind, embeddingModel(), tokens, creditsFromEmbeddingTokens(tokens)],
    );
  } catch (err) {
    console.error("[memory-index] 用量记账失败（忽略）:", err);
  }
}

/** 批量嵌入，先查缓存。返回 hash → vector 文本字面量；供应商不可用时返回
 * 空 Map（调用方落 NULL embedding，关键词车道兜底）。 */
async function embedWithCache(
  texts: Array<{ text: string; contentHash: string }>,
  usageAttr: UsageAttribution,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (texts.length === 0) return out;
  if (embeddingMode() === "none") return out; // 合法的纯关键词模式
  // fake 模式（测试替身）的向量单独一个缓存键：否则测试跑过一遍就把真模型名下的缓存行
  // 换成哈希向量（本地库已实锤发生过——工具索引 92 行全被污染，真召回余弦 ~0.05）。
  const model = embeddingMode() === "fake" ? `fake:${embeddingModel()}` : embeddingModel();
  const pool = getPool();

  const hashes = [...new Set(texts.map((t) => t.contentHash))];
  const { rows: cached } = await pool.query<{ content_hash: string; embedding: string }>(
    "SELECT content_hash, embedding::text AS embedding FROM agent_memory_embedding_cache WHERE model = $1 AND content_hash = ANY($2)",
    [model, hashes],
  );
  for (const r of cached) out.set(r.content_hash, r.embedding);

  const missing = texts.filter((t, i, arr) => !out.has(t.contentHash) && arr.findIndex((x) => x.contentHash === t.contentHash) === i);
  if (missing.length === 0) return out;

  let result: EmbedResult;
  try {
    result = await embedDocuments(missing.map((t) => t.text));
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      console.warn(`[memory-index] embedding 不可用，本批 ${missing.length} 块留待回填：${err.message}`);
      return out;
    }
    throw err;
  }
  await logUsage("embedding_index", result.totalTokens, usageAttr);

  for (let i = 0; i < missing.length; i++) {
    const lit = toVectorLiteral(result.embeddings[i]);
    out.set(missing[i].contentHash, lit);
    await pool.query(
      `INSERT INTO agent_memory_embedding_cache (model, content_hash, embedding)
       VALUES ($1, $2, $3::vector) ON CONFLICT (model, content_hash) DO NOTHING`,
      [model, missing[i].contentHash, lit],
    );
  }
  return out;
}

// ── 写入口 ───────────────────────────────────────────────────────────────────

/** 历史先落库，再由回填补向量；来源资格由服务端 run/session 校验。
 * 用户锁让归档与历史截断有明确顺序；开始于截断之前的晚完成 run 也不能回流。 */
export async function indexEpisodicRun(userId: string, rec: RunRecord, options: { deferEmbedding?: boolean } = {}): Promise<void> {
  if (!rec.lastUser && !rec.lastAssistant) return;
  let chunkId: string | undefined;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMemoryUser(client, userId);
    let productionId = rec.productionId ?? null;
    let observedAt = rec.ts;
    let sourceStartedAt = rec.ts;
    if (rec.runId) {
      const run = (await client.query<{ production_id: string | null; started_at: string; session_created_at: string }>(
        "SELECT s.production_id,r.started_at::text,s.created_at::text AS session_created_at FROM agent_run r JOIN agent_session s ON s.id=r.session_id WHERE r.id=$1 AND s.user_id=$2", [rec.runId, userId])).rows[0];
      if (!run) throw new Error("记忆归档 run 不属于当前用户");
      productionId = run.production_id; observedAt = run.started_at; sourceStartedAt = run.session_created_at;
    }
    await requireMemoryAccess(userId, productionId);
    if (!observedAt || Number.isNaN(Date.parse(observedAt))) throw new Error("无效历史时间");
    const text = episodicText({ ...rec, productionId });
    if (!text) { await client.query("ROLLBACK"); return; }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agent_memory_chunk(scope_type,scope_id,source,text,text_tokens,content_hash,
        origin_class,session_kind,observed_at,author_user_id,production_id,scope_known)
       SELECT 'user',$1::text,'episodic',$2::text,$3::text,$4::text,'owner','interactive',$5::timestamptz,$1::text::uuid,$6::text,true
       WHERE NOT EXISTS(SELECT 1 FROM agent_memory_scope WHERE user_id=$1::text::uuid
         AND scope_key IN ('',COALESCE($6,'')) AND history_cutoff IS NOT NULL AND ($5::timestamptz<=history_cutoff OR $7::timestamptz<=history_cutoff))
       ON CONFLICT(scope_type,scope_id,source,content_hash) DO UPDATE
       SET production_id=EXCLUDED.production_id,scope_known=true,observed_at=EXCLUDED.observed_at RETURNING id`,
      [userId, text, tokensText(text), sha256(text), observedAt, productionId, sourceStartedAt]);
    chunkId = inserted.rows[0]?.id;
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  if (chunkId && !options.deferEmbedding && embeddingMode() !== "none") {
    void embedArchiveChunk(chunkId, userId).catch(err => console.error("[memory-index] 向量补齐失败，保留文本待回填", err));
  }
}

// 网络请求不持用户锁；只更新仍存在的同一行，删除期间返回的向量不能重建历史。
async function embedArchiveChunk(id: string, userId: string): Promise<void> {
  if (!(await ensureIndexIdentity())) return;
  const row = (await getPool().query<{ text: string; content_hash: string }>(
    `SELECT c.text,c.content_hash FROM agent_memory_chunk c WHERE ${VISIBLE_HISTORY} AND c.id=$3 AND c.embedding IS NULL`, [userId, null, id])).rows[0];
  if (!row) return;
  const vectors = await embedWithCache([{ text: row.text, contentHash: row.content_hash }], { userId });
  const vector = vectors.get(row.content_hash);
  if (vector) await getPool().query("UPDATE agent_memory_chunk SET embedding=$2::vector,model=$3 WHERE id=$1 AND embedding IS NULL", [id, vector, embeddingModel()]);
}

/** 回填：补齐 embedding 为 NULL 的块（供应商恢复后/首次配 key 后）。
 * 返回本轮补齐数。 */
export async function embedMissing(limit = 200): Promise<number> {
  if (!(await ensureIndexIdentity())) {
    throw new Error("索引身份与配置不符，先 --rebuild 重建");
  }
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; text: string; content_hash: string; scope_id: string; scope_type: "user" | "production" }>(
    `SELECT id, text, content_hash, scope_id, scope_type FROM agent_memory_chunk WHERE embedding IS NULL AND source='episodic' AND scope_known AND scope_type='user'
      AND (production_id IS NULL OR EXISTS(SELECT 1 FROM production p WHERE p.id=agent_memory_chunk.production_id
        AND (p.owner_id::text=agent_memory_chunk.scope_id OR EXISTS(SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id::text=agent_memory_chunk.scope_id AND m.status='active'))))
      ORDER BY created_at LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return 0;

  // 按 scope 分组嵌入——用量归到块的归属主体，不因"批处理"就记无主账
  // （review #297 finding 2：ai_usage 每行必须至少归一个主体）
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.scope_type}:${r.scope_id}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }

  let updated = 0;
  for (const group of groups.values()) {
    const vectors = await embedWithCache(
      group.map((r) => ({ text: r.text, contentHash: r.content_hash })),
      scopeAttribution(group[0].scope_type, group[0].scope_id),
    );
    for (const r of group) {
      const vec = vectors.get(r.content_hash);
      if (!vec) continue;
      await pool.query(
        "UPDATE agent_memory_chunk SET embedding = $1::vector, model = $2 WHERE id = $3 AND embedding IS NULL",
        [vec, embeddingModel(), r.id],
      );
      updated++;
    }
  }
  return updated;
}
