"use client";

import { useCallback, useEffect, useState } from "react";
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
  allowDownload: boolean;
  oneTime: boolean;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
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
  const [requiresRedemption, setRequiresRedemption] = useState(false);
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    params.then(p => setToken(p.token));
  }, [params]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${BASE_PATH}/api/share/${token}`);
      const body = await response.json() as (AssetInfo & { requiresRedemption?: false }) | {
        requiresRedemption: true; error?: string;
      };
      if (!response.ok) throw new Error("error" in body ? body.error ?? "加载失败" : "加载失败");
      if (body.requiresRedemption === true) {
        setRequiresRedemption(true);
        setInfo(null);
      } else {
        setRequiresRedemption(false);
        setInfo(body);
      }
    } catch (loadError) {
      setError(String(loadError).replace(/^Error:\s*/, ""));
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!token || !info?.oneTime) return;
    const heartbeat = async () => {
      if (document.visibilityState !== "visible") return;
      const response = await fetch(`${BASE_PATH}/api/share/${token}/redeem`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setInfo(null);
        setError(body.error ?? "本次访问已结束");
      }
    };
    const timer = window.setInterval(() => { void heartbeat(); }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [info?.oneTime, token]);

  async function redeem() {
    if (!token) return;
    setRedeeming(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/share/${token}/redeem`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "打开失败");
      await load();
    } catch (redeemError) {
      setError(String(redeemError).replace(/^Error:\s*/, ""));
    } finally {
      setRedeeming(false);
    }
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-6 text-center">
        <p className="text-2xl font-semibold text-zinc-800 mb-2">链接无效</p>
        <p className="text-sm text-zinc-400">{error}</p>
      </div>
    );
  }

  if (requiresRedemption && token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 p-6 text-center text-white">
        <p className="mb-2 text-2xl font-semibold">这是一个单次访问链接</p>
        <p className="mb-6 max-w-sm text-sm leading-6 text-zinc-400">
          打开后，这个链接只能在当前浏览器继续使用；闲置 30 分钟失效，最长可使用 8 小时。
        </p>
        <button onClick={redeem} disabled={redeeming}
          className="rounded-xl bg-white px-6 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50">
          {redeeming ? "正在打开…" : "打开文件"}
        </button>
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
  const { allowDownload } = info;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-0.5">Click-In 资产分享</p>
          <h1 className="text-base font-semibold text-zinc-100 truncate">{info.name}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {info.fileName}
            {info.fileSize ? ` · ${formatSize(info.fileSize)}` : ""}
            {info.expiresAt ? ` · 有效至 ${formatExpiry(info.expiresAt)}` : ""}
          </p>
        </div>
        {allowDownload && (
          <a
            href={streamUrl}
            download={info.fileName}
            className="ml-4 shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            下载
          </a>
        )}
      </div>

      {/* Player / Viewer */}
      <div className="flex-1 flex items-center justify-center p-4">
        {kind === "video" && (
          <video
            src={streamUrl}
            controls
            controlsList={allowDownload ? undefined : "nodownload nofullscreen"}
            disablePictureInPicture={!allowDownload}
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
              controlsList={allowDownload ? undefined : "nodownload"}
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
            {allowDownload && (
              <a
                href={streamUrl}
                download={info.fileName}
                className="inline-block rounded-lg bg-white/10 hover:bg-white/20 px-5 py-2.5 text-sm text-white transition-colors"
              >
                下载文件
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
