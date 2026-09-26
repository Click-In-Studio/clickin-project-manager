"use client";

import { useCallback, useEffect, useState } from "react";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";

const EXPIRY_OPTIONS = [
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "90 天", days: 90 },
  { label: "1 年", days: 365 },
];

type ShareLink = {
  id: string;
  token: string;
  allowDownload: boolean;
  oneTime: boolean;
  note: string | null;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  redeemedAt: string | null;
  status: "active" | "redeemed" | "expired" | "revoked";
};

interface Props {
  productionId: string;
  assetId: string;
  assetName: string;
  userName: string;
  canCreateLink: boolean;
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function statusOf(link: ShareLink): { label: string; color: string; usable: boolean; revocable: boolean } {
  if (link.status === "revoked") return { label: "已撤销", color: "text-red-500", usable: false, revocable: false };
  if (link.status === "expired") {
    return { label: "已过期", color: "text-zinc-400", usable: false, revocable: false };
  }
  if (link.status === "redeemed") {
    return { label: "已兑换", color: "text-amber-600", usable: false, revocable: true };
  }
  return { label: "有效", color: "text-emerald-600", usable: true, revocable: true };
}

export default function AssetSharePanel({
  productionId, assetId, assetName, userName, canCreateLink, onClose,
}: Props) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [oneTime, setOneTime] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [note, setNote] = useState("");
  const [generated, setGenerated] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `${BASE_PATH}/api/production/${productionId}/assets/${assetId}/share`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(base);
      const body = await response.json() as { links?: ShareLink[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "加载失败");
      setLinks(body.links ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  function shareUrl(link: ShareLink): string {
    return `${window.location.origin}${BASE_PATH}/share/${link.token}`;
  }

  async function copy(link: ShareLink, withIntro = false) {
    const url = shareUrl(link);
    const value = withIntro ? `${userName}向你分享了《${assetName}》，链接：${url}` : url;
    await navigator.clipboard.writeText(value);
    const key = `${link.id}:${withIntro ? "intro" : "url"}`;
    setCopied(key);
    setTimeout(() => setCopied(current => current === key ? null : current), 2000);
  }

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays, allowDownload, oneTime, note: note.trim() || null }),
      });
      const body = await response.json() as { link?: ShareLink; error?: string };
      if (!response.ok || !body.link) throw new Error(body.error ?? "生成失败");
      setGenerated(body.link);
      setNote("");
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "生成失败");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: ShareLink) {
    const response = await fetch(`${base}/${link.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "撤销失败");
      return;
    }
    if (generated?.id === link.id) setGenerated(null);
    await load();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-800">对外分享</p>
            <p className="mt-0.5 max-w-[360px] truncate text-xs text-zinc-400">{assetName}</p>
          </div>
          <button onClick={onClose} className="text-lg leading-none text-zinc-400 transition-colors hover:text-zinc-600">×</button>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          {canCreateLink ? (
          <div className="space-y-4 rounded-xl border border-zinc-200 p-4">
            <div>
              <p className="mb-2 text-xs font-medium text-zinc-500">访问方式</p>
              <div className="flex overflow-hidden rounded-xl border border-zinc-200 text-xs">
                <button onClick={() => setOneTime(false)}
                  className={`flex-1 py-2 font-medium transition-colors ${!oneTime ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}>
                  限时链接
                </button>
                <button onClick={() => setOneTime(true)}
                  className={`flex-1 py-2 font-medium transition-colors ${oneTime ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}>
                  单次访问
                </button>
              </div>
              {oneTime && (
                <p className="mt-2 text-xs leading-5 text-zinc-400">
                  首次打开后仅限那台浏览器使用；闲置 30 分钟失效，最长 8 小时。
                </p>
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-zinc-500">分享能力</p>
              <div className="flex overflow-hidden rounded-xl border border-zinc-200 text-xs">
                <button onClick={() => setAllowDownload(false)}
                  className={`flex-1 py-2 font-medium transition-colors ${!allowDownload ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}>
                  仅查看
                </button>
                <button onClick={() => setAllowDownload(true)}
                  className={`flex-1 py-2 font-medium transition-colors ${allowDownload ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}>
                  可下载
                </button>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-zinc-500">链接有效期</p>
              <OverflowSafeSelect value={expiresInDays} onChange={event => setExpiresInDays(Number(event.target.value))}
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 outline-none focus:border-zinc-400">
                {EXPIRY_OPTIONS.map(option => <option key={option.days} value={option.days}>{option.label}</option>)}
              </OverflowSafeSelect>
            </div>

            <input value={note} onChange={event => setNote(event.target.value)} maxLength={120}
              placeholder="备注，例如：发给剧场技术部（可选）"
              className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 outline-none focus:border-zinc-400" />

            <button onClick={create} disabled={creating}
              className="w-full rounded-xl bg-zinc-800 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50">
              {creating ? "生成中…" : "生成链接"}
            </button>

            {generated && (
              <div className="space-y-2 rounded-xl bg-zinc-50 p-3">
                <p className="truncate text-xs text-zinc-600">{shareUrl(generated)}</p>
                <div className="flex gap-2">
                  <button onClick={() => copy(generated)} className="flex-1 rounded-lg border border-zinc-200 bg-white py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                    {copied === `${generated.id}:url` ? "已复制" : "复制链接"}
                  </button>
                  <button onClick={() => copy(generated, true)} className="flex-1 rounded-lg bg-zinc-800 py-2 text-xs font-medium text-white hover:bg-zinc-700">
                    {copied === `${generated.id}:intro` ? "已复制" : "复制带简介"}
                  </button>
                </div>
              </div>
            )}
          </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs leading-5 text-zinc-500">
              项目当前已关闭对外分享。已有链接均已失效，你仍可以在下方逐条撤销。
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">已生成的链接</p>
            {loading ? (
              <div className="flex justify-center py-5"><div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-200 border-t-zinc-500" /></div>
            ) : links.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400">还没有分享链接</p>
            ) : (
              <div className="space-y-2">
                {links.map(link => {
                  const status = statusOf(link);
                  return (
                    <div key={link.id} className="rounded-xl border border-zinc-200 px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className={`font-medium ${status.color}`}>{status.label}</span>
                            <span className="text-zinc-400">· {link.oneTime ? "单次访问" : "限时链接"}</span>
                            <span className="text-zinc-400">· {link.allowDownload ? "可下载" : "仅查看"}</span>
                          </div>
                          {link.note && <p className="mt-1 truncate text-xs text-zinc-600">{link.note}</p>}
                          <p className="mt-1 text-xs text-zinc-400">有效至 {formatDate(link.expiresAt)}</p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {status.usable && (
                            <button onClick={() => copy(link)} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100">
                              {copied === `${link.id}:url` ? "已复制" : "复制"}
                            </button>
                          )}
                          {status.revocable && (
                            <button onClick={() => revoke(link)} className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50">撤销</button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
