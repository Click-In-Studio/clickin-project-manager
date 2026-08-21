// 触发注入（trigger recall）——OpenClaw Lane 1 的第三机制移植。
//
// 每条入站消息对 curated 条目的 trigger 短语跑词法+向量预过滤：
//   score = max(词法分, 向量分) ≥ 0.72 → 候选，取 top 3
// - 词法分：trigger 短语的 bigram 在消息中的命中占比（短语出现在消息里≈1）
// - 向量分：消息 embedding 与**条目自身** embedding 的余弦——复用已存向量，
//   不为 trigger 短语单独建向量（OpenClaw 文档：预过滤复用既有检索通路）
// - **仅 curated**：episodic 永不自动注入是安全属性不是调参项（SQL 强制）
// - 注入路径纪律：任何失败（embedding 挂/DB 慢）都静默降级或返回空，
//   绝不阻塞回复（OpenClaw 设计原则五）；与 memory_search 的 fail-closed
//   不同——工具失败要可见，注入失败只能少注入不能断轮次。
//
// 阈值/上限为 OpenClaw 文档值：0.72、每轮 ≤3。

import { createHash } from "node:crypto";
import { getPool } from "@/lib/pg";
import { EmbeddingUnavailableError, embedQuery, embeddingMode, embeddingModel } from "@/agent/embedding";
import { bigramTokens, ensureIndexIdentity } from "./index-db";

export const TRIGGER_THRESHOLD = 0.72;
export const TRIGGER_MAX_PER_TURN = 3;
/** 触发注入面向"简短提醒"，单条截断防挤占正文预算。 */
const TRIGGER_SNIPPET_MAX = 300;
/** 候选上限（防单用户 curated 条目失控时全表进 JS 评分）。带向量时按
 * vscore 排序后再截，确保截掉的是最不相似的尾部（review #298 finding 1：
 * 无序 LIMIT 是任意子集）；纯词法时按最新优先——词法分在 JS 算，SQL 里
 * 没有可排的信号，新近条目优先进候选是最不坏的确定性选择。 */
const TRIGGER_CANDIDATE_LIMIT = 200;

export type TriggerHit = { id: string; text: string; score: number };

type CandidateRow = {
  id: string;
  text: string;
  triggers: string;
  vscore: number | null;
};

/** trigger 短语词法分：短语 bigram 在消息 token 集中的命中占比。 */
function lexicalScore(phrase: string, promptTokens: Set<string>): number {
  const toks = bigramTokens(phrase);
  if (toks.length === 0) return 0;
  let hit = 0;
  for (const t of toks) if (promptTokens.has(t)) hit++;
  return hit / toks.length;
}

export async function triggerRecall(userId: string, prompt: string): Promise<TriggerHit[]> {
  try {
    const pool = getPool();

    // 向量分可用性：embedding 未配/身份不符/请求失败 → 静默退词法单路
    let promptVec: string | null = null;
    if (embeddingMode() !== "none" && (await ensureIndexIdentity())) {
      try {
        const q = await embedQuery(prompt);
        promptVec = `[${q.embedding.join(",")}]`;
        if (q.totalTokens > 0) {
          pool
            .query("INSERT INTO ai_usage (user_id, kind, model, tokens) VALUES ($1, 'embedding_query', $2, $3)", [
              userId, embeddingModel(), q.totalTokens,
            ])
            .catch((e) => console.error("[trigger-recall] 用量记账失败（忽略）:", e));
        }
      } catch (err) {
        if (!(err instanceof EmbeddingUnavailableError)) throw err;
        // 注入路径不 fail-closed：少一路信号而已
      }
    }

    const { rows } = await pool.query<CandidateRow>(
      `SELECT id, text, triggers,
              ${promptVec ? "CASE WHEN embedding IS NULL THEN NULL ELSE 1 - (embedding <=> $3::vector) END" : "NULL"} AS vscore
       FROM agent_memory_chunk
       WHERE scope_type = 'user' AND scope_id = $1 AND source = 'curated'
         AND triggers IS NOT NULL
       ORDER BY ${promptVec ? "vscore DESC NULLS LAST" : "observed_at DESC"}
       LIMIT $2`,
      promptVec ? [userId, TRIGGER_CANDIDATE_LIMIT, promptVec] : [userId, TRIGGER_CANDIDATE_LIMIT],
    );
    if (rows.length === 0) return [];

    const promptTokens = new Set(bigramTokens(prompt));
    const scored: TriggerHit[] = [];
    for (const row of rows) {
      let lex = 0;
      for (const phrase of row.triggers.split(/[,;，；]/)) {
        const p = phrase.trim();
        if (!p) continue;
        lex = Math.max(lex, lexicalScore(p, promptTokens));
      }
      const score = Math.max(lex, Number(row.vscore ?? 0));
      if (score < TRIGGER_THRESHOLD) continue;
      const text = row.text.length > TRIGGER_SNIPPET_MAX ? `${row.text.slice(0, TRIGGER_SNIPPET_MAX)}…` : row.text;
      scored.push({ id: row.id, text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, TRIGGER_MAX_PER_TURN);

    // 触发命中也是召回信号（Phase B 晋升门的频次/多样性统计）
    if (top.length > 0) {
      const queryHash = createHash("sha256").update(`trigger:${prompt}`).digest("hex").slice(0, 32);
      Promise.all(
        top.map((h) =>
          pool.query("INSERT INTO agent_memory_recall_log (chunk_id, user_id, query_hash) VALUES ($1, $2, $3)", [
            h.id, userId, queryHash,
          ]),
        ),
      ).catch((err) => console.error("[trigger-recall] 召回记账失败（忽略）:", err));
    }
    return top;
  } catch (err) {
    // 注入路径兜底：任何异常=本轮没有触发注入，不影响回复
    console.error("[trigger-recall] 触发召回异常（按无命中降级）:", err);
    return [];
  }
}
