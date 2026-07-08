"use client";

import { useState, useEffect, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";

type ShareToken = {
  token: string;
  label: string | null;
  oneTime: boolean;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

interface Props {
  productionId: string;
  assetId: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric", year: "numeric" });
}

function tokenStatus(t: ShareToken): { label: string; color: string } {
  if (t.revokedAt) return { label: "已撤销", color: "text-red-400" };
  if (t.expiresAt && new Date(t.expiresAt) < new Date()) return { label: "已过期", color: "text-zinc-500" };
  if (t.oneTime && t.usedAt) return { label: "已使用", color: "text-amber-400" };
  return { label: "有效", color: "text-emerald-400" };
}

export default function AssetSharePanel({ productionId, assetId }: Props) {
  const [tokens, setTokens] = useState<ShareToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState<"time_limited" | "one_time">("time_limited");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/share`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base);
      if (res.ok) setTokens((await res.json()).tokens);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          expiresInDays: type === "time_limited" ? expiresInDays : null,
          label: label.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? "创建失败");
        return;
      }
      setLabel("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: string) {
    await fetch(`${base}/${encodeURIComponent(token)}`, { method: "DELETE" });
    await load();
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}${BASE_PATH}/share/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const activeTokens = tokens.filter(t => !t.revokedAt);
  const revokedTokens = tokens.filter(t => t.revokedAt);

  return (
    <div className="space-y-4">
      {/* Create form */}
      <div className="rounded-xl border border-zinc-200 p-4 space-y-3">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">创建分享链接</p>

        <div className="flex gap-2">
          {(["time_limited", "one_time"] as const).map(t => (
            <button key={t} onClick={() => setType(t)}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                type === t ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}>
              {t === "time_limited" ? "限时链接" : "一次性链接"}
            </button>
          ))}
        </div>

        {type === "time_limited" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">有效期</span>
            {[7, 30, 90, 365].map(d => (
              <button key={d} onClick={() => setExpiresInDays(d)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  expiresInDays === d ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                }`}>
                {d < 30 ? `${d}天` : d < 365 ? `${d/30}个月` : "1年"}
              </button>
            ))}
          </div>
        )}

        <input
          type="text" placeholder="备注（可选）" value={label}
          onChange={e => setLabel(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:border-zinc-400"
        />

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button onClick={create} disabled={creating}
          className="w-full rounded-lg bg-zinc-800 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors">
          {creating ? "生成中…" : "生成链接"}
        </button>
      </div>

      {/* Token list */}
      {loading ? (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-200 border-t-zinc-500" />
        </div>
      ) : (
        <div className="space-y-2">
          {activeTokens.map(t => {
            const { label: statusLabel, color } = tokenStatus(t);
            return (
              <div key={t.token} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium ${color}`}>{statusLabel}</span>
                    {t.oneTime && <span className="text-xs text-zinc-400">· 一次性</span>}
                    {t.label && <span className="text-xs text-zinc-400 truncate">· {t.label}</span>}
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {t.expiresAt ? `到期 ${formatDate(t.expiresAt)}` : "无到期时间"}
                    {t.usedAt ? ` · 已使用 ${formatDate(t.usedAt)}` : ""}
                  </p>
                </div>
                <button onClick={() => copyLink(t.token)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 transition-colors">
                  {copied === t.token ? "已复制" : "复制链接"}
                </button>
                <button onClick={() => revoke(t.token)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 transition-colors">
                  撤销
                </button>
              </div>
            );
          })}

          {activeTokens.length === 0 && (
            <p className="text-center text-xs text-zinc-400 py-3">暂无有效的分享链接</p>
          )}

          {revokedTokens.length > 0 && (
            <details className="text-xs text-zinc-400">
              <summary className="cursor-pointer select-none py-1">已撤销 / 过期（{revokedTokens.length}）</summary>
              <div className="mt-1 space-y-1 pl-2">
                {revokedTokens.map(t => (
                  <div key={t.token} className="flex items-center gap-2 text-zinc-400">
                    <span className="flex-1 truncate">{t.label ?? t.token.slice(0, 12) + "…"}</span>
                    <span>{formatDate(t.revokedAt)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
