"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import AssetUploadPanel from "./AssetUploadPanel";
import MountPointAssets from "./MountPointAssets";
import AssetShareModal from "./AssetShareModal";
import { BASE_PATH } from "@/lib/base-path";
import type { Asset, AssetMount, AssetType } from "@/lib/asset-db";

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

type AssetWithMounts = Asset & { mounts: AssetMount[] };

type View = "all" | "upload-new-version";

interface Props {
  productionId: string;
  versionId: string | null;
  myOpenId: string;
  isAdmin: boolean;
  userName: string;
}

export default function AssetPageClient({ productionId, versionId, myOpenId, isAdmin, userName }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mounts, setMounts] = useState<Record<string, AssetMount[]>>({});
  const [loadingMounts, setLoadingMounts] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>("all");
  const [uploadTarget, setUploadTarget] = useState<Asset | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<Asset | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${BASE_PATH}/api/production/${productionId}/assets`)
      .then(r => r.json())
      .then((j: { assets?: Asset[] }) => setAssets(j.assets ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [productionId]);

  useEffect(() => { load(); }, [load]);

  async function loadMounts(assetId: string) {
    if (mounts[assetId] || loadingMounts[assetId]) return;
    setLoadingMounts(p => ({ ...p, [assetId]: true }));
    try {
      const r = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/mounts`);
      const j = await r.json() as { mounts?: AssetMount[] };
      setMounts(p => ({ ...p, [assetId]: j.mounts ?? [] }));
    } finally {
      setLoadingMounts(p => ({ ...p, [assetId]: false }));
    }
  }

  function toggleExpand(assetId: string) {
    if (expanded === assetId) { setExpanded(null); return; }
    setExpanded(assetId);
    loadMounts(assetId);
  }

  async function handleDeleteAsset(assetId: string) {
    if (!confirm("确认删除此 Asset？相关挂载点也会一并删除。")) return;
    setDeletingId(assetId);
    try {
      await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}`, { method: "DELETE" });
      setAssets(p => p.filter(a => a.id !== assetId));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDeleteMount(assetId: string, mountId: string) {
    await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/mounts/${mountId}`, { method: "DELETE" });
    setMounts(p => ({ ...p, [assetId]: (p[assetId] ?? []).filter(m => m.id !== mountId) }));
  }

  async function handleDownload(assetId: string) {
    const r = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/download-url${versionId ? `?v=${versionId}` : ""}`);
    const j = await r.json() as { url?: string; feishuUrl?: string };
    if (j.url) window.open(j.url, "_blank");
    else if (j.feishuUrl) window.open(j.feishuUrl, "_blank");
  }

  const displayedAssets = assets.filter(a => {
    if (filter === "mine" && a.uploaderOpenId !== myOpenId) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(a.name ?? a.fileName).toLowerCase().includes(q) && !ASSET_TYPE_LABELS[a.assetType].includes(q)) return false;
    }
    return true;
  });

  function mountLabel(m: AssetMount) {
    const mode = m.mountMode ? ` (${m.mountMode === "tracking" ? "跟踪" : m.mountMode === "version_only" ? "当前版本" : "继承"})` : "";
    return `${m.mountType}:${m.mountId.slice(-6)}${mode}${m.folderPath ? ` — ${m.folderPath}` : ""}`;
  }

  if (view === "upload-new-version" && uploadTarget) {
    return (
      <div className="min-h-screen bg-zinc-100 px-4 py-10">
        <div className="w-full max-w-sm mx-auto">
          <button onClick={() => { setView("all"); setUploadTarget(null); }}
            className="text-xs text-zinc-400 hover:text-zinc-600 mb-6 block">
            ← 返回
          </button>
          <h1 className="text-sm font-bold tracking-widest text-zinc-400 uppercase mb-6">
            上传新版本
          </h1>
          <div className="rounded-2xl bg-white shadow-sm p-5">
            <p className="text-xs text-zinc-400 mb-4">
              为 <span className="font-medium text-zinc-600">{uploadTarget.fileName}</span> 上传新版本
            </p>
            <AssetUploadPanel
              productionId={productionId}
              versionId={versionId}
              onUploaded={() => { setView("all"); setUploadTarget(null); load(); }}
              onCancel={() => { setView("all"); setUploadTarget(null); }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-sm mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase text-right">Assets</p>
            <p className="text-[10px] text-zinc-300 text-right">附件管理</p>
          </div>
        </div>

        {/* Production global mount */}
        <div className="mb-4 rounded-2xl bg-white shadow-sm px-5 py-4">
          <MountPointAssets
            productionId={productionId}
            mountType="production"
            mountId={productionId}
            label="项目全局"
            canEdit={isAdmin}
            display="panel"
          />
        </div>

        {/* Filter + Search */}
        <div className="mb-4 space-y-2">
          <input
            type="text"
            placeholder="搜索文件名或类型…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 shadow-sm"
          />
          <div className="flex rounded-xl overflow-hidden border border-zinc-200 text-xs shadow-sm">
            {(["all", "mine"] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-1 py-2 font-medium transition-colors ${
                  filter === f ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
                }`}>
                {f === "all" ? "全部 Asset" : "我的上传"}
              </button>
            ))}
          </div>
        </div>

        {/* Upload new */}
        <div className="mb-4">
          <Link href={`/production/${productionId}/assets/upload`}
            className="flex items-center justify-center gap-2 w-full rounded-xl border-2 border-dashed border-zinc-300 py-3 text-sm text-zinc-400 hover:border-zinc-400 hover:text-zinc-600 transition-colors">
            + 上传新 Asset
          </Link>
        </div>

        {/* Asset list */}
        {loading ? (
          <p className="py-10 text-center text-xs text-zinc-400">加载中…</p>
        ) : error ? (
          <p className="py-10 text-center text-xs text-red-500">{error}</p>
        ) : displayedAssets.length === 0 ? (
          <p className="py-10 text-center text-xs text-zinc-400">暂无 Asset</p>
        ) : (
          <div className="space-y-2">
            {displayedAssets.map(a => {
              const isOwner = a.uploaderOpenId === myOpenId;
              const canEdit = isOwner || isAdmin;
              const isExp = expanded === a.id;

              return (
                <div key={a.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
                  {/* Main row */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* Thumb / icon */}
                    <div className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center bg-zinc-100 text-xs font-bold text-zinc-400 uppercase overflow-hidden">
                      {a.storageType === "feishu_link" ? (
                        <span>飞</span>
                      ) : a.mimeType?.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`${BASE_PATH}/api/production/${productionId}/assets/${a.id}/thumb${versionId ? `?v=${versionId}` : ""}`}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <span>{a.fileName.split(".").pop()?.slice(0, 4) ?? "?"}</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/production/${productionId}/assets/${a.id}/preview${versionId ? `?v=${versionId}` : ""}`}
                        className="block text-sm font-medium text-zinc-800 hover:text-zinc-600 truncate transition-colors"
                      >
                        {a.name ?? a.fileName}
                      </Link>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        {a.name && <span className="text-[10px] text-zinc-300 truncate max-w-[120px]">{a.fileName}</span>}
                        <span className="text-[10px] text-zinc-400">{ASSET_TYPE_LABELS[a.assetType]}</span>
                        {!a.isUniversal && (
                          <span className="rounded px-1 py-px text-[9px] bg-amber-50 text-amber-500 font-medium">版本相关</span>
                        )}
                        {a.storageType === "feishu_link" && (
                          <span className="rounded px-1 py-px text-[9px] bg-blue-50 text-blue-500 font-medium">飞书</span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => handleDownload(a.id)}
                        className="rounded-lg px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-50 transition-colors">
                        下载
                      </button>
                      <button onClick={() => setShareTarget(a)}
                        className="rounded-lg px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-50 transition-colors">
                        分享
                      </button>
                      {canEdit && (
                        <button
                          onClick={() => { setUploadTarget(a); setView("upload-new-version"); }}
                          className="rounded-lg px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-50 transition-colors">
                          新版本
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={() => handleDeleteAsset(a.id)}
                          disabled={deletingId === a.id}
                          className="rounded-lg px-2 py-1 text-[10px] text-red-400 hover:bg-red-50 transition-colors disabled:opacity-50">
                          删除
                        </button>
                      )}
                      <button onClick={() => toggleExpand(a.id)}
                        className="rounded-lg px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-50 transition-colors">
                        {isExp ? "▲" : "▼"}
                      </button>
                    </div>
                  </div>

                  {/* Expanded mounts */}
                  {isExp && (
                    <div className="border-t border-zinc-50 px-4 py-3">
                      <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase mb-2">挂载点</p>
                      {loadingMounts[a.id] ? (
                        <p className="text-xs text-zinc-400">加载中…</p>
                      ) : (mounts[a.id] ?? []).length === 0 ? (
                        <p className="text-xs text-zinc-400">暂无挂载点</p>
                      ) : (
                        <div className="space-y-1">
                          {(mounts[a.id] ?? []).map(m => (
                            <div key={m.id} className="flex items-center justify-between gap-2">
                              <p className="text-[11px] text-zinc-500 truncate">{mountLabel(m)}</p>
                              {canEdit && (
                                <button
                                  onClick={() => handleDeleteMount(a.id, m.id)}
                                  className="shrink-0 text-[10px] text-red-400 hover:text-red-600 transition-colors">
                                  移除
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {shareTarget && (
        <AssetShareModal
          productionId={productionId}
          assetId={shareTarget.id}
          assetName={shareTarget.name ?? shareTarget.fileName}
          userName={userName}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
