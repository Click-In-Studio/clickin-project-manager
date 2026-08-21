// Embedding 客户端（记忆检索向量车道）。
//
// 供应商拍板记录（2026-08-21）：DashScope text-embedding-v4（Qwen3-Embedding），
// OpenAI-compatible /v1/embeddings 端点，MRL 截断 1024 维——语料全中文，Qwen3
// 是当前中文检索最强档；成本量级见 MindWeave《OpenClaw记忆检索机制调研与移植
// 设计》§4.2（悲观口径每月几十块，不构成定价压力）。
//
// 语义要点（照抄 OpenClaw 的两条纪律）：
// 1. fail-closed：显式配置了供应商但请求失败 → 抛 EmbeddingUnavailableError，
//    调用方明确报"记忆检索不可用"，绝不静默退化成纯关键词（坏配置必须可见）。
//    未配置（无 key）与显式 EMBEDDING_PROVIDER=none 才是合法的纯关键词模式。
// 2. 非对称 instruct：Qwen3-Embedding 是 instruct 型模型，查询侧带任务指令
//    前缀、文档侧不带（对应 OpenClaw 的 queryInputType/documentInputType）。
//
// EMBEDDING_PROVIDER 取值：
//   dashscope（默认，需 EMBEDDING_API_KEY）| none（纯关键词）| fake（测试：
//   由内容 hash 决定性生成向量，零网络）

import { createHash } from "node:crypto";

/** 索引身份的一半：模型名。换模型 = 全量重建（见 agent_memory_index_meta）。 */
export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL ?? "text-embedding-v4";
}

/** 索引身份的另一半：维度。DDL 钉死 vector(1024)，改这里必须同步改表。 */
export const EMBEDDING_DIM = 1024;

/** DashScope 单请求批量上限（text-embedding-v4 实限 10 条）。 */
const BATCH_SIZE = 10;

const REQUEST_TIMEOUT_MS = 15_000;

/** Qwen3-Embedding 官方推荐的检索任务查询指令（文档侧不加）。 */
const QUERY_INSTRUCT =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export type EmbeddingProviderMode = "dashscope" | "none" | "fake";

/** 解析生效的供应商模式。无 key 且未显式配置 → none（纯关键词，合法降级）；
 * 显式 dashscope 但无 key → 配置错误，按 fail-closed 处理（调用时抛）。 */
export function embeddingMode(): EmbeddingProviderMode {
  const p = process.env.EMBEDDING_PROVIDER;
  if (p === "none" || p === "fake") return p;
  if (p === "dashscope") return "dashscope";
  if (p) throw new EmbeddingUnavailableError(`未知 EMBEDDING_PROVIDER: ${p}`);
  return process.env.EMBEDDING_API_KEY ? "dashscope" : "none";
}

export type EmbedResult = { embeddings: number[][]; totalTokens: number };

/** 文档侧批量嵌入（索引写入用）。texts 任意长度，内部按 BATCH_SIZE 分批。 */
export async function embedDocuments(texts: string[]): Promise<EmbedResult> {
  return embedBatch(texts, false);
}

/** 查询侧嵌入（带 instruct 前缀）。 */
export async function embedQuery(text: string): Promise<{ embedding: number[]; totalTokens: number }> {
  const r = await embedBatch([QUERY_INSTRUCT + text], true);
  return { embedding: r.embeddings[0], totalTokens: r.totalTokens };
}

async function embedBatch(texts: string[], isQuery: boolean): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0 };
  const mode = embeddingMode();
  if (mode === "none") {
    throw new EmbeddingUnavailableError("embedding 未配置（EMBEDDING_PROVIDER=none 或缺 EMBEDDING_API_KEY）");
  }
  if (mode === "fake") return fakeEmbed(texts);

  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey) throw new EmbeddingUnavailableError("EMBEDDING_PROVIDER=dashscope 但 EMBEDDING_API_KEY 未设置");
  const baseUrl = process.env.EMBEDDING_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: embeddingModel(),
          input: batch,
          dimensions: EMBEDDING_DIM,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EmbeddingUnavailableError(`embedding 请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new EmbeddingUnavailableError(`embedding API ${res.status}：${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
      usage?: { total_tokens?: number };
    };
    const data = json.data;
    if (!data || data.length !== batch.length) {
      throw new EmbeddingUnavailableError(`embedding 响应条数不符：期望 ${batch.length} 实得 ${data?.length ?? 0}`);
    }
    // 按 index 归位（OpenAI-compatible 协议不保证顺序）
    const ordered = [...data].sort((a, b) => a.index - b.index);
    for (const d of ordered) {
      if (!Array.isArray(d.embedding) || d.embedding.length !== EMBEDDING_DIM) {
        throw new EmbeddingUnavailableError(
          `embedding 维度不符：期望 ${EMBEDDING_DIM} 实得 ${d.embedding?.length ?? 0}（检查模型是否支持 dimensions 参数）`,
        );
      }
      embeddings.push(d.embedding);
    }
    totalTokens += json.usage?.total_tokens ?? 0;
  }
  // isQuery 仅影响调用方的用量记账 kind，这里不区分
  void isQuery;
  return { embeddings, totalTokens };
}

/** 测试替身：由内容 sha256 决定性展开成单位向量。同文本恒同向量（可测
 * "相同内容向量命中"与幂等），不同文本近似正交（不承诺语义相似度）。
 * 查询侧的 instruct 前缀在哈希前剥掉——否则「同文本」的查询/文档向量
 * 不一致，向量车道在测试里永远测不到命中。 */
function fakeEmbed(texts: string[]): EmbedResult {
  const embeddings = texts.map((raw) => {
    const t = raw.startsWith(QUERY_INSTRUCT) ? raw.slice(QUERY_INSTRUCT.length) : raw;
    const v: number[] = [];
    let seed = createHash("sha256").update(t).digest();
    while (v.length < EMBEDDING_DIM) {
      for (let i = 0; i + 4 <= seed.length && v.length < EMBEDDING_DIM; i += 4) {
        v.push((seed.readInt32BE(i) / 0x7fffffff) * 0.5);
      }
      seed = createHash("sha256").update(seed).digest();
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
  return { embeddings, totalTokens: 0 };
}
