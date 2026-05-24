"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AssetType } from "@/lib/asset-db";
import { BASE_PATH } from "@/lib/base-path";

// R2 single PUT max is 5 GiB; use multipart for anything above 50 MB
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
// Files above this should be transferred by other means (rsync, rclone, etc.)
const MAX_BROWSER_UPLOAD = 50 * 1024 * 1024 * 1024; // 50 GB
const CONCURRENCY = 5;

// Target ≤200 parts; clamp part size between 50 MB and 5 GB (R2 hard max per part)
function calcPartSize(fileSize: number): number {
  const MIN = 50 * 1024 * 1024;
  const MAX = 5 * 1024 * 1024 * 1024;
  return Math.min(MAX, Math.max(MIN, Math.ceil(fileSize / 200)));
}

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
        // ── Multipart upload ────────────────────────────────────────────────
        const partSize = calcPartSize(file.size);
        const partCount = Math.ceil(file.size / partSize);

        const mpRes = await fetch(`${base}/presign-multipart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, mimeType, partCount, fileSize: file.size }),
        });
        if (!mpRes.ok) {
          const j = await mpRes.json().catch(() => ({}));
          setError((j as { error?: string }).error ?? `分段初始化失败 (${mpRes.status})`);
          return;
        }
        const mp = await mpRes.json() as {
          uploadId: string; r2Key: string; fileId: string;
          parts: { partNumber: number; uploadUrl: string }[];
        };
        r2Key = mp.r2Key; fileId = mp.fileId;

        // Upload parts with CONCURRENCY parallel XHRs, track bytes for progress
        const eTags: { partNumber: number; eTag: string }[] = [];
        let uploadedBytes = 0;

        for (let i = 0; i < mp.parts.length; i += CONCURRENCY) {
          const batch = mp.parts.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(({ partNumber, uploadUrl }) =>
            new Promise<void>((resolve, reject) => {
              const start = (partNumber - 1) * partSize;
              const chunk = file.slice(start, Math.min(start + partSize, file.size));

              const xhr = new XMLHttpRequest();
              let lastLoaded = 0;
              xhr.upload.addEventListener("progress", e => {
                uploadedBytes += e.loaded - lastLoaded;
                lastLoaded = e.loaded;
                setProgress(Math.round((uploadedBytes / file.size) * 100));
              });
              xhr.addEventListener("load", () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  const eTag = xhr.getResponseHeader("ETag") ?? "";
                  eTags.push({ partNumber, eTag });
                  // Account for any un-fired progress events
                  uploadedBytes += chunk.size - lastLoaded;
                  setProgress(Math.round((uploadedBytes / file.size) * 100));
                  resolve();
                } else {
                  reject(new Error(`Part ${partNumber} 上传失败 (${xhr.status})`));
                }
              });
              xhr.addEventListener("error", () => reject(new Error(`Part ${partNumber} 网络错误`)));
              xhr.open("PUT", uploadUrl);
              xhr.send(chunk);
            })
          ));
        }

        setProgress(100);

        const regRes = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageType: "r2-multipart",
            uploadId: mp.uploadId, r2Key, fileId,
            parts: eTags,
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
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-zinc-800 transition-all duration-150"
            style={{ width: `${progress}%` }}
          />
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
