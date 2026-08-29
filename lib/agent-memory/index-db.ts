// 记忆索引写入层（Postgres，agent_memory_* 表）。
//
// 对应 OpenClaw builtin 引擎的索引侧：分块 → embedding（带缓存）→ 落库。
// 机制出处见 MindWeave《OpenClaw记忆检索机制调研与移植设计》§4。
//
// 纪律（照抄 OpenClaw 设计原则五）：**索引失败绝不阻塞回复/写入路径**。
// 两个写入点（/memory-run 上报、蒸馏产出）都是 fire-and-forget 调这里；
// embedding 供应商挂掉时仍索引纯文本（关键词车道可用），向量列留 NULL
// 由回填脚本补——对应 OpenClaw 的 creation-time fallback。

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import {
  EMBEDDING_DIM,
  EmbeddingUnavailableError,
  embedDocuments,
  embeddingMode,
  embeddingModel,
  type EmbedResult,
} from "@/agent/embedding";
import type { RunRecord } from "./store";

// 分块参数。OpenClaw 是 400 token/80 重叠的滑窗；我们的 curated 语料是蒸馏
// 产物（要点列表，天然成块），按语义块打包更贴合 trigger/importance 的
// 「按条目标注」语义——块打包上限 600 字符（中文下与 400 token 同量级），
// 单块超限才硬切并带 100 字符重叠。
export const CHUNK_MAX_CHARS = 600;
export const CHUNK_HARD_SPLIT_OVERLAP = 100;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── 关键词车道分词（bigram）─────────────────────────────────────────────────
// pg_trgm 对连续中文近乎失效（短查询的 trigram 边界填充对不上无空格文本），
// 改用中文检索标准做法：CJK 逐对 bigram + ASCII/数字整词（小写）。索引侧
// 与查询侧共用本函数——两侧切法不一致=检索面静默失效。

// 分词实现抽到 trigger-lexical.ts（零依赖，供 lib/mcp/tool-catalog.ts 复用，
// #333 P2），这里原地再导出——既有调用方（trigger.ts / 本文件内部）零改动。
export { bigramTokens } from "./trigger-lexical";
import { bigramTokens } from "./trigger-lexical";

/** 落库形态：空格分隔（查询侧按 LIKE '%tok%' 命中占比评分）。 */
export function tokensText(text: string): string {
  return bigramTokens(text).join(" ");
}

export type MemoryChunk = {
  text: string;
  contentHash: string;
  importance: number | null;
  triggers: string | null;
};

const IMPORTANCE_RE = /<!--\s*importance:\s*(\d{1,2})\s*-->/g;
const TRIGGER_RE = /<!--\s*trigger:\s*([^>]*?)\s*-->/g;

/** 从块文本提取行尾注释元数据（格式照抄 OpenClaw：
 * `<!-- trigger: a, b --> <!-- importance: 9 -->`）。M2 蒸馏升级前语料里
 * 没有这些注释，全部返回 null（可空=中性，与 OpenClaw 同语义）。 */
export function parseAnnotations(text: string): { importance: number | null; triggers: string | null } {
  let importance: number | null = null;
  for (const m of text.matchAll(IMPORTANCE_RE)) {
    const v = Number(m[1]);
    if (v >= 1 && v <= 10) importance = Math.max(importance ?? 0, v);
  }
  const triggers: string[] = [];
  for (const m of text.matchAll(TRIGGER_RE)) {
    const t = m[1].trim();
    if (t) triggers.push(t);
  }
  return { importance, triggers: triggers.length ? triggers.join(", ") : null };
}

/** 注入/展示前剥掉行尾注释元数据——注释是给索引器读的结构化信号，进
 * prompt 只是噪音 token（还会教坏模型模仿着写）。 */
export function stripAnnotations(text: string): string {
  return text
    .replace(/\s*<!--\s*(?:importance|trigger):[^>]*?-->/g, "")
    .replace(/[ \t]+$/gm, "");
}

/** Markdown 分块：**逐条目一块不打包**——打包会让相邻条目互相牵连 hash
 * （蒸馏任何增改都导致整包重嵌、差量重建失效），逐条粒度才有「未变条目零
 * API 调用」与 trigger/importance 按条标注的语义。
 *
 * 两级拆分（线上蒸馏产物实测修正，M2 验收发现）：先按空行拆块；块内若含
 * 多个 bullet 行（真实蒸馏输出的条目间**没有空行**，只按空行拆会把整个
 * 小节当一条——trigger 注入整段、24 条注释合并成 6 块），再按 bullet 逐条
 * 拆。小节标题附到该节每条头上（保留语境；标题变更导致全节重嵌可接受，
 * 低频），标题语境跨空行持续到下一个标题；超长单块硬切（带重叠）。
 * 确定性纯函数。 */
export function chunkMarkdown(markdown: string): MemoryChunk[] {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const BULLET_RE = /^[-*]\s/;
  const HEADING_RE = /^(#{1,6}\s|\*\*[^\n]+\*\*$)/;

  // 逐行状态机（标题语境**跨空行持续**到下一个标题为止——review #299 边界：
  // 节内条目被空行隔开的混合形态，后续条目不丢节标题；现网数据今天虽无此
  // 形态，蒸馏 LLM 排版会漂移，趁本 PR 全量 rebuild 一并做对）：
  // 标题行更新语境；bullet 行开新条目；其余行归当前条目续行；空行（块界）
  // 结束当前条目。每条目带当前节标题落块。
  const merged: string[] = [];
  let heading: string | null = null;
  let headingUsed = true; // 无条目的孤儿标题在被替换/收尾时单独成块，不丢内容
  let cur: string | null = null;
  const flush = () => {
    if (cur !== null) {
      merged.push(heading ? `${heading}\n${cur}` : cur);
      headingUsed = true;
    }
    cur = null;
  };
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (HEADING_RE.test(line) && !BULLET_RE.test(line)) {
        flush();
        if (heading && !headingUsed) merged.push(heading);
        heading = line;
        headingUsed = false;
      } else if (BULLET_RE.test(line)) {
        flush();
        cur = line;
      } else if (cur !== null) {
        cur += `\n${line}`;
      } else {
        cur = line;
      }
    }
    flush(); // 空行=条目边界：非 bullet 散段落不跨空行粘连
  }
  if (heading && !headingUsed) merged.push(heading);

  const pieces: string[] = [];
  for (const block of merged) {
    if (block.length <= CHUNK_MAX_CHARS) {
      pieces.push(block);
      continue;
    }
    // 超长单块硬切
    let from = 0;
    while (from < block.length) {
      pieces.push(block.slice(from, from + CHUNK_MAX_CHARS));
      if (from + CHUNK_MAX_CHARS >= block.length) break;
      from += CHUNK_MAX_CHARS - CHUNK_HARD_SPLIT_OVERLAP;
    }
  }

  return pieces.map((text) => ({ text, contentHash: sha256(text), ...parseAnnotations(text) }));
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
      "INSERT INTO ai_usage (user_id, production_id, kind, model, tokens) VALUES ($1, $2, $3, $4, $5)",
      [attr.userId ?? null, attr.productionId ?? null, kind, embeddingModel(), tokens],
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

/** curated 全量重建（蒸馏写完 MEMORY.md 后调用）：同 scope 旧 curated 块
 * 删除、新块插入。embedding 缓存保证未变更条目零 API 调用。
 * provenance：curated 是模型从 owner 语料蒸馏的派生物 → origin_class
 * 'agent'（OpenClaw 的分类语义），证据会话均为 webchat 交互 → 'interactive'。 */
export async function indexCurated(scopeType: "user" | "production", scopeId: string, markdown: string): Promise<void> {
  const chunks = chunkMarkdown(markdown);
  const identityOk = await ensureIndexIdentity();
  const vectors = identityOk ? await embedWithCache(chunks, scopeAttribution(scopeType, scopeId)) : new Map<string, string>();
  if (!identityOk) {
    console.warn("[memory-index] 索引身份与配置不符，向量车道暂停——跑 scripts/memory-index-backfill.ts --rebuild 重建");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM agent_memory_chunk WHERE scope_type = $1 AND scope_id = $2 AND source = 'curated' AND NOT (content_hash = ANY($3))",
      [scopeType, scopeId, chunks.map((c) => c.contentHash)],
    );
    for (const c of chunks) {
      const vec = vectors.get(c.contentHash) ?? null;
      await client.query(
        `INSERT INTO agent_memory_chunk
           (scope_type, scope_id, source, text, text_tokens, content_hash, model, embedding,
            importance, triggers, origin_class, session_kind, observed_at, author_user_id)
         VALUES ($1, $2, 'curated', $3, $4, $5, $6, $7::vector, $8, $9, 'agent', 'interactive', now(), $10)
         ON CONFLICT (scope_type, scope_id, source, content_hash)
         DO UPDATE SET importance = EXCLUDED.importance, triggers = EXCLUDED.triggers,
                       model = COALESCE(EXCLUDED.model, agent_memory_chunk.model),
                       embedding = COALESCE(EXCLUDED.embedding, agent_memory_chunk.embedding)`,
        [
          scopeType, scopeId, c.text, tokensText(c.text), c.contentHash,
          vec ? embeddingModel() : null, vec,
          c.importance, c.triggers,
          scopeType === "user" ? scopeId : null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** episodic 单条追加（/memory-run 上报后调用）。同内容幂等（UNIQUE +
 * DO NOTHING——同一事实反复上报仍是一行，防召回回环的存储侧）。
 * provenance：用户本人 webchat 对话 → 'owner'/'interactive'。 */
export async function indexEpisodicRun(userId: string, rec: RunRecord): Promise<void> {
  const text = episodicText(rec);
  if (!text) return;
  const contentHash = sha256(text);
  const identityOk = await ensureIndexIdentity();
  const vectors = identityOk ? await embedWithCache([{ text, contentHash }], { userId }) : new Map<string, string>();
  const vec = vectors.get(contentHash) ?? null;
  const observedAt = rec.ts && !Number.isNaN(Date.parse(rec.ts)) ? rec.ts : new Date().toISOString();

  await getPool().query(
    `INSERT INTO agent_memory_chunk
       (scope_type, scope_id, source, text, text_tokens, content_hash, model, embedding,
        origin_class, session_kind, observed_at, author_user_id)
     VALUES ('user', $1, 'episodic', $2, $3, $4, $5, $6::vector, 'owner', 'interactive', $7, $8::uuid)
     ON CONFLICT (scope_type, scope_id, source, content_hash) DO NOTHING`,
    [userId, text, tokensText(text), contentHash, vec ? embeddingModel() : null, vec, observedAt, userId],
  );
}

/** 回填：补齐 embedding 为 NULL 的块（供应商恢复后/首次配 key 后）。
 * 返回本轮补齐数。 */
export async function embedMissing(limit = 200): Promise<number> {
  if (!(await ensureIndexIdentity())) {
    throw new Error("索引身份与配置不符，先 --rebuild 重建");
  }
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; text: string; content_hash: string; scope_id: string; scope_type: "user" | "production" }>(
    "SELECT id, text, content_hash, scope_id, scope_type FROM agent_memory_chunk WHERE embedding IS NULL ORDER BY created_at LIMIT $1",
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
