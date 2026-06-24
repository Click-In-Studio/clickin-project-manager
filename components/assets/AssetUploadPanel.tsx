"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AssetType } from "@/lib/asset-db";
import { BASE_PATH } from "@/lib/base-path";

// R2 single PUT max is 5 GiB; use multipart for anything above 50 MB
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
// Files above this should be transferred by other means (rsync, rclone, etc.)
const MAX_BROWSER_UPLOAD = 50 * 1024 * 1024 * 1024; // 50 GB
// S3/R2 multipart rule: ALL non-trailing parts MUST be exactly the same size.
// Chunk size must therefore be fixed for the entire upload — only concurrency adapts.
const MULTIPART_CHUNK_BYTES = 16 << 20; // 16 MB per part, fixed
// Adaptive upload levels — only concurrency changes; chunk size is always MULTIPART_CHUNK_BYTES.
//
// Direct path (client → R2): starts at level 0, promotes after PROMOTE_AFTER
// consecutive fully-successful batches, demotes on any batch failure.
// Reaching level 0 with another failure → switch to relay.
const DIRECT_LEVELS: readonly { concurrency: number }[] = [
  { concurrency: 1 },  // level 0 — start / degraded
  { concurrency: 3 },  // level 1 — stable
  { concurrency: 6 },  // level 2 — fast
  { concurrency: 8 },  // level 3 — max throughput
];
// Relay path (client → server → R2): starts at level 0; only concurrency shrinks.
const RELAY_LEVELS: readonly { concurrency: number }[] = [
  { concurrency: 1 },  // relay level 0
  { concurrency: 1 },  // relay level 1 — degraded (placeholder for future tuning)
];
const PROMOTE_AFTER     = 2;     // consecutive fully-successful batches to level up
const RETRY_DELAY_MS    = 1500;  // pause before retry after a direct failure
const RELAY_BUSY_MS     = 3000;  // pause on relay 503

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

type UploadMode = "file" | "feishu";

export type UploadResult = {
  assetId: string;
  name: string | null;
  fileName: string;
  assetType: AssetType;
  storageType: "r2" | "feishu_link";
};

interface Props {
  productionId: string;
  versionId?: string | null;
  onUploaded: (result: UploadResult) => void;
  onCancel?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function AssetUploadPanel({ productionId, versionId, onUploaded, onCancel }: Props) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [assetType, setAssetType] = useState<AssetType>("reference");
  const [name, setName] = useState("");
  const [isUniversal, setIsUniversal] = useState(true);
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuName, setFeishuName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [transferMode, setTransferMode] = useState<"direct" | "relay">("direct");
  const fileRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0); // track nested dragenter/dragleave to avoid flicker

  const pickFile = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    if (incoming.length > 1) {
      setError("单次只能上传单个文件");
      return;
    }
    setError(null);
    setFile(incoming[0]);
  }, []);

  // Global paste listener — active only in file mode and when not loading
  useEffect(() => {
    if (mode !== "file" || loading) return;
    function onPaste(e: ClipboardEvent) {
      // Ignore paste into text inputs / textareas
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const files = e.clipboardData?.files ?? null;
      if (!files || files.length === 0) return;
      e.preventDefault();
      pickFile(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [mode, loading, pickFile]);

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault(); // required to allow drop
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    pickFile(e.dataTransfer.files);
  }

  async function handleSubmit() {
    setError(null);
    setLoading(true);
    setProgress(null);
    setTransferMode("direct");
    try {
      const base = `${BASE_PATH}/api/production/${productionId}/assets`;

      if (mode === "feishu") {
        if (!feishuUrl.trim() || !feishuName.trim()) {
          setError("请填写飞书链接和文件名");
          return;
        }
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageType: "feishu_link",
            feishuUrl: feishuUrl.trim(),
            fileName: feishuName.trim(),
            name: name.trim() || null,
            assetType,
            isUniversal,
            versionId: isUniversal ? null : (versionId ?? null),
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `上传失败 (${res.status})`);
          return;
        }
        const j = await res.json() as { asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" } };
        onUploaded({ assetId: j.asset.id, name: j.asset.name, fileName: j.asset.fileName, assetType: j.asset.assetType, storageType: j.asset.storageType });
        return;
      }

      // ── Direct R2 upload via presigned URL ───────────────────────────────
      if (!file) { setError("请选择文件"); return; }
      if (file.size > MAX_BROWSER_UPLOAD) {
        setError(`文件超过 50 GB 限制（${formatSize(file.size)}），请使用 rclone / rsync 等工具直传 R2`);
        return;
      }

      const mimeType = file.type || "application/octet-stream";
      const assetMeta = {
        fileName: file.name, mimeType, fileSize: file.size,
        name: name.trim() || null, assetType, isUniversal,
        versionId: isUniversal ? null : (versionId ?? null),
      };

      let r2Key: string, fileId: string;

      if (file.size < MULTIPART_THRESHOLD) {
        // ── Single presigned PUT ────────────────────────────────────────────
        const presignRes = await fetch(`${base}/presign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, mimeType }),
        });
        if (!presignRes.ok) {
          const j = await presignRes.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `预签名失败 (${presignRes.status})`);
          return;
        }
        const presign = await presignRes.json() as { uploadUrl: string; r2Key: string; fileId: string; contentType: string };
        r2Key = presign.r2Key; fileId = presign.fileId;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener("progress", e => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          });
          xhr.addEventListener("load", () => {
            xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 上传失败 (${xhr.status})`));
          });
          xhr.addEventListener("error", () => reject(new Error("网络错误")));
          xhr.open("PUT", presign.uploadUrl);
          xhr.setRequestHeader("Content-Type", presign.contentType);
          xhr.send(file);
        });
        setProgress(100);

        const regRes = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storageType: "r2", r2Key, fileId, ...assetMeta }),
        });
        if (!regRes.ok) {
          const j = await regRes.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `注册失败 (${regRes.status})`);
          return;
        }
        const regJ = await regRes.json() as { asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" } };
        onUploaded({ assetId: regJ.asset.id, name: regJ.asset.name, fileName: regJ.asset.fileName, assetType: regJ.asset.assetType, storageType: regJ.asset.storageType });
      } else {
        // ── Adaptive multipart upload ────────────────────────────────────────
        // Chunk size and concurrency are co-scheduled via DIRECT_LEVELS /
        // RELAY_LEVELS. Each iteration:
        //   - Build a batch of `concurrency` segments starting at nextOffset
        //   - Promise.allSettled — commit only the leading contiguous successes
        //   - Full batch success → promote (level up); any failure → demote
        //   - Direct level 0 + failure → switch to relay
        // Orphaned R2 parts (non-leading successes from a failed batch) are
        // never referenced in CompleteMultipartUpload and are discarded by R2.

        const mpRes = await fetch(`${base}/presign-multipart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No partCount — adaptive caller fetches per-part URLs on demand
          body: JSON.stringify({ fileName: file.name, mimeType, fileSize: file.size }),
        });
        if (!mpRes.ok) {
          const j = await mpRes.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `分段初始化失败 (${mpRes.status})`);
          return;
        }
        const mp = await mpRes.json() as { uploadId: string; r2Key: string; fileId: string };
        r2Key = mp.r2Key; fileId = mp.fileId;

        // ── Adaptive state ──────────────────────────────────────────────────
        // ETags are collected server-side via listMultipartParts — the browser
        // cannot read the ETag response header from cross-origin R2 requests
        // (Access-Control-Expose-Headers does not include ETag on this bucket).
        let uploadedBytes = 0;
        let useRelay  = false;
        let directLvl = 0;
        let relayLvl  = 0;
        let goodBatches = 0;   // consecutive fully-successful batches
        let nextOffset  = 0;
        let nextPart    = 1;

        const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

        // On-demand presigned URL for direct upload
        const presignPart = async (partNumber: number): Promise<string> => {
          const res = await fetch(
            `${base}/presign-part?r2Key=${encodeURIComponent(mp.r2Key)}`
            + `&uploadId=${encodeURIComponent(mp.uploadId)}&partNumber=${partNumber}`
          );
          if (!res.ok) throw new Error(`presign-part ${partNumber} 失败 (${res.status})`);
          return ((await res.json()) as { uploadUrl: string }).uploadUrl;
        };

        // Upload one chunk; resolves on success, updates progress
        const uploadOnePart = (partNumber: number, offset: number, chunkBytes: number): Promise<void> => {
          const chunk = file.slice(offset, Math.min(offset + chunkBytes, file.size));
          let tracked = 0;

          const onProgress = (loaded: number) => {
            uploadedBytes += loaded - tracked;
            tracked = loaded;
            setProgress(Math.round(uploadedBytes / file.size * 100));
          };
          const onSuccess = () => {
            // Reconcile: ensure chunk.size bytes are counted
            uploadedBytes += chunk.size - tracked;
            tracked = chunk.size;
            setProgress(Math.round(uploadedBytes / file.size * 100));
          };
          const onFail = () => {
            uploadedBytes -= tracked;
            tracked = 0;
            setProgress(Math.round(Math.max(0, uploadedBytes) / file.size * 100));
          };

          if (useRelay) {
            const relayUrl = `${base}/relay-part`
              + `?r2Key=${encodeURIComponent(mp.r2Key)}`
              + `&uploadId=${encodeURIComponent(mp.uploadId)}`
              + `&partNumber=${partNumber}`;
            return new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.upload.addEventListener("progress", e => { if (e.lengthComputable) onProgress(e.loaded); });
              xhr.addEventListener("load", () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  onSuccess();
                  resolve();
                } else {
                  onFail();
                  const err = new Error(`中继 part ${partNumber} 失败 (${xhr.status})`);
                  if (xhr.status === 503) (err as Error & { relay503?: boolean }).relay503 = true;
                  reject(err);
                }
              });
              xhr.addEventListener("error", () => { onFail(); reject(new Error(`中继 part ${partNumber} 网络错误`)); });
              xhr.open("POST", relayUrl);
              xhr.setRequestHeader("Content-Type", "application/octet-stream");
              xhr.send(chunk);
            });
          } else {
            return presignPart(partNumber).then(uploadUrl =>
              new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.upload.addEventListener("progress", e => { if (e.lengthComputable) onProgress(e.loaded); });
                xhr.addEventListener("load", () => {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    onSuccess();
                    resolve();
                  } else {
                    onFail();
                    reject(new Error(`直传 part ${partNumber} 失败 (${xhr.status})`));
                  }
                });
                xhr.addEventListener("error", () => { onFail(); reject(new Error(`直传 part ${partNumber} 网络错误`)); });
                xhr.open("PUT", uploadUrl);
                xhr.send(chunk);
              })
            );
          }
        };

        // ── Main adaptive loop ──────────────────────────────────────────────
        while (nextOffset < file.size) {
          const { concurrency } = (useRelay ? RELAY_LEVELS : DIRECT_LEVELS)[
            useRelay ? relayLvl : directLvl
          ];
          const chunkBytes = MULTIPART_CHUNK_BYTES; // fixed for the entire upload

          // Build batch segments starting from nextOffset
          const batch: { partNumber: number; offset: number }[] = [];
          {
            let off = nextOffset;
            for (let i = 0; i < concurrency && off < file.size; i++) {
              batch.push({ partNumber: nextPart + i, offset: off });
              off += Math.min(chunkBytes, file.size - off);
            }
          }

          const results = await Promise.allSettled(
            batch.map(({ partNumber, offset }) => uploadOnePart(partNumber, offset, chunkBytes))
          );

          // Count leading (front-contiguous) successes only
          let nCommitted = 0;
          for (; nCommitted < results.length; nCommitted++) {
            if (results[nCommitted].status !== "fulfilled") break;
          }
          const anyFailed = nCommitted < batch.length;

          // Advance past committed parts
          if (nCommitted > 0) {
            const last = batch[nCommitted - 1];
            nextOffset = last.offset + Math.min(chunkBytes, file.size - last.offset);
            nextPart  += nCommitted;
          }

          if (!anyFailed) {
            // Full batch success — maybe promote
            goodBatches++;
            if (!useRelay && goodBatches >= PROMOTE_AFTER && directLvl < DIRECT_LEVELS.length - 1) {
              directLvl++;
              goodBatches = 0;
            }
          } else {
            goodBatches = 0;
            const failErr = (results[nCommitted] as PromiseRejectedResult).reason as Error & { relay503?: boolean };

            if (useRelay && failErr?.relay503) {
              // Relay slot busy — wait, retry at same level
              await pause(RELAY_BUSY_MS);
            } else if (!useRelay) {
              if (directLvl > 0) {
                directLvl--;            // shrink direct chunk/concurrency
                await pause(RETRY_DELAY_MS);
              } else {
                useRelay = true;        // direct exhausted → relay
                setTransferMode("relay");
                await pause(RETRY_DELAY_MS);
              }
            } else {
              // Relay non-503 failure — shrink relay chunk
              if (relayLvl < RELAY_LEVELS.length - 1) {
                relayLvl++;
                await pause(RETRY_DELAY_MS);
              } else {
                throw new Error("上传持续失败，服务器中转也无法完成，请检查网络后重试");
              }
            }
          }
        }

        setProgress(100);

        const regRes = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageType: "r2-multipart",
            uploadId: mp.uploadId, r2Key, fileId,
            // ETags collected server-side via listMultipartParts; parts: [] passes
            // the Array.isArray guard while carrying no data.
            parts: [],
            ...assetMeta,
          }),
        });
        if (!regRes.ok) {
          const j = await regRes.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `注册失败 (${regRes.status})`);
          return;
        }
        const regJ = await regRes.json() as { asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" } };
        onUploaded({ assetId: regJ.asset.id, name: regJ.asset.name, fileName: regJ.asset.fileName, assetType: regJ.asset.assetType, storageType: regJ.asset.storageType });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-zinc-200 text-xs">
        {(["file", "feishu"] as UploadMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2 font-medium transition-colors ${
              mode === m ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
            }`}>
            {m === "file" ? "上传文件" : "飞书链接"}
          </button>
        ))}
      </div>

      {mode === "file" ? (
        <div>
          <div
            onClick={() => fileRef.current?.click()}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-8 cursor-pointer transition-colors ${
              dragOver
                ? "border-zinc-500 bg-zinc-50"
                : "border-zinc-200 hover:border-zinc-400"
            }`}>
            {file ? (
              <>
                <p className="text-sm font-medium text-zinc-700">{file.name}</p>
                <p className="text-xs text-zinc-400">{formatSize(file.size)}</p>
              </>
            ) : dragOver ? (
              <>
                <p className="text-sm text-zinc-500">松开以选择文件</p>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-400">点击、拖拽或粘贴文件</p>
                <p className="text-xs text-zinc-300">支持所有格式，图片自动生成缩略图</p>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" className="hidden"
            onChange={e => pickFile(e.target.files)} />
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            placeholder="飞书 Wiki 节点链接"
            value={feishuUrl}
            onChange={e => setFeishuUrl(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
          <input
            type="text"
            placeholder="文件名（必填）"
            value={feishuName}
            onChange={e => setFeishuName(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {/* Display name */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">显示名称（可选，留空则使用文件名）</label>
        <input
          type="text"
          placeholder={file?.name ?? (feishuName || "例：幕前幕后音响设计图纸 v3")}
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
        />
      </div>

      {/* Asset type */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">类型</label>
        <select
          value={assetType}
          onChange={e => setAssetType(e.target.value as AssetType)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 bg-white">
          {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][]).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      {/* Version scope */}
      {versionId && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!isUniversal} onChange={e => setIsUniversal(!e.target.checked)}
            className="rounded" />
          <span className="text-xs text-zinc-600">绑定到当前版本</span>
        </label>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* Upload progress bar */}
      {progress !== null && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-800 transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          {transferMode === "relay" && (
            <p className="text-xs text-amber-600">⚠ 直传受阻，已切换至服务器中转</p>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button onClick={onCancel} disabled={loading}
            className="flex-1 rounded-lg border border-zinc-200 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors">
            取消
          </button>
        )}
        <button onClick={handleSubmit} disabled={loading}
          className="flex-1 rounded-lg bg-zinc-800 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors">
          {loading
            ? progress !== null && progress < 100
              ? `上传中 ${progress}%`
              : "处理中…"
            : "确认上传"}
        </button>
      </div>
    </div>
  );
}
