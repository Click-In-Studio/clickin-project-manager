"use client";

// 挂载点附件面板（#420 第二批 PR-B：泛化到 asset+wiki 两 kind）。
// 读 by-mount（服务端按 kind 各走内容面过滤）；添加走 MountAttachModal 四动作；
// 移除统一走通用 node 挂载路由（服务端按 kind 分派双门）。
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Asset } from "@/lib/asset/db";
import type { NodeMount, MountType } from "@/lib/node/mount";
import { ASSET_TYPE_LABELS } from "@/lib/asset/types";
import MountAttachModal from "./MountAttachModal";
import type { MountContext } from "./AssetSelectPanel";

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
}

export default function MountPointAssets({
  productionId, mountType, mountId, mountAuxId,
  label, canEdit = false, display = "panel", onNavigate, onChange,
}: Props) {
  const [entries, setEntries] = useState<MountEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

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
      <div className="flex flex-wrap items-center gap-1 mt-1">
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
    <div className="mt-3">
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
      ) : entries.length === 0 ? (
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
