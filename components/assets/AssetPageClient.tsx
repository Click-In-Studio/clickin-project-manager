"use client";

import { useState, useEffect, useCallback } from "react";
import PageHeader, { PRIMARY_BTN } from "@/components/PageHeader";
import Link from "next/link";
import AssetUploadPanel from "./AssetUploadPanel";
import RelatedWikiChips from "@/components/wiki/RelatedWikiChips";
import AssetShareModal from "./AssetShareModal";
import { BASE_PATH } from "@/lib/base-path";
import type { Asset } from "@/lib/asset/db";
import type { NodeMount } from "@/lib/node/mount";
import { ASSET_TYPE_LABELS, type AssetType } from "@/lib/asset/types";
import ChevronIcon from "@/components/ChevronIcon";

/** 列表项：Asset + 壳节点树面（#420：listable=原「项目全局」共享语义） */
type AssetListItem = Asset & { nodeId: string | null; listable: boolean };

type View = "all" | "upload-new-version";

interface Props {
  productionId: string;
  versionId: string | null;
  myUserId: string;
  isAdmin: boolean;
  userName: string;
}

export default function AssetPageClient({ productionId, versionId, myUserId, isAdmin, userName }: Props) {
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mounts, setMounts] = useState<Record<string, NodeMount[]>>({});
  const [loadingMounts, setLoadingMounts] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>("all");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<Asset | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<Asset | null>(null);
  const [editTarget, setEditTarget] = useState<Asset | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<AssetType>("reference");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [search, setSearch] = useState("");
  const [sharePickOpen, setSharePickOpen] = useState(false);

  async function setAssetListable(a: AssetListItem, listable: boolean) {
    if (!a.nodeId) return;
    const r = await fetch(`${BASE_PATH}/api/production/${productionId}/node/${a.nodeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listable }),
    });
    if (!r.ok) { alert((await r.json()).error ?? "操作失败"); return; }
    setAssets(p => p.map(x => x.id === a.id ? { ...x, listable } : x));
  }

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${BASE_PATH}/api/production/${productionId}/assets`)
      .then(r => r.json())
      .then((j: { assets?: AssetListItem[] }) => setAssets(j.assets ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [productionId]);

  useEffect(() => { load(); }, [load]);

  async function loadMounts(assetId: string) {
    if (mounts[assetId] || loadingMounts[assetId]) return;
    setLoadingMounts(p => ({ ...p, [assetId]: true }));
    try {
      const r = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/mounts`);
      const j = await r.json() as { mounts?: NodeMount[] };
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

  function openEdit(a: Asset) {
    setEditTarget(a);
    setEditName(a.name ?? "");
    setEditType(a.assetType);
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const r = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() || null, assetType: editType }),
      });
      const j = await r.json() as { asset?: Asset; error?: string };
      if (!r.ok || !j.asset) { setEditError(j.error ?? "保存失败"); return; }
      const updated = j.asset;
      setAssets(p => p.map(a => a.id === updated.id ? { ...a, ...updated } : a));
      setEditTarget(null);
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditSaving(false);
    }
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
    if (filter === "mine" && a.uploaderUserId !== myUserId) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(a.name ?? a.fileName).toLowerCase().includes(q) && !ASSET_TYPE_LABELS[a.assetType].includes(q)) return false;
    }
    return true;
  });

  function mountLabel(m: NodeMount) {
    return `${m.mountType}:${m.mountId.slice(-6)}`;
  }

  // "新版本" 上传以模态框形式展示，不再整页切换
  const uploadModal = view === "upload-new-version" && uploadTarget && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.3)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { setView("all"); setUploadTarget(null); }}>
      <div style={{ background: "var(--surface)", borderRadius: 16, padding: 24, width: 360, boxShadow: "0 8px 32px rgba(0,0,0,.15)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>上传新版本</p>
          <button onClick={() => { setView("all"); setUploadTarget(null); }}
            style={{ fontSize: 18, color: "var(--muted)", background: "none", border: 0, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 16 }}>
          为 <span style={{ fontWeight: 600, color: "var(--ink)" }}>{uploadTarget.fileName}</span> 上传新版本
        </p>
        <AssetUploadPanel
          productionId={productionId}
          onUploaded={() => { setView("all"); setUploadTarget(null); load(); }}
          onCancel={() => { setView("all"); setUploadTarget(null); }}
        />
      </div>
    </div>
  );

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Page header（v3 统一页头） */}
      <PageHeader
        eyebrow="Assets"
        title="数字资产"
        side="script"
        actions={
          <button onClick={() => setShowUploadModal(true)} style={PRIMARY_BTN}>
            ＋ 上传新 Asset
          </button>
        }
      />

      {/* 共享资产（#420：原「项目全局」挂载 ≡ 节点可枚举/listable，树面开关） */}
      <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <p className="text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">共享资产</p>
          {isAdmin && (
            <button onClick={() => setSharePickOpen(v => !v)}
              className="inline-flex min-h-8 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900">
              {sharePickOpen ? "完成" : "+ 添加"}
            </button>
          )}
        </div>
        {assets.filter(a => a.listable).length === 0 ? (
          <p className="text-xs text-zinc-400">暂无共享资产（共享后全体成员可在文档树与此处看到）</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {assets.filter(a => a.listable).map(a => (
              <span key={a.id}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
                <Link href={`/production/${productionId}/assets/${a.id}/preview`} className="hover:text-zinc-900 truncate max-w-[160px]">
                  {a.name ?? a.fileName}
                </Link>
                {isAdmin && (
                  <button onClick={() => setAssetListable(a, false)} className="text-zinc-300 hover:text-red-400 leading-none">×</button>
                )}
              </span>
            ))}
          </div>
        )}
        {sharePickOpen && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-zinc-100">
            {assets.filter(a => !a.listable && a.nodeId).length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-400">没有可添加的资产</p>
            ) : assets.filter(a => !a.listable && a.nodeId).map(a => (
              <button key={a.id} onClick={() => setAssetListable(a, true)}
                className="block w-full px-3 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-50 truncate">
                {a.name ?? a.fileName}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Filter + Search */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="搜索文件名或类型…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface)", padding: "7px 12px", fontSize: 13, outline: "none", color: "var(--ink)" }}
        />
        <div style={{ display: "flex", borderRadius: 8, border: "1px solid var(--line)", overflow: "hidden", fontSize: 12 }}>
          {(["all", "mine"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ padding: "7px 16px", fontWeight: 600, cursor: "pointer", border: 0, transition: "all .1s",
                background: filter === f ? "var(--ink)" : "white",
                color: filter === f ? "#fff" : "var(--muted)" }}>
              {f === "all" ? "全部" : "我的上传"}
            </button>
          ))}
        </div>
      </div>

      {/* Asset list */}
      {loading ? (
        <p style={{ padding: "40px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>加载中…</p>
      ) : error ? (
        <p style={{ padding: "40px 0", textAlign: "center", fontSize: 12, color: "#dc2626" }}>{error}</p>
      ) : displayedAssets.length === 0 ? (
        <p style={{ padding: "40px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>暂无数字资产</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {displayedAssets.map(a => {
            const isOwner = a.uploaderUserId === myUserId;
            const canEdit = isOwner || isAdmin;
            const isExp = expanded === a.id;

            return (
              <div key={a.id} style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", overflow: "hidden" }}>
                {/* Main row */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                  {/* Thumb / icon */}
                  <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--paper)", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", overflow: "hidden" }}>
                    {a.storageType === "feishu_link" ? (
                      <span>飞</span>
                    ) : a.mimeType?.startsWith("image/") ? (
                      <img
                        src={`${BASE_PATH}/api/production/${productionId}/assets/${a.id}/thumb${versionId ? `?v=${versionId}` : ""}`}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <span>{a.fileName.split(".").pop()?.slice(0, 4) ?? "?"}</span>
                    )}
                  </div>

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Link
                      href={`/production/${productionId}/assets/${a.id}/preview${versionId ? `?v=${versionId}` : ""}`}
                      style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {a.name ?? a.fileName}
                    </Link>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                      {a.name && <span style={{ fontSize: 10, color: "var(--muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.fileName}</span>}
                      <span style={{ fontSize: 10, color: "var(--muted)" }}>{ASSET_TYPE_LABELS[a.assetType]}</span>
                      {a.storageType === "feishu_link" && (
                        <span style={{ borderRadius: 4, padding: "1px 5px", fontSize: 9, background: "#eff6ff", color: "#3b82f6", fontWeight: 600 }}>飞书</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                    {(["下载", "分享"] as const).map(label => (
                      <button key={label}
                        onClick={() => label === "下载" ? handleDownload(a.id) : setShareTarget(a)}
                        style={{ borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
                        {label}
                      </button>
                    ))}
                    {canEdit && (
                      <button
                        onClick={() => openEdit(a)}
                        style={{ borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
                        编辑
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => { setUploadTarget(a); setView("upload-new-version"); }}
                        style={{ borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
                        新版本
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => handleDeleteAsset(a.id)}
                        disabled={deletingId === a.id}
                        style={{ borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "#dc2626", background: "none", border: 0, cursor: "pointer", opacity: deletingId === a.id ? 0.5 : 1 }}>
                        删除
                      </button>
                    )}
                    <button onClick={() => toggleExpand(a.id)}
                      style={{ borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--muted)", background: "none", border: 0, cursor: "pointer" }}>
                      <ChevronIcon direction={isExp ? "up" : "down"} size={12} />
                    </button>
                  </div>
                </div>

                {/* Expanded mounts */}
                {isExp && (
                  <div style={{ borderTop: "1px solid var(--line)", padding: "12px 16px" }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>挂载点</p>
                    {loadingMounts[a.id] ? (
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>加载中…</p>
                    ) : (mounts[a.id] ?? []).length === 0 ? (
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>暂无挂载点</p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {(mounts[a.id] ?? []).map(m => (
                          <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                            <p style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mountLabel(m)}</p>
                            {canEdit && (
                              <button
                                onClick={() => handleDeleteMount(a.id, m.id)}
                                style={{ flexShrink: 0, fontSize: 10, color: "#dc2626", background: "none", border: 0, cursor: "pointer" }}>
                                移除
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3">
                      <RelatedWikiChips productionId={productionId} entityType="asset" entityId={a.id} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showUploadModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.3)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowUploadModal(false)}>
          <div style={{ background: "var(--surface)", borderRadius: 16, padding: 24, width: 400, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,.15)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>上传新 Asset</p>
              <button onClick={() => setShowUploadModal(false)}
                style={{ fontSize: 18, color: "var(--muted)", background: "none", border: 0, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <AssetUploadPanel
              productionId={productionId}
              choosePlacement
              allowMarkdownAsWiki
              onUploadedWiki={({ wikiId }) => {
                setShowUploadModal(false);
                window.location.href = `${BASE_PATH}/production/${productionId}/wiki/${wikiId}`;
              }}
              onUploaded={() => { setShowUploadModal(false); load(); }}
              onCancel={() => setShowUploadModal(false)}
            />
          </div>
        </div>
      )}

      {uploadModal}

      {editTarget && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.3)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !editSaving && setEditTarget(null)}>
          <div style={{ background: "var(--surface)", borderRadius: 16, padding: 24, width: 360, boxShadow: "0 8px 32px rgba(0,0,0,.15)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>编辑 Asset</p>
              <button onClick={() => setEditTarget(null)} disabled={editSaving}
                style={{ fontSize: 18, color: "var(--muted)", background: "none", border: 0, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>显示名称（留空则使用文件名）</label>
                <input
                  type="text"
                  placeholder={editTarget.fileName}
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleSaveEdit(); }}
                  autoFocus
                  style={{ width: "100%", borderRadius: 8, border: "1px solid var(--line)", background: "white", padding: "7px 12px", fontSize: 13, outline: "none", color: "var(--ink)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>类型</label>
                <select
                  value={editType}
                  onChange={e => setEditType(e.target.value as AssetType)}
                  style={{ width: "100%", borderRadius: 8, border: "1px solid var(--line)", background: "white", padding: "7px 12px", fontSize: 13, outline: "none", color: "var(--ink)" }}>
                  {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][]).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              {editError && <p style={{ fontSize: 11, color: "#dc2626" }}>{editError}</p>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setEditTarget(null)} disabled={editSaving}
                  style={{ borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 600, color: "var(--muted)", background: "none", border: "1px solid var(--line)", cursor: "pointer" }}>
                  取消
                </button>
                <button onClick={handleSaveEdit} disabled={editSaving}
                  style={{ borderRadius: 8, padding: "7px 16px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--ink)", border: 0, cursor: "pointer", opacity: editSaving ? 0.5 : 1 }}>
                  {editSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
