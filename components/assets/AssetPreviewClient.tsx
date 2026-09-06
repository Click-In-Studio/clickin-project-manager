"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import AssetShareModal from "./AssetShareModal";

const WaveformPlayer = lazy(() => import("./WaveformPlayer"));
const VideoPlayer = lazy(() => import("./VideoPlayer"));

type PreviewType = "image" | "video" | "audio" | "pdf";

interface Props {
  productionId: string;
  assetId: string;
  versionId: string | null;
  fileName: string;
  mimeType: string | null;
  storageType: string;
  feishuUrl: string | null;
  userName: string;
  /** embedded：内嵌在知识库 shell 主区（#420 第二批）——卡片外壳、去掉整页
   *  导航（返回/Asset 列表），其余（下载/分享/预览体）同一份。 */
  variant?: "page" | "embedded";
}

function getPreviewType(mimeType: string | null): PreviewType | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}

// #85 元数据信封（展示所需的最小面；完整定义 lib/asset/metadata.ts）
interface MetaEnvelope {
  status: string;
  detectedType: string | null;
  data: Record<string, unknown> | null;
}

/** 探测类型 → 展示标签。认不出的直接显示 detectedType 原文。 */
const TYPE_LABELS: Record<string, string> = {
  "image/png": "PNG 图片", "image/jpeg": "JPEG 图片", "image/gif": "GIF 图片",
  "image/webp": "WebP 图片", "image/tiff": "TIFF 图片",
  "audio/wav": "WAV 音频", "audio/mpeg": "MP3 音频", "audio/flac": "FLAC 音频",
  "audio/ogg": "OGG 音频", "audio/aiff": "AIFF 音频", "audio/mp4": "M4A 音频", "audio/midi": "MIDI",
  "video/mp4": "MP4 视频", "video/quicktime": "QuickTime 视频", "video/webm": "WebM 视频",
  "video/x-matroska": "MKV 视频", "video/x-msvideo": "AVI 视频",
  "application/pdf": "PDF 文档", "application/zip": "ZIP 压缩包",
  "application/vnd.rar": "RAR 压缩包", "application/x-7z-compressed": "7z 压缩包",
  "application/gzip": "GZIP 压缩包",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word 文档",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 表格",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPT 演示",
};

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 信封 → 顶栏信息行「PNG 图片 · 1920×1080 · 2.4 MB」；无可展示项返回 null。 */
function metaInfoLine(meta: MetaEnvelope | null, fileSize: number | null): string | null {
  const parts: string[] = [];
  if (meta?.detectedType) parts.push(TYPE_LABELS[meta.detectedType] ?? meta.detectedType);
  const d = meta?.data;
  if (typeof d?.width === "number" && typeof d?.height === "number") parts.push(`${d.width}×${d.height}`);
  if (fileSize != null) parts.push(formatBytes(fileSize));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function AssetPreviewClient({
  productionId, assetId, versionId, fileName, mimeType, storageType, feishuUrl, userName,
  variant = "page",
}: Props) {
  const embedded = variant === "embedded";
  // 色调：整页=暗房（看片场景）；内嵌=白底（融进知识库 shell）
  const t = embedded ? {
    bar: "border-zinc-200",
    dim: "text-zinc-400 hover:text-zinc-700",
    faint: "text-zinc-400",
    fainter: "text-zinc-300",
    btn: "bg-zinc-800 hover:bg-zinc-700 text-white",
  } : {
    bar: "border-white/5",
    dim: "text-white/40 hover:text-white/70",
    faint: "text-white/30",
    fainter: "text-white/20",
    btn: "bg-white/10 hover:bg-white/20 text-white",
  };
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [infoLine, setInfoLine] = useState<string | null>(null);

  const previewType = getPreviewType(mimeType);

  // #85 元数据：独立于预览链路拉取（失败静默——信息行是锦上添花不许挡预览）
  useEffect(() => {
    if (storageType !== "r2") return;
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/metadata`)
      .then(r => (r.ok ? r.json() : null))
      .then((j: { fileSize?: number | null; metadata?: MetaEnvelope | null } | null) => {
        if (j) setInfoLine(metaInfoLine(j.metadata ?? null, j.fileSize ?? null));
      })
      .catch(() => {});
  }, [productionId, assetId, storageType]);

  useEffect(() => {
    // Feishu links: open directly
    if (storageType === "feishu_link" && feishuUrl) {
      window.location.href = feishuUrl;
      return;
    }

    if (!previewType) {
      // Not previewable — fetch download URL and trigger download
      const qs = versionId ? `?v=${versionId}` : "";
      fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/download-url${qs}`)
        .then(r => r.json())
        .then((j: { url?: string }) => {
          if (j.url) { setDownloadUrl(j.url); setLoading(false); }
          else { setError("无法获取下载链接"); setLoading(false); }
        })
        .catch(() => { setError("加载失败"); setLoading(false); });
      return;
    }

    // Previewable — fetch inline URL
    const qs = versionId ? `?v=${versionId}` : "";
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/preview-url${qs}`)
      .then(r => r.json())
      .then((j: { url?: string; error?: string }) => {
        if (j.error) { setError(j.error); setLoading(false); return; }
        setUrl(j.url ?? null);
        setLoading(false);
      })
      .catch(() => { setError("加载失败"); setLoading(false); });
  }, [productionId, assetId, versionId, storageType, feishuUrl, previewType]);

  const backHref = `${BASE_PATH}/production/${productionId}/assets`;

  return (
    <div className={embedded
      ? "rounded-xl overflow-hidden border border-zinc-200 bg-white flex flex-col min-h-[calc(100vh-160px)]"
      : "min-h-screen bg-zinc-950 flex flex-col"}>
      {/* Top bar */}
      <div className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${t.bar}`}>
        {embedded ? (
          <span className="text-xs text-zinc-300">资产预览</span>
        ) : (
          <button
            onClick={() => router.back()}
            className={`text-xs transition-colors ${t.dim}`}
          >
            ← 返回
          </button>
        )}
        <div className="min-w-0 text-center">
          <p className={`text-xs truncate max-w-[50vw] ${embedded ? "text-zinc-600" : "text-white/50"}`}>{fileName}</p>
          {infoLine && <p className={`text-[10px] truncate max-w-[50vw] ${t.faint}`}>{infoLine}</p>}
        </div>
        <div className="flex items-center gap-3">
          {url && (
            <a
              href={url}
              download={fileName}
              className={`text-xs transition-colors ${t.dim}`}
            >
              下载
            </a>
          )}
          {downloadUrl && !url && (
            <a
              href={downloadUrl}
              download={fileName}
              className={`text-xs transition-colors ${t.dim}`}
            >
              下载
            </a>
          )}
          <button
            onClick={() => setShareOpen(true)}
            className={`text-xs transition-colors ${t.dim}`}
          >
            分享
          </button>
          {!embedded && (
            <a
              href={backHref}
              className={`text-xs transition-colors ${t.dim}`}
            >
              Asset 列表
            </a>
          )}
        </div>
      </div>

      {shareOpen && (
        <AssetShareModal
          productionId={productionId}
          assetId={assetId}
          assetName={fileName}
          userName={userName}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        {loading && (
          <p className={`text-sm ${t.faint}`}>加载中…</p>
        )}

        {!loading && error && (
          <div className="text-center">
            <p className={`text-sm mb-2 ${t.faint}`}>{error}</p>
            <p className={`text-xs ${t.fainter}`}>该格式暂不支持预览</p>
          </div>
        )}

        {!loading && !previewType && downloadUrl && (
          <div className="text-center">
            <p className="text-4xl mb-4">📄</p>
            <p className={`text-sm mb-1 truncate max-w-xs ${embedded ? "text-zinc-600" : "text-white/50"}`}>{fileName}</p>
            <p className={`text-xs mb-6 ${t.faint}`}>该格式不支持预览</p>
            <a
              href={downloadUrl}
              download={fileName}
              className={`inline-block rounded-lg px-5 py-2.5 text-sm transition-colors ${t.btn}`}
            >
              下载文件
            </a>
          </div>
        )}

        {!loading && url && previewType === "image" && (
          <img
            src={url}
            alt={fileName}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            style={{ maxHeight: "calc(100vh - 80px)" }}
          />
        )}

        {!loading && url && previewType === "video" && (
          <Suspense fallback={<p className="text-sm text-white/30">加载中…</p>}>
            <VideoPlayer url={url} fileName={fileName} />
          </Suspense>
        )}

        {!loading && url && previewType === "audio" && (
          <Suspense fallback={
            <div className="w-full max-w-2xl rounded-2xl bg-zinc-900 px-6 py-8 shadow-2xl flex items-center justify-center h-48">
              <p className="text-sm text-white/30">加载中…</p>
            </div>
          }>
            <WaveformPlayer url={url} fileName={fileName} />
          </Suspense>
        )}

        {!loading && url && previewType === "pdf" && (
          <iframe
            src={url}
            title={fileName}
            className="w-full rounded-lg shadow-2xl bg-white"
            style={{ height: "calc(100vh - 80px)", width: "min(900px, 100%)" }}
          />
        )}
      </div>
    </div>
  );
}

/** Whether a mimeType / storageType combo has an in-browser preview. Feishu links redirect directly. */
export function isPreviewable(mimeType: string | null, storageType: string): boolean {
  if (storageType === "feishu_link") return true; // redirect to feishu URL
  const t = getPreviewType(mimeType);
  return t !== null;
}
