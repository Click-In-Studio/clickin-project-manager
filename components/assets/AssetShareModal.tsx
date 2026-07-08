"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

const EXPIRY_OPTIONS = [
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "90 天", days: 90 },
  { label: "1 年", days: 365 },
];

interface Props {
  productionId: string;
  assetId: string;
  assetName: string;
  onClose: () => void;
}

export default function AssetShareModal({ productionId, assetId, assetName, onClose }: Props) {
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setCreating(true);
    setError(null);
    setGeneratedUrl(null);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/share`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiresInDays, allowDownload }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? "生成失败");
        return;
      }
      const { token } = await res.json() as { token: string };
      setGeneratedUrl(`${window.location.origin}${BASE_PATH}/share/${token}`);
    } finally {
      setCreating(false);
    }
  }

  function copy() {
    if (!generatedUrl) return;
    navigator.clipboard.writeText(generatedUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-zinc-100">
          <div>
            <p className="text-sm font-semibold text-zinc-800">分享</p>
            <p className="text-xs text-zinc-400 mt-0.5 truncate max-w-[220px]">{assetName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Mode */}
          <div>
            <p className="text-xs font-medium text-zinc-500 mb-2">分享模式</p>
            <div className="flex rounded-xl overflow-hidden border border-zinc-200 text-xs">
              <button
                onClick={() => setAllowDownload(false)}
                className={`flex-1 py-2 font-medium transition-colors ${
                  !allowDownload ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                仅查看
              </button>
              <button
                onClick={() => setAllowDownload(true)}
                className={`flex-1 py-2 font-medium transition-colors ${
                  allowDownload ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                可下载
              </button>
            </div>
          </div>

          {/* Expiry */}
          <div>
            <p className="text-xs font-medium text-zinc-500 mb-2">有效期</p>
            <select
              value={expiresInDays}
              onChange={e => setExpiresInDays(Number(e.target.value))}
              className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 outline-none focus:border-zinc-400"
            >
              {EXPIRY_OPTIONS.map(o => (
                <option key={o.days} value={o.days}>{o.label}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          {/* Generate */}
          {!generatedUrl ? (
            <button
              onClick={generate}
              disabled={creating}
              className="w-full rounded-xl bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              {creating ? "生成中…" : "生成链接"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
                <p className="flex-1 text-xs text-zinc-600 truncate">{generatedUrl}</p>
                <button
                  onClick={copy}
                  className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 transition-colors"
                >
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <button
                onClick={() => { setGeneratedUrl(null); setCopied(false); }}
                className="w-full text-xs text-zinc-400 hover:text-zinc-600 transition-colors py-1"
              >
                重新生成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
