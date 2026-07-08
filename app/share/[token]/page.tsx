"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type AssetInfo = {
  assetId: string;
  name: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  assetType: string;
  storageType: string;
  expiresAt: string | null;
  oneTime: boolean;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function mediaKind(mimeType: string | null): "video" | "audio" | "pdf" | "other" {
  if (!mimeType) return "other";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "other";
}

export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then(p => setToken(p.token));
  }, [params]);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_PATH}/api/share/${token}`)
      .then(r => r.ok ? r.json() : r.json().then((j: { error?: string }) => { throw new Error(j.error ?? "加载失败"); }))
      .then(setInfo)
      .catch(e => setError(String(e).replace(/^Error:\s*/, "")));
  }, [token]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-6 text-center">
        <p className="text-2xl font-semibold text-zinc-800 mb-2">链接无效</p>
        <p className="text-sm text-zinc-400">{error}</p>
      </div>
    );
  }

  if (!info || !token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />
      </div>
    );
  }

  const streamUrl = `${BASE_PATH}/api/share/${token}/stream`;
  const kind = mediaKind(info.mimeType);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-0.5">Click-In 资产分享</p>
        <h1 className="text-base font-semibold text-zinc-100 truncate">{info.name}</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          {info.fileName}
          {info.fileSize ? ` · ${formatSize(info.fileSize)}` : ""}
          {info.expiresAt ? ` · 有效至 ${formatExpiry(info.expiresAt)}` : ""}
          {info.oneTime ? " · 一次性链接" : ""}
        </p>
      </div>

      {/* Player / Viewer */}
      <div className="flex-1 flex items-center justify-center p-4">
        {kind === "video" && (
          <video
            src={streamUrl}
            controls
            controlsList="nodownload nofullscreen"
            disablePictureInPicture
            className="max-h-[80vh] max-w-full rounded-lg shadow-2xl"
            preload="metadata"
          />
        )}

        {kind === "audio" && (
          <div className="w-full max-w-lg space-y-4">
            <div className="flex items-center justify-center h-32 rounded-xl bg-zinc-900 border border-zinc-800">
              <svg className="w-12 h-12 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <audio
              src={streamUrl}
              controls
              controlsList="nodownload"
              className="w-full"
              preload="metadata"
            />
          </div>
        )}

        {kind === "pdf" && (
          <iframe
            src={streamUrl}
            className="w-full h-[80vh] max-w-4xl rounded-lg shadow-2xl"
            title={info.name}
          />
        )}

        {kind === "other" && (
          <div className="text-center space-y-3">
            <div className="flex items-center justify-center h-24 w-24 rounded-2xl bg-zinc-900 border border-zinc-800 mx-auto">
              <svg className="w-10 h-10 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-zinc-400 text-sm">此文件类型不支持在线预览</p>
            <p className="text-zinc-600 text-xs">{info.fileName}</p>
          </div>
        )}
      </div>
    </div>
  );
}
