import { BASE_PATH } from "@/lib/base-path";
import type { AssetType } from "./types";
import type { UploadResult } from "./upload-types";

const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD = 50 * 1024 * 1024 * 1024;
const CHUNK_SIZES = [5, 16, 32, 64, 128].map(n => n << 20);
const CHUNK_DEFAULT_IDX = CHUNK_SIZES.length - 1;
const PROBE_BYTES = 512 * 1024;
const PROBE_STORED_MAX = 32 << 20;
const PROBE_TARGET_SECONDS = 15;
const CHUNK_LS_KEY = "upload_chunk_bytes_v1";
const CHUNK_LS_TTL = 60 * 60 * 1000;
const MAX_CONSECUTIVE_PART_FAILURES = 5;
const MAX_TOTAL_RETRIES = 20;
const SINGLE_PUT_ATTEMPTS = 3;
const DIRECT_LEVELS = [1, 3, 6, 8] as const;
const RELAY_LEVELS = [1, 1] as const;
const PROMOTE_AFTER = 2;
const RETRY_DELAY_MS = 1500;
const RELAY_BUSY_MS = 3000;

export type UploadControl = {
  signal: AbortSignal;
  setProgress: (progress: number | null) => void;
  setTransferMode: (mode: "direct" | "relay") => void;
  setProcessing: () => void;
};

export type AssetFileUploadInput = {
  productionId: string;
  file: File;
  assetType: AssetType;
  name: string | null;
  placementFields: Record<string, unknown>;
  targetAssetId?: string;
  purpose?: "expense_document";
};

function loadStoredChunkBytes(): number {
  try {
    const raw = localStorage.getItem(CHUNK_LS_KEY);
    if (!raw) return CHUNK_SIZES[CHUNK_DEFAULT_IDX];
    const { bytes, updatedAt } = JSON.parse(raw) as { bytes: number; updatedAt: number };
    if (Date.now() - updatedAt > CHUNK_LS_TTL) return CHUNK_SIZES[CHUNK_DEFAULT_IDX];
    return CHUNK_SIZES.includes(bytes) ? bytes : CHUNK_SIZES[CHUNK_DEFAULT_IDX];
  } catch { return CHUNK_SIZES[CHUNK_DEFAULT_IDX]; }
}

function saveChunkBytes(bytes: number): void {
  try { localStorage.setItem(CHUNK_LS_KEY, JSON.stringify({ bytes, updatedAt: Date.now() })); } catch { /* ignore */ }
}

function chunkBytesUp(current: number): number {
  const idx = CHUNK_SIZES.indexOf(current);
  return idx >= 0 && idx < CHUNK_SIZES.length - 1 ? CHUNK_SIZES[idx + 1] : current;
}

function chunkBytesDown(current: number): number {
  const idx = CHUNK_SIZES.indexOf(current);
  return idx > 0 ? CHUNK_SIZES[idx - 1] : current;
}

function abortError(): DOMException {
  return new DOMException("已取消上传", "AbortError");
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function xhrUpload(input: {
  method: "PUT" | "POST";
  url: string;
  body: Blob;
  signal: AbortSignal;
  contentType?: string;
  onProgress?: (loaded: number) => void;
  errorLabel: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) { reject(abortError()); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => {
      xhr.abort?.();
      reject(abortError());
    };
    input.signal.addEventListener("abort", abort, { once: true });
    xhr.upload.addEventListener("progress", event => {
      if (event.lengthComputable) input.onProgress?.(event.loaded);
    });
    xhr.addEventListener("load", () => {
      input.signal.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`${input.errorLabel} (${xhr.status})`));
    });
    xhr.addEventListener("error", () => {
      input.signal.removeEventListener("abort", abort);
      reject(new Error(`${input.errorLabel}（网络错误）`));
    });
    xhr.open(input.method, input.url);
    if (input.contentType) xhr.setRequestHeader("Content-Type", input.contentType);
    xhr.send(input.body);
  });
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error ?? `${fallback} (${response.status})`);
}

async function runUploadProbe(presignUrl: string, signal: AbortSignal): Promise<number> {
  const buf = new Uint8Array(PROBE_BYTES);
  crypto.getRandomValues(buf);
  const startedAt = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(presignUrl, {
      method: "PUT",
      body: new Blob([buf]),
      headers: { "Content-Type": "application/octet-stream" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("probe failed");
    const bandwidth = PROBE_BYTES / ((performance.now() - startedAt) / 1000);
    const target = bandwidth * PROBE_TARGET_SECONDS;
    const idx = CHUNK_SIZES.reduce((best, size, i) => size <= target ? i : best, 0);
    return CHUNK_SIZES[idx];
  } catch (error) {
    if (signal.aborted) throw error;
    return CHUNK_SIZES[CHUNK_DEFAULT_IDX];
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function uploadResult(body: {
  asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" };
  file: { id: string };
}): UploadResult {
  return {
    assetId: body.asset.id,
    fileId: body.file.id,
    name: body.asset.name,
    fileName: body.asset.fileName,
    assetType: body.asset.assetType,
    storageType: body.asset.storageType,
  };
}

export async function runAssetFileUpload(input: AssetFileUploadInput, control: UploadControl): Promise<UploadResult> {
  const { productionId, file, targetAssetId, purpose } = input;
  const base = `${BASE_PATH}/api/production/${productionId}/assets`;
  const mimeType = file.type || "application/octet-stream";
  const versionMode = !!targetAssetId;
  const registerUrl = versionMode ? `${base}/${targetAssetId}/files` : base;
  const assetMeta = versionMode
    ? { fileName: file.name, mimeType, fileSize: file.size }
    : {
        fileName: file.name,
        mimeType,
        fileSize: file.size,
        name: input.name,
        assetType: input.assetType,
        ...input.placementFields,
        ...(purpose ? { purpose } : {}),
      };
  const presignScope = versionMode ? { assetId: targetAssetId } : purpose ? { purpose } : {};
  let goMultipart = file.size >= MULTIPART_THRESHOLD;

  if (!goMultipart) {
    const presignResponse = await fetch(`${base}/presign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, mimeType, ...presignScope }),
      signal: control.signal,
    });
    if (!presignResponse.ok) throw await responseError(presignResponse, "预签名失败");
    const presign = await presignResponse.json() as {
      uploadUrl: string; r2Key: string; fileId: string; contentType: string;
    };

    let uploaded = false;
    for (let attempt = 0; attempt < SINGLE_PUT_ATTEMPTS && !uploaded; attempt++) {
      try {
        await xhrUpload({
          method: "PUT",
          url: presign.uploadUrl,
          body: file,
          signal: control.signal,
          contentType: presign.contentType,
          errorLabel: "R2 上传失败",
          onProgress: loaded => control.setProgress(Math.round(loaded / file.size * 100)),
        });
        uploaded = true;
      } catch (error) {
        if (control.signal.aborted) throw error;
        control.setProgress(0);
        if (attempt < SINGLE_PUT_ATTEMPTS - 1) await pause(RETRY_DELAY_MS, control.signal);
      }
    }

    if (uploaded) {
      control.setProgress(100);
      control.setProcessing();
      const registerResponse = await fetch(registerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageType: "r2", r2Key: presign.r2Key, fileId: presign.fileId, ...assetMeta,
        }),
        signal: control.signal,
      });
      if (!registerResponse.ok) throw await responseError(registerResponse, "注册失败");
      return uploadResult(await registerResponse.json());
    }
    goMultipart = true;
    control.setProgress(0);
  }

  let multipart: { uploadId: string; r2Key: string; fileId: string; abortToken: string } | null = null;
  try {
    const multipartResponse = await fetch(`${base}/presign-multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, mimeType, fileSize: file.size, ...presignScope }),
      signal: control.signal,
    });
    if (!multipartResponse.ok) throw await responseError(multipartResponse, "分段初始化失败");
    multipart = await multipartResponse.json() as {
      uploadId: string; r2Key: string; fileId: string; abortToken: string;
    };

    const storedChunk = loadStoredChunkBytes();
    let chunkBytes = storedChunk;
    const persistChunkLearning = (bytes: number) => {
      if (file.size >= MULTIPART_THRESHOLD) saveChunkBytes(bytes);
    };
    if (file.size >= MULTIPART_THRESHOLD && storedChunk < PROBE_STORED_MAX) {
      const probeResponse = await fetch(`${base}/presign-probe${purpose ? `?purpose=${purpose}` : ""}`, {
        signal: control.signal,
      });
      if (probeResponse.ok) {
        const { uploadUrl } = await probeResponse.json() as { uploadUrl: string };
        chunkBytes = await runUploadProbe(uploadUrl, control.signal);
      }
    }

    let uploadedBytes = 0;
    let useRelay = false;
    let directLevel = 0;
    let relayLevel = 0;
    let goodBatches = 0;
    let consecutivePartFailures = 0;
    let totalRetries = 0;
    let nextOffset = 0;
    let nextPart = 1;

    const presignPart = async (partNumber: number): Promise<string> => {
      const response = await fetch(
        `${base}/presign-part?r2Key=${encodeURIComponent(multipart!.r2Key)}`
        + `&uploadId=${encodeURIComponent(multipart!.uploadId)}&partNumber=${partNumber}`
        + (versionMode ? `&assetId=${encodeURIComponent(targetAssetId!)}` : "")
        + (purpose ? `&purpose=${purpose}` : ""),
        { signal: control.signal },
      );
      if (!response.ok) throw new Error(`presign-part ${partNumber} 失败 (${response.status})`);
      return ((await response.json()) as { uploadUrl: string }).uploadUrl;
    };

    const uploadOnePart = async (partNumber: number, offset: number): Promise<void> => {
      const chunk = file.slice(offset, Math.min(offset + chunkBytes, file.size));
      let tracked = 0;
      const progress = (loaded: number) => {
        uploadedBytes += loaded - tracked;
        tracked = loaded;
        control.setProgress(Math.round(uploadedBytes / file.size * 100));
      };
      const success = () => {
        uploadedBytes += chunk.size - tracked;
        tracked = chunk.size;
        control.setProgress(Math.round(uploadedBytes / file.size * 100));
      };
      const failure = () => {
        uploadedBytes -= tracked;
        tracked = 0;
        control.setProgress(Math.round(Math.max(0, uploadedBytes) / file.size * 100));
      };

      try {
        if (useRelay) {
          const relayUrl = `${base}/relay-part?r2Key=${encodeURIComponent(multipart!.r2Key)}`
            + `&uploadId=${encodeURIComponent(multipart!.uploadId)}&partNumber=${partNumber}`
            + (versionMode ? `&assetId=${encodeURIComponent(targetAssetId!)}` : "")
            + (purpose ? `&purpose=${purpose}` : "");
          await xhrUpload({
            method: "POST", url: relayUrl, body: chunk, signal: control.signal,
            contentType: "application/octet-stream",
            errorLabel: `中继 part ${partNumber} 失败`, onProgress: progress,
          });
        } else {
          await xhrUpload({
            method: "PUT", url: await presignPart(partNumber), body: chunk, signal: control.signal,
            errorLabel: `直传 part ${partNumber} 失败`, onProgress: progress,
          });
        }
        success();
      } catch (error) {
        failure();
        throw error;
      }
    };

    while (nextOffset < file.size) {
      const concurrency = (useRelay ? RELAY_LEVELS : DIRECT_LEVELS)[useRelay ? relayLevel : directLevel];
      const batch: { partNumber: number; offset: number }[] = [];
      let offset = nextOffset;
      for (let index = 0; index < concurrency && offset < file.size; index++) {
        batch.push({ partNumber: nextPart + index, offset });
        offset += Math.min(chunkBytes, file.size - offset);
      }

      const results = await Promise.allSettled(batch.map(part => uploadOnePart(part.partNumber, part.offset)));
      let committed = 0;
      while (committed < results.length && results[committed].status === "fulfilled") committed++;
      const failed = committed < batch.length;
      if (committed > 0) {
        const last = batch[committed - 1];
        nextOffset = last.offset + Math.min(chunkBytes, file.size - last.offset);
        nextPart += committed;
      }

      if (!failed) {
        consecutivePartFailures = 0;
        goodBatches++;
        if (!useRelay && goodBatches >= PROMOTE_AFTER && directLevel < DIRECT_LEVELS.length - 1) {
          directLevel++;
          goodBatches = 0;
        }
        continue;
      }

      goodBatches = 0;
      consecutivePartFailures++;
      totalRetries++;
      if (consecutivePartFailures >= MAX_CONSECUTIVE_PART_FAILURES || totalRetries >= MAX_TOTAL_RETRIES) {
        persistChunkLearning(chunkBytesDown(chunkBytes));
        throw new Error("网络环境不稳定，已自动降低分片大小，请重试");
      }

      const failedResult = results[committed] as PromiseRejectedResult;
      const failedMessage = failedResult.reason instanceof Error ? failedResult.reason.message : String(failedResult.reason);
      if (useRelay && failedMessage.includes("(503)")) {
        await pause(RELAY_BUSY_MS, control.signal);
      } else if (!useRelay && directLevel > 0) {
        directLevel--;
        await pause(RETRY_DELAY_MS, control.signal);
      } else if (!useRelay) {
        useRelay = true;
        control.setTransferMode("relay");
        await pause(RETRY_DELAY_MS, control.signal);
      } else if (relayLevel < RELAY_LEVELS.length - 1) {
        relayLevel++;
        await pause(RETRY_DELAY_MS, control.signal);
      } else {
        throw new Error("上传持续失败，服务器中转也无法完成，请检查网络后重试");
      }
    }

    control.setProgress(100);
    persistChunkLearning(totalRetries === 0 ? chunkBytesUp(chunkBytes) : chunkBytes);
    control.setProcessing();
    const registerResponse = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageType: "r2-multipart",
        uploadId: multipart.uploadId,
        r2Key: multipart.r2Key,
        fileId: multipart.fileId,
        parts: [],
        ...assetMeta,
      }),
      signal: control.signal,
    });
    if (!registerResponse.ok) throw await responseError(registerResponse, "注册失败");
    const result = uploadResult(await registerResponse.json());
    multipart = null;
    return result;
  } catch (error) {
    if (multipart) {
      await fetch(`${base}/presign-multipart`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          r2Key: multipart.r2Key,
          uploadId: multipart.uploadId,
          abortToken: multipart.abortToken,
          ...presignScope,
        }),
      }).catch(() => {});
    }
    throw error;
  }
}
