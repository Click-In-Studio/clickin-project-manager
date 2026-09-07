// 文档 IR 装载（双模式）：LRU → R2 IR → 派 doc_parse 任务短等 → 超时转后台。
//
// 解析本体在 heavy-worker 进程（2026-09 负载盘点定谳：pdfjs 同步 CPU 重活跑在
// 600M 的 agent-runner 里是 OOM 元凶，OOM 重启打断所有在跑的 run）。本模块是
// 调用方（agent-runner 里的 doc 工具）看到的唯一入口：
// - 快路径：LRU / R2 IR 命中，或任务在 DOC_PARSE_WAIT_MS 内完成——调用方无感；
// - 慢路径：超时返回 pending，同时把会话 id 补进任务 payload（requestJobSteer），
//   worker 终局后经 steerRun 插话唤醒该会话（lib/job/run.ts maybeSteer）。
// 上传侧有预热任务（lib/job/asset-jobs.ts），多数文档在被读之前 IR 已备好。

import { PDF_EXTRACTOR_VERSION, type PdfDoc } from "./pdf";
import { DOCX_EXTRACTOR_VERSION, type DocxDoc } from "./docx";
import { loadDocIr, type DocKind } from "./ir-store";
import { enqueueJob, waitForJob, getJob, requestJobSteer, type JobRow } from "@/lib/job/queue";

/** 短等窗口：预热命中后剩下的多是中小文档，30s 盖住绝大多数首解析。 */
const DOC_PARSE_WAIT_MS = Number(process.env.DOC_PARSE_WAIT_MS ?? 30_000);

const EXTRACTOR_VERSION: Record<DocKind, number> = { pdf: PDF_EXTRACTOR_VERSION, docx: DOCX_EXTRACTOR_VERSION };

// IR 比原文大，pdf 尤甚——容量沿用旧 getPdfCached/getDocxCached 的取值
const CACHE_CAP: Record<DocKind, number> = { pdf: 2, docx: 4 };
const caches: Record<DocKind, Map<string, { version: number; doc: unknown }>> = { pdf: new Map(), docx: new Map() };

function cacheGet(kind: DocKind, fileId: string): unknown | null {
  const cache = caches[kind];
  const hit = cache.get(fileId);
  if (!hit || hit.version !== EXTRACTOR_VERSION[kind]) return null;
  cache.delete(fileId);
  cache.set(fileId, hit); // LRU touch
  return hit.doc;
}

function cachePut(kind: DocKind, fileId: string, doc: unknown): void {
  const cache = caches[kind];
  cache.delete(fileId);
  cache.set(fileId, { version: EXTRACTOR_VERSION[kind], doc });
  while (cache.size > CACHE_CAP[kind]) cache.delete(cache.keys().next().value!);
}

export interface DocFileRef {
  /** asset_file 行 id（文件行不可变 ⇒ 即缓存/IR/任务的键）。 */
  fileId: string;
  r2Key: string;
  fileSize: number | null;
  fileName: string;
}

export type DocLoadResult<T> =
  | { status: "ok"; doc: T }
  | { status: "pending"; jobId: string }
  | { status: "failed"; error: string };

export function docParseDedupeKey(kind: DocKind, fileId: string): string {
  return `doc_parse:${kind}:${fileId}:v${EXTRACTOR_VERSION[kind]}`;
}

async function fromIr<T>(kind: DocKind, fileId: string): Promise<T | null> {
  const doc = await loadDocIr<T>(kind, fileId, EXTRACTOR_VERSION[kind]);
  if (doc != null) cachePut(kind, fileId, doc);
  return doc;
}

async function settle<T>(kind: DocKind, fileId: string, job: JobRow): Promise<DocLoadResult<T>> {
  if (job.status === "failed") return { status: "failed", error: job.error ?? "解析失败（未知错误）" };
  const doc = await fromIr<T>(kind, fileId);
  if (doc == null) return { status: "failed", error: "解析产物缺失（请稍后重试）" };
  return { status: "ok", doc };
}

async function loadParsedDoc<T>(
  kind: DocKind, file: DocFileRef,
  opts: { notifySessionId?: string | null } = {},
): Promise<DocLoadResult<T>> {
  const cached = cacheGet(kind, file.fileId);
  if (cached != null) return { status: "ok", doc: cached as T };

  const ir = await fromIr<T>(kind, file.fileId);
  if (ir != null) return { status: "ok", doc: ir };

  const job = await enqueueJob({
    kind: "doc_parse",
    dedupeKey: docParseDedupeKey(kind, file.fileId),
    payload: { fileId: file.fileId, r2Key: file.r2Key, fileSize: file.fileSize, fileKind: kind, fileName: file.fileName },
  });
  const finished = job.status === "done" || job.status === "failed"
    ? job
    : await waitForJob(job.id, DOC_PARSE_WAIT_MS);
  if (finished) return settle<T>(kind, file.fileId, finished);

  // 超时转后台：登记唤醒会话，再核对一次终局（与完成擦肩时直接给结果，不让模型空等）
  if (opts.notifySessionId) await requestJobSteer(job.id, opts.notifySessionId).catch(() => {});
  const recheck = await getJob(job.id);
  if (recheck && (recheck.status === "done" || recheck.status === "failed")) return settle<T>(kind, file.fileId, recheck);
  return { status: "pending", jobId: job.id };
}

export const loadParsedPdf = (file: DocFileRef, opts?: { notifySessionId?: string | null }) =>
  loadParsedDoc<PdfDoc>("pdf", file, opts);

export const loadParsedDocx = (file: DocFileRef, opts?: { notifySessionId?: string | null }) =>
  loadParsedDoc<DocxDoc>("docx", file, opts);

/** 测试用：清空进程内 LRU。 */
export function clearDocCachesForTests(): void {
  caches.pdf.clear();
  caches.docx.clear();
}
