"use client";

// 挂载点附件面板（#420 第二批 PR-B：泛化到 asset+wiki 两 kind）。
// 读 by-mount（服务端按 kind 各走内容面过滤）；添加走 MountAttachModal 四动作；
// 移除统一走通用 node 挂载路由（服务端按 kind 分派双门）。
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Asset } from "@/lib/asset/db";
import type { NodeMount, MountType } from "@/lib/node/mount";
import { ASSET_TYPE_LABELS } from "@/lib/asset/types";
import MountAttachModal from "./MountAttachModal";
import type { MountContext } from "./AssetSelectPanel";
import { useAssetUploadManager, type UploadTask } from "./asset-upload-manager";

type MountEntry = {
  mount: NodeMount;
  nodeId: string;
  kind: string;
  asset: Asset | null;
  wiki: { id: string; title: string | null } | null;
};

interface Props {
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  label: string;
  canEdit?: boolean;
  // compact: single-line chip list (for inline use in lists)
  // panel: full vertical list with add button below
  display?: "compact" | "panel";
  onNavigate?: () => void;
  onChange?: () => void;
  /** 可选的未完成编辑保护；仅调用方显式接入时，打开关联弹窗才阻止模式切换。 */
  unsavedGuardMessage?: string;
}

export default function MountPointAssets({
  productionId, mountType, mountId, mountAuxId,
  label, canEdit = false, display = "panel", onNavigate, onChange, unsavedGuardMessage,
}: Props) {
  const uploadManager = useAssetUploadManager();
  const [entries, setEntries] = useState<MountEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const handledUploads = useRef(new Set<string>());

  const mountCtx: MountContext = { mountType, mountId, mountAuxId, label };

  const load = useCallback(() => {
    const qs = new URLSearchParams({ type: mountType, id: mountId });
    if (mountAuxId != null) qs.set("auxId", mountAuxId);
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/by-mount?${qs}`)
      .then(r => r.json())
      .then((j: { results?: MountEntry[] }) => setEntries(j.results ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [productionId, mountType, mountId, mountAuxId]);

  useEffect(() => { load(); }, [load]);

  const pendingUploads = (uploadManager?.tasks ?? []).filter(task =>
    task.productionId === productionId
    && task.target.kind === "mount"
    && task.target.mountType === mountType
    && task.target.mountId === mountId
    && (task.target.mountAuxId ?? null) === (mountAuxId ?? null),
  );
  const visiblePendingUploads = pendingUploads.filter(task =>
    task.status !== "complete" || !task.result || !entries.some(entry => entry.asset?.id === task.result!.assetId),
  );

  useEffect(() => {
    const completed = pendingUploads.filter(task => task.status === "complete" && !handledUploads.current.has(task.id));
    if (completed.length === 0) return;
    for (const task of completed) handledUploads.current.add(task.id);
    load();
    onChange?.();
  }, [load, onChange, pendingUploads]);

  function uploadStatus(task: UploadTask): string {
    if (task.status === "failed") return task.error ?? "上传失败";
    if (task.status === "binding") return "正在挂载";
    if (task.status === "processing") return "处理中";
    if (task.status === "complete") return "已挂载";
    if (task.status === "cancelled") return "已取消";
    return task.progress == null ? "上传中" : `上传中 ${task.progress}%`;
  }

  function uploadAction(task: UploadTask) {
    if (!uploadManager) return null;
    if (task.status === "failed") return (
      <button type="button" onClick={() => uploadManager.retryTask(task.id)} className="text-zinc-500 hover:text-zinc-900">重试</button>
    );
    if (["queued", "uploading", "processing", "binding"].includes(task.status)) return (
      <button type="button" onClick={() => uploadManager.cancelTask(task.id)} className="text-zinc-400 hover:text-red-500">取消</button>
    );
    return (
      <button type="button" onClick={() => uploadManager.dismissTask(task.id)} className="text-zinc-400 hover:text-zinc-700">移除</button>
    );
  }

  function entryHref(e: MountEntry): string {
    if (e.asset) {
      if (e.asset.storageType === "feishu_link" && e.asset.feishuUrl) return e.asset.feishuUrl;
      // Link already prepends basePath — don't add BASE_PATH here
      return `/production/${productionId}/assets/${e.asset.id}/preview`;
    }
    return `/production/${productionId}/wiki/${e.wiki!.id}`;
  }

  function entryTitle(e: MountEntry): string {
    if (e.asset) return e.asset.name ?? e.asset.fileName;
    return e.wiki!.title ?? "无标题";
  }

  function entrySubtitle(e: MountEntry): string {
    if (e.asset) {
      return (ASSET_TYPE_LABELS[e.asset.assetType] ?? e.asset.assetType)
        + (e.asset.storageType === "feishu_link" ? " · 飞书" : "");
    }
    return "文档";
  }

  async function handleRemove(e: MountEntry) {
    await fetch(
      `${BASE_PATH}/api/production/${productionId}/node/${e.nodeId}/mounts/${e.mount.id}`,
      { method: "DELETE" }
    );
    setEntries(p => p.filter(r => r.mount.id !== e.mount.id));
    onChange?.();
  }

  if (display === "compact") {
    if (loading) return null;
    return (
      <div
        data-dramaturgy-unsaved={showModal && unsavedGuardMessage ? "true" : undefined}
        data-dramaturgy-unsaved-message={unsavedGuardMessage}
        className="flex flex-wrap items-center gap-1 mt-1"
      >
        {entries.map(e => (
          <span key={e.mount.id}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
            {e.wiki && <span className="text-zinc-400">📄</span>}
            <Link
              href={entryHref(e)}
              onNavigate={onNavigate}
              target={e.asset?.storageType === "feishu_link" ? "_blank" : undefined}
              className="hover:text-zinc-900 truncate max-w-[120px]"
            >
              {entryTitle(e)}
            </Link>
            {canEdit && (
              <button onClick={() => handleRemove(e)} className="text-zinc-300 hover:text-red-400 leading-none">×</button>
            )}
          </span>
        ))}
        {visiblePendingUploads.map(task => (
          <span key={task.id} className="inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-500">
            <span className="max-w-[100px] truncate">{task.fileName}</span>
            <span>{uploadStatus(task)}</span>
            {uploadAction(task)}
          </span>
        ))}
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300">
            + 添加
          </button>
        )}
        {showModal && (
          <MountAttachModal
            productionId={productionId}
            mountCtx={mountCtx}
            onDone={() => { setShowModal(false); load(); onChange?.(); }}
            onClose={() => setShowModal(false)}
          />
        )}
      </div>
    );
  }

  // panel display
  return (
    <div
      data-dramaturgy-unsaved={showModal && unsavedGuardMessage ? "true" : undefined}
      data-dramaturgy-unsaved-message={unsavedGuardMessage}
      className="mt-3"
    >
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-semibold tracking-[0.08em] text-zinc-600 uppercase">附件</p>
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="inline-flex min-h-8 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300">
            + 添加
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-zinc-400">加载中…</p>
      ) : entries.length === 0 && visiblePendingUploads.length === 0 ? (
        <p className="text-xs text-zinc-400">暂无附件</p>
      ) : (
        <div className="space-y-1">
          {entries.map(e => (
            <div key={e.mount.id} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <Link
                  href={entryHref(e)}
                  onNavigate={onNavigate}
                  target={e.asset?.storageType === "feishu_link" ? "_blank" : undefined}
                  className="block text-xs font-medium text-zinc-700 hover:text-zinc-900 truncate"
                >
                  {e.wiki ? "📄 " : ""}{entryTitle(e)}
                </Link>
                <p className="text-[10px] text-zinc-400">{entrySubtitle(e)}</p>
              </div>
              {canEdit && (
                <button onClick={() => handleRemove(e)}
                  className="shrink-0 text-xs text-zinc-400 hover:text-red-500 transition-colors">
                  移除
                </button>
              )}
            </div>
          ))}
          {visiblePendingUploads.map(task => (
            <div key={task.id} className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-white px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-zinc-600">{task.fileName}</p>
                <p className={task.status === "failed" ? "text-[10px] text-red-600" : "text-[10px] text-zinc-400"}>{uploadStatus(task)}</p>
              </div>
              <span className="shrink-0 text-[10px]">{uploadAction(task)}</span>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <MountAttachModal
          productionId={productionId}
          mountCtx={mountCtx}
          onDone={() => { setShowModal(false); load(); onChange?.(); }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
