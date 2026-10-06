"use client";

import { useState, useEffect, useCallback } from "react";
import ProductionModuleTopMenu, {
  PRODUCTION_MODULE_ACTION_CLASS,
  PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS,
} from "@/components/shell/ProductionModuleTopMenu";
import Link from "next/link";
import AssetUploadPanel from "./AssetUploadPanel";
import RelatedWikiChips from "@/components/wiki/RelatedWikiChips";
import AssetShareModal from "./AssetShareModal";
import styles from "./assets-page.module.css";
import { BASE_PATH } from "@/lib/base-path";
import { useRouter } from "next/navigation";
import type { Asset } from "@/lib/asset/db";
import type { NodeMount } from "@/lib/node/mount";
import { ASSET_TYPE_LABELS, type AssetType } from "@/lib/asset/types";
import ChevronIcon from "@/components/ui/ChevronIcon";

/** 列表项：Asset + 壳节点树面（#420：listable=原「项目全局」共享语义）
 *  + 工作台字段（PR-C：treePath=祖先链标题、sizeBytes=全部文件行合计） */
type AssetListItem = Asset & {
  nodeId: string | null; listable: boolean;
  treePath: string[]; sizeBytes: number | null;
  actions: {
    metaEdit: boolean; delete: boolean; addVersion: boolean; download: boolean;
    share: boolean; unmount: boolean; externalShare: boolean; externalShareCreate: boolean;
    listableOn: boolean; listableOff: boolean;
  };
};

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

type View = "all" | "upload-new-version";

interface Props {
  productionId: string;
  versionId: string | null;
  myUserId: string;
  userName: string;
  members: { userId: string; name: string }[];
  departments: { id: string; name: string }[];
}

export default function AssetPageClient({ productionId, versionId, myUserId, userName, members, departments }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [stats, setStats] = useState<{ totalBytes: number; unknownFiles: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mounts, setMounts] = useState<Record<string, NodeMount[]>>({});
  const [loadingMounts, setLoadingMounts] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>("all");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<Asset | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<AssetListItem | null>(null);
  const [moreTargetId, setMoreTargetId] = useState<string | null>(null);
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
    router.refresh();
  }

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${BASE_PATH}/api/production/${productionId}/assets`)
      .then(r => r.json())
      .then((j: { assets?: AssetListItem[]; stats?: { totalBytes: number; unknownFiles: number } }) => {
        setAssets(j.assets ?? []);
        setStats(j.stats ?? null);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [productionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const reload = (event: Event) => {
      if ((event as CustomEvent<{ productionId?: string }>).detail?.productionId === productionId) load();
    };
    window.addEventListener("asset-upload-complete", reload);
    return () => window.removeEventListener("asset-upload-complete", reload);
  }, [load, productionId]);

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
      const response = await fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        alert(body.error ?? "删除失败");
        return;
      }
      setAssets(p => p.filter(a => a.id !== assetId));
    } catch {
      alert("网络错误，删除没有成功，请检查连接后重试");
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
    const j = await r.json() as { url?: string; feishuUrl?: string; error?: string };
    if (!r.ok) { alert(j.error ?? "下载失败"); return; }
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
        {/* #456：把目标资产传下去——否则面板走的是「创建新资产」端点，
            界面上点「新版本」实际会多出一个全新 asset */}
        <AssetUploadPanel
          productionId={productionId}
          targetAssetId={uploadTarget.id}
          detachOnStart
          onTaskStarted={() => { setView("all"); setUploadTarget(null); }}
          onUploaded={() => { setView("all"); setUploadTarget(null); load(); }}
          onCancel={() => { setView("all"); setUploadTarget(null); }}
        />
      </div>
    </div>
  );

  return (
    <div className={styles.page}>
      <ProductionModuleTopMenu
        label="资产工作台"
        primaryAction={<button type="button" onClick={() => setShowUploadModal(true)} className={PRODUCTION_MODULE_ACTION_CLASS}>＋ 上传新 Asset</button>}
        primaryShortAction={<button type="button" aria-label="上传新 Asset" onClick={() => setShowUploadModal(true)} className={PRODUCTION_MODULE_ACTION_CLASS}>＋</button>}
        primaryOverflowAction={<button type="button" onClick={() => setShowUploadModal(true)} className={PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS}>上传新 Asset</button>}
      />

      {/* 存储占用（#429：现查不物化；含历史版本文件，口径见 #428） */}
      {stats && stats.totalBytes > 0 && (
        <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 10px 2px" }}>
          存储占用 {formatBytes(stats.totalBytes)}（含历史版本
          {stats.unknownFiles > 0 ? `；${stats.unknownFiles} 个文件大小未知` : ""}）
        </p>
      )}

      {/* 目录列出只披露标题；内容访问由分享、公开、挂载判定。 */}
      <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <p className="text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">对全员列出</p>
          {assets.some(a => a.actions.listableOn) && (
            <button onClick={() => setSharePickOpen(v => !v)}
              className="inline-flex min-h-8 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900">
              {sharePickOpen ? "完成" : "+ 添加"}
            </button>
          )}
        </div>
        {assets.filter(a => a.listable).length === 0 ? (
          <p className="text-xs text-zinc-400">暂无对全员列出的资产（列出后全体成员能在云文档里看到条目；内容访问仍按权限）</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {assets.filter(a => a.listable).map(a => (
              <span key={a.id}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
                <Link href={`/production/${productionId}/assets/${a.id}/preview`} className="hover:text-zinc-900 truncate max-w-[160px]">
                  {a.name ?? a.fileName}
                </Link>
                <button onClick={() => setAssetListable(a, false)} disabled={!a.actions.listableOff}
                  title={a.actions.listableOff ? "停止在目录中列出" : "需要该资产的分享管理权"}
                  className="text-zinc-300 hover:text-red-400 leading-none disabled:cursor-not-allowed disabled:opacity-40">×</button>
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
                disabled={!a.actions.listableOn}
                title={a.actions.listableOn ? "在目录中列出" : "需要该资产的分享管理权"}
                className="block w-full px-3 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-50 truncate disabled:cursor-not-allowed disabled:opacity-40">
                {a.name ?? a.fileName}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Filter + Search */}
      <div className={styles.filterBar}>
        <input
          type="text"
          placeholder="搜索文件名或类型…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={styles.searchInput}
        />
        <div className={styles.filterTabs}>
          {(["all", "mine"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={styles.filterTab}
              style={{
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
        <div className={styles.assetList}>
          {displayedAssets.map(a => {
            const isExp = expanded === a.id;

            return (
              <div key={a.id} className={`${styles.assetCard} ${isExp ? styles.assetCardExpanded : ""}`}>
                {/* Main row */}
                <div className={styles.assetRow}>
                  {/* Thumb / icon */}
                  <div className={styles.assetThumb}>
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

                  <div className={styles.assetInfo}>
                    <Link
                      href={`/production/${productionId}/assets/${a.id}/preview${versionId ? `?v=${versionId}` : ""}`}
                      className={styles.assetName}
                    >
                      {a.name ?? a.fileName}
                    </Link>
                    <div className={styles.assetMeta}>
                      {a.name && <span className={styles.fileName}>{a.fileName}</span>}
                      <span>{ASSET_TYPE_LABELS[a.assetType]}</span>
                      {a.sizeBytes != null && a.sizeBytes > 0 && (
                        <span>{formatBytes(a.sizeBytes)}</span>
                      )}
                      {a.storageType === "feishu_link" && (
                        <span className={styles.sourceTag}>飞书</span>
                      )}
                      {a.nodeId && (
                        <Link href={`/production/${productionId}/wiki/${a.nodeId}`}
                          title="在云文档中查看"
                          className={styles.treePath}>
                          📁 {[...a.treePath, ""].join(" / ")}{a.name ?? a.fileName}
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className={styles.actionBar}>
                    <button onClick={() => { if (a.actions.download) void handleDownload(a.id); }}
                      aria-disabled={!a.actions.download}
                      title={a.actions.download ? "下载原件" : "需要原件下载权"}
                      className={styles.actionButton}>下载</button>
                    <button onClick={() => { if (a.actions.metaEdit) openEdit(a); }}
                      aria-disabled={!a.actions.metaEdit}
                      title={a.actions.metaEdit ? "编辑资产信息" : "需要资产元数据编辑权"}
                      className={styles.actionButton}>编辑</button>
                    <button onClick={() => { if (a.actions.delete && deletingId !== a.id) void handleDeleteAsset(a.id); }}
                      aria-disabled={!a.actions.delete || deletingId === a.id}
                      title={a.actions.delete ? (deletingId === a.id ? "删除中…" : "删除资产") : "需要资产删除权"}
                      className={`${styles.actionButton} ${styles.dangerAction}`}>删除</button>
                    <button onClick={() => { if (a.actions.share || a.actions.externalShare) setShareTarget(a); }}
                      aria-disabled={!a.actions.share && !a.actions.externalShare}
                      title={a.actions.share || a.actions.externalShare ? "分享" : "需要站内分享管理权或对外分享资格"}
                      className={styles.actionButton}>分享</button>
                    <button
                      onClick={() => {
                        if (!a.actions.addVersion) return;
                        setUploadTarget(a);
                        setView("upload-new-version");
                      }}
                      aria-disabled={!a.actions.addVersion}
                      title={a.actions.addVersion ? "上传新版本" : (a.fileVersionPolicy !== "append" ? "此资产不支持追加新版本" : "需要文件版本创建权")}
                      className={`${styles.actionButton} ${styles.desktopSecondary}`}>
                      新版本
                    </button>
                    <button onClick={() => toggleExpand(a.id)}
                      title={isExp ? "收起关联详情" : "查看关联详情"}
                      className={`${styles.actionButton} ${styles.desktopSecondary}`}>
                      <ChevronIcon direction={isExp ? "up" : "down"} size={12} />
                    </button>
                    <div className={styles.moreWrap}
                      onBlur={event => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMoreTargetId(null);
                      }}>
                      <button type="button" onClick={() => setMoreTargetId(current => current === a.id ? null : a.id)}
                        aria-expanded={moreTargetId === a.id}
                        aria-label={`更多操作：${a.name ?? a.fileName}`}
                        className={styles.actionButton}>更多</button>
                      {moreTargetId === a.id && (
                        <div className={styles.moreMenu} role="menu">
                          <button type="button" role="menuitem"
                            aria-disabled={!a.actions.addVersion}
                            title={a.actions.addVersion ? "上传新版本" : (a.fileVersionPolicy !== "append" ? "此资产不支持追加新版本" : "需要文件版本创建权")}
                            className={styles.moreMenuButton}
                            onClick={() => {
                              if (!a.actions.addVersion) return;
                              setMoreTargetId(null);
                              setUploadTarget(a);
                              setView("upload-new-version");
                            }}>新版本</button>
                          <button type="button" role="menuitem" className={styles.moreMenuButton}
                            onClick={() => { setMoreTargetId(null); toggleExpand(a.id); }}>
                            {isExp ? "收起关联详情" : "查看关联详情"}
                          </button>
                        </div>
                      )}
                    </div>
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
                            {(a.actions.unmount || m.createdBy === myUserId) && (
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
              detachOnStart
              onTaskStarted={() => setShowUploadModal(false)}
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
                  {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][])
                    .filter(([v]) => v !== "financial_document")
                    .map(([v, l]) => (
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
          members={members}
          departments={departments}
          canShareInternally={shareTarget.actions.share}
          canManageExternalShare={shareTarget.actions.externalShare}
          canCreateExternalShare={shareTarget.actions.externalShareCreate}
          onClose={() => { setShareTarget(null); load(); }}
        />
      )}
    </div>
  );
}
