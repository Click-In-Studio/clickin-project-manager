"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";

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
}

function getPreviewType(mimeType: string | null): PreviewType | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}

export default function AssetPreviewClient({
  productionId, assetId, versionId, fileName, mimeType, storageType, feishuUrl,
}: Props) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const previewType = getPreviewType(mimeType);

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
    <div className="min-h-screen bg-zinc-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
        <button
          onClick={() => router.back()}
          className="text-xs text-white/40 hover:text-white/70 transition-colors"
        >
          ← 返回
        </button>
        <p className="text-xs text-white/50 truncate max-w-[50vw] text-center">{fileName}</p>
        <div className="flex items-center gap-3">
          {url && (
            <a
              href={url}
              download={fileName}
              className="text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              下载
            </a>
          )}
          {downloadUrl && !url && (
            <a
              href={downloadUrl}
              download={fileName}
              className="text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              下载
            </a>
          )}
          <a
            href={backHref}
            className="text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            Asset 列表
          </a>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        {loading && (
          <p className="text-sm text-white/30">加载中…</p>
        )}

        {!loading && error && (
          <div className="text-center">
            <p className="text-sm text-white/40 mb-2">{error}</p>
            <p className="text-xs text-white/20">该格式暂不支持预览</p>
          </div>
        )}

        {!loading && !previewType && downloadUrl && (
          <div className="text-center">
            <p className="text-4xl mb-4">📄</p>
            <p className="text-sm text-white/50 mb-1 truncate max-w-xs">{fileName}</p>
            <p className="text-xs text-white/30 mb-6">该格式不支持预览</p>
            <a
              href={downloadUrl}
              download={fileName}
              className="inline-block rounded-lg bg-white/10 hover:bg-white/20 px-5 py-2.5 text-sm text-white transition-colors"
            >
              下载文件
            </a>
          </div>
        )}

        {!loading && url && previewType === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
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
