// ocr.structured 任务的薄封装（#453：MMP 接入首例）。调用方给「公网可达的媒体 URL +
// 页码 + 档位」，拿回按页的识别结果与计费真值；失败分两类如实回报，不抛给模型。
//
// 纪律（接入指南 §5）：
// - 媒体句柄用 `refOr(media_id, get(url))`：同一文件第二次起不再让算力节点重新下载，
//   ref 过期时服务端自动退回 URL 重取。media_id 是内容 hash，进程内按文件行缓存即可；
// - 快档 / 慢档由调用方选：快档某页 `flags` 非空或 `suggest_upgrade_pages` 有页，再对
//   那些页提 `tier: "gpu"`——服务不自动升级，升不升是我们（最终是模型）的决定；
// - `shouldFallback` 的错误（节点离线 / 超时 / 背压）= 服务不可用，调用方显式标注降级，
//   不静默吞；其余错误（bad_request / engine_failed）如实报错码；
// - 计费真值取 `timings_ms` 的推理阶段（render + ocr），不含媒体下载（fetch）、排队与
//   引擎冷启动（实测首次 total 44s 而 ocr 0.8s）。缺 timings 时按页数估算并标记，
//   #618 等 MMP 标准化 `compute` 键后切过去。

import { MmpError, media, type MmpClient } from "@mmp/client";
import { getMmpClient } from "./client";

export type OcrTier = "gpu-fast" | "gpu";
export type OcrFlag = "low_confidence" | "coverage_anomaly" | "empty";

export interface OcrPage {
  page: number;
  tier: OcrTier;
  /** 阅读顺序拼接的纯文本（快档来自行、慢档来自 markdown）。 */
  text: string;
  lines?: Array<{ text: string; score: number }>;
  quality: { lines: number; chars: number; mean_score?: number; low_conf_ratio?: number; coverage?: number };
  flags: OcrFlag[];
  /** 慢档才有：版面结构。 */
  markdown?: string;
  elements?: Array<{ type: string; text: string }>;
}

export type OcrOutcome =
  | {
      status: "ok";
      pages: OcrPage[];
      pageCount: number;
      suggestUpgradePages: number[];
      cached: boolean;
      tier: OcrTier;
      engine: string;
      /** 可计费推理毫秒（cached 时为 0）。 */
      computeMs: number;
      /** timings 缺失、按页估算的（打日志，不该是常态）。 */
      computeEstimated: boolean;
      mediaId: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
      /** true = 服务不可用（离线 / 超时 / 背压），该走兜底并显式标注；false = 本次请求本身有问题。 */
      unavailable: boolean;
    };

/** 冷启动实测 ~40s + 慢档 ~9s/页 × 单次页数上限，4 分钟盖得住；再长就是服务的问题。 */
const RUN_TIMEOUT_MS = 4 * 60_000;
const POLL_WAIT_SEC = 30;
/** 缺 timings 时的估算（#618 首版兜底）：快档 1 s/页、慢档 6 s/页。 */
const ESTIMATE_MS_PER_PAGE: Record<OcrTier, number> = { "gpu-fast": 1000, gpu: 6000 };

/** 文件行 → media_id（内容 hash）。文件行不可变，键即文件行 id；进程重启丢了也只是多下载一次。 */
const mediaIdByFile = new Map<string, string>();
const MEDIA_ID_CAP = 500;

function rememberMediaId(fileId: string, mediaId: string): void {
  mediaIdByFile.delete(fileId);
  mediaIdByFile.set(fileId, mediaId);
  while (mediaIdByFile.size > MEDIA_ID_CAP) mediaIdByFile.delete(mediaIdByFile.keys().next().value!);
}

/** 可计费推理毫秒：render（PDF 栅格化）+ ocr。键名是引擎私有的，#618 切标准键。 */
export function billableMsOf(timings: Record<string, number> | undefined, tier: OcrTier, pageCount: number): { ms: number; estimated: boolean } {
  if (timings && (typeof timings.ocr === "number" || typeof timings.render === "number")) {
    return { ms: Math.max(0, Math.round((timings.render ?? 0) + (timings.ocr ?? 0))), estimated: false };
  }
  return { ms: pageCount * ESTIMATE_MS_PER_PAGE[tier], estimated: true };
}

export async function ocrPages(
  input: {
    /** 缓存键（asset_file 行 id）。 */
    fileId: string;
    /** 公网可达的媒体 URL（R2 预签名）。算力节点在别的网络，内网地址拉不到。 */
    url: string;
    pages: number[];
    tier: OcrTier;
    lang?: "ch" | "en";
  },
  opts: { client?: MmpClient | null; signal?: AbortSignal } = {},
): Promise<OcrOutcome> {
  const client = opts.client === undefined ? getMmpClient() : opts.client;
  if (!client) return { status: "error", code: "not_configured", message: "MMP 服务未配置", unavailable: true };

  const known = mediaIdByFile.get(input.fileId);
  const handle = known ? media.refOr(known, media.get(input.url)) : media.get(input.url);
  const pages = [...new Set(input.pages.map((p) => Math.floor(p)).filter((p) => p >= 1))].sort((a, b) => a - b);
  try {
    const done = await client.run(
      { type: "ocr.structured", media: handle, tier: input.tier, params: { pages, lang: input.lang ?? "ch" } },
      { pollWaitSec: POLL_WAIT_SEC, timeoutMs: RUN_TIMEOUT_MS, signal: opts.signal },
    );
    rememberMediaId(input.fileId, done.media_id);
    const result = (done.result ?? {}) as {
      page_count?: number;
      pages?: OcrPage[];
      suggest_upgrade_pages?: number[];
      timings_ms?: Record<string, number>;
    };
    const resultPages = Array.isArray(result.pages) ? result.pages : [];
    const timings = done.timings_ms ?? result.timings_ms;
    const billable = done.cached ? { ms: 0, estimated: false } : billableMsOf(timings, input.tier, resultPages.length);
    if (billable.estimated) console.warn(`[mmp] ocr.structured 响应缺 timings_ms，按 ${resultPages.length} 页估算计费（job ${done.job_id}）`);
    return {
      status: "ok",
      pages: resultPages,
      pageCount: typeof result.page_count === "number" ? result.page_count : resultPages.length,
      suggestUpgradePages: Array.isArray(result.suggest_upgrade_pages) ? result.suggest_upgrade_pages : [],
      cached: done.cached,
      tier: input.tier,
      engine: String((done.source as { engine?: string } | undefined)?.engine ?? ""),
      computeMs: billable.ms,
      computeEstimated: billable.estimated,
      mediaId: done.media_id,
    };
  } catch (e) {
    if (e instanceof MmpError) {
      return { status: "error", code: e.code, message: e.message, unavailable: e.shouldFallback };
    }
    throw e;
  }
}

/** 测试用：清 media_id 缓存。 */
export function clearMmpMediaCacheForTests(): void {
  mediaIdByFile.clear();
}
