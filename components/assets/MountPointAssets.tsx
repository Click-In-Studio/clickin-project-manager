"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Asset, AssetMount, MountType } from "@/lib/asset-db";
import AssetMountModal from "./AssetMountModal";
import type { MountContext } from "./AssetSelectPanel";

const ASSET_TYPE_LABELS: Record<string, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

type MountResult = { mount: AssetMount; asset: Asset };

interface Props {
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  versionId?: string | null;
  // For block_snapshot / cue_revision: the stable ID (blockId / cueId) needed for mount CoW
  stableId?: string | null;
  label: string;
  canEdit?: boolean;
  // compact: single-line chip list (for inline use in lists)
  // panel: full vertical list with add button below
  display?: "compact" | "panel";
  onNavigate?: () => void;
  onChange?: () => void;
}

export default function MountPointAssets({
  productionId, mountType, mountId, mountAuxId, versionId, stableId,
  label, canEdit = false, display = "panel", onNavigate, onChange,
}: Props) {
  const [results, setResults] = useState<MountResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const mountCtx: MountContext = {
    mountType, mountId, mountAuxId, versionId, stableId, label,
  };

  const load = useCallback(() => {
    const qs = new URLSearchParams({ type: mountType, id: mountId });
    if (mountAuxId != null) qs.set("auxId", mountAuxId);
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/by-mount?${qs}`)
      .then(r => r.json())
      .then((j: { results?: MountResult[] }) => setResults(j.results ?? []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [productionId, mountType, mountId, mountAuxId]);

  useEffect(() => { load(); }, [load]);

  function assetHref(asset: Asset): string {
    if (asset.storageType === "feishu_link" && asset.feishuUrl) return asset.feishuUrl;
    const qs = versionId ? `?v=${versionId}` : "";
    // Link already prepends basePath — don't add BASE_PATH here
    return `/production/${productionId}/assets/${asset.id}/preview${qs}`;
  }

  async function handleRemove(mount: AssetMount) {
    await fetch(
      `${BASE_PATH}/api/production/${productionId}/assets/${mount.assetId}/mounts/${mount.id}`,
      { method: "DELETE" }
    );
    setResults(p => p.filter(r => r.mount.id !== mount.id));
    onChange?.();
  }

  if (display === "compact") {
    if (loading) return null;
    return (
      <div className="flex flex-wrap items-center gap-1 mt-1">
        {results.map(({ mount, asset }) => (
          <span key={mount.id}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
            <Link
              href={assetHref(asset)}
              onNavigate={onNavigate}
              target={asset.storageType === "feishu_link" ? "_blank" : undefined}
              className="hover:text-zinc-900 truncate max-w-[120px]"
            >
              {asset.name ?? asset.fileName}
            </Link>
            {canEdit && (
              <button onClick={() => handleRemove(mount)} className="text-zinc-300 hover:text-red-400 leading-none">×</button>
            )}
          </span>
        ))}
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-600 transition-colors">
            + Asset
          </button>
        )}
        {showModal && (
          <AssetMountModal
            productionId={productionId}
            mountCtx={mountCtx}
            versionId={versionId}
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
        <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase">附件</p>
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="text-[10px] text-zinc-400 hover:text-zinc-600 transition-colors">
            + 添加
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-[10px] text-zinc-300">加载中…</p>
      ) : results.length === 0 ? (
        <p className="text-[10px] text-zinc-300">暂无附件</p>
      ) : (
        <div className="space-y-1">
          {results.map(({ mount, asset }) => (
            <div key={mount.id} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <Link
                  href={assetHref(asset)}
                  onNavigate={onNavigate}
                  target={asset.storageType === "feishu_link" ? "_blank" : undefined}
                  className="block text-xs font-medium text-zinc-700 hover:text-zinc-900 truncate"
                >
                  {asset.name ?? asset.fileName}
                </Link>
                <p className="text-[10px] text-zinc-400">
                  {ASSET_TYPE_LABELS[asset.assetType] ?? asset.assetType}
                  {asset.storageType === "feishu_link" ? " · 飞书" : ""}
                </p>
              </div>
              {canEdit && (
                <button onClick={() => handleRemove(mount)}
                  className="shrink-0 text-[10px] text-zinc-300 hover:text-red-400 transition-colors">
                  移除
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <AssetMountModal
          productionId={productionId}
          mountCtx={mountCtx}
          versionId={versionId}
          onDone={() => { setShowModal(false); load(); onChange?.(); }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
