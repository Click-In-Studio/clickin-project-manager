"use client";

import { useState, useEffect } from "react";
import type { Asset, AssetType, MountType, MountMode } from "@/lib/asset-db";
import { BASE_PATH } from "@/lib/base-path";

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

export type MountContext = {
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  versionId?: string | null;
  stableId?: string | null; // blockId or cueId for inherit mode
  label: string;
};

type VersionRelMode = "version_only" | "tracking" | "inherit";

// Whether a mount type supports version-controlled splitting
function isSplittable(mt: MountType): mt is "block_snapshot" | "cue_revision" {
  return mt === "block_snapshot" || mt === "cue_revision";
}


interface Props {
  productionId: string;
  mountCtx: MountContext;
  preSelectedId?: string | null;
  selectOnly?: boolean;
  onMounted: (assetId: string, label: string) => void;
  onCancel?: () => void;
}

export default function AssetSelectPanel({ productionId, mountCtx, preSelectedId, selectOnly, onMounted, onCancel }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(preSelectedId ?? null);
  // Only block/cue snapshot types support CoW-based tracking across versions
  const supportsCow = (["block", "block_snapshot", "cue", "cue_revision"] as MountType[]).includes(mountCtx.mountType);
  const hasVersion = !!mountCtx.versionId;
  const [mountMode, setMountMode] = useState<VersionRelMode>(
    !hasVersion ? "inherit" : supportsCow ? "tracking" : "version_only"
  );
  const [folderPath, setFolderPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/assets`)
      .then(r => r.json())
      .then((j: { assets?: Asset[] }) => setAssets(j.assets ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [productionId]);

  const filtered = assets.filter(a => {
    const q = search.toLowerCase();
    return !q ||
      (a.name ?? a.fileName).toLowerCase().includes(q) ||
      ASSET_TYPE_LABELS[a.assetType].includes(q);
  });

  async function handleMount() {
    if (!selected) return;
    const asset = assets.find(a => a.id === selected);
    const label = asset ? (asset.name ?? asset.fileName) : selected;

    if (selectOnly) {
      onMounted(selected, label);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const effectiveMountType = mountMode === "inherit" && isSplittable(mountCtx.mountType)
        ? (mountCtx.mountType === "block_snapshot" ? "block" : "cue")
        : mountCtx.mountType;

      const effectiveMountId = mountMode === "inherit" && isSplittable(mountCtx.mountType)
        ? (mountCtx.stableId ?? mountCtx.mountId)
        : mountCtx.mountId;

      const body: Record<string, unknown> = {
        mountType: effectiveMountType,
        mountId: effectiveMountId,
        mountAuxId: mountCtx.mountAuxId ?? null,
        folderPath: folderPath.trim() || null,
        mountMode: mountMode !== "inherit" ? mountMode : null,
        versionId: mountCtx.versionId ?? null,
      };

      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/assets/${selected}/mounts`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? `挂载失败 (${res.status})`);
        return;
      }
      onMounted(selected, label);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="搜索文件名或类型…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
      />

      {loading ? (
        <p className="py-6 text-center text-xs text-zinc-400">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-xs text-zinc-400">暂无 Asset</p>
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-1 rounded-xl border border-zinc-100">
          {filtered.map(a => (
            <button key={a.id}
              onClick={() => setSelected(selected === a.id ? null : a.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                selected === a.id ? "bg-zinc-800 text-white" : "hover:bg-zinc-50 text-zinc-700"
              }`}>
              {/* Thumbnail placeholder / icon */}
              <div className={`w-8 h-8 rounded flex-shrink-0 flex items-center justify-center text-[10px] font-bold uppercase ${
                selected === a.id ? "bg-zinc-700 text-zinc-200" : "bg-zinc-100 text-zinc-400"
              }`}>
                {a.storageType === "feishu_link" ? "飞" : a.fileName.split(".").pop()?.slice(0, 3) ?? "?"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{a.name ?? a.fileName}</p>
                <p className={`text-[10px] truncate ${selected === a.id ? "text-zinc-300" : "text-zinc-400"}`}>
                  {a.name ? `${a.fileName} · ` : ""}{ASSET_TYPE_LABELS[a.assetType]}
                  {a.isUniversal ? "" : " · 版本相关"}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Mount mode selector */}
      {selected && !selectOnly && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">挂载模式</label>
          <div className="flex rounded-lg overflow-hidden border border-zinc-200 text-xs">
            {(["tracking", "version_only", "inherit"] as VersionRelMode[]).map(m => {
              const disabled =
                (m === "tracking" && (!hasVersion || !supportsCow)) ||
                (m === "version_only" && !hasVersion);
              return (
                <button key={m} onClick={() => !disabled && setMountMode(m)}
                  disabled={disabled}
                  className={`flex-1 py-2 font-medium transition-colors ${
                    mountMode === m
                      ? "bg-zinc-800 text-white"
                      : disabled
                        ? "bg-zinc-50 text-zinc-300 cursor-not-allowed"
                        : "bg-white text-zinc-500 hover:bg-zinc-50"
                  }`}>
                  {m === "tracking" ? "跟踪" : m === "version_only" ? "当前版本" : "继承"}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-zinc-400">
            {mountMode === "tracking" && "当前版本及以后都可见，CoW 分裂时自动跟踪"}
            {mountMode === "version_only" && "仅当前版本可见"}
            {mountMode === "inherit" && "所有版本共享"}
          </p>
          {!hasVersion && (
            <p className="mt-1 text-[10px] text-amber-500">无版本上下文，当前版本/跟踪模式不可用</p>
          )}
          {hasVersion && !supportsCow && (
            <p className="mt-1 text-[10px] text-zinc-400">此挂载点不支持跟踪模式（无 CoW 机制）</p>
          )}
        </div>
      )}

      {/* Folder path — only for production mount */}
      {!selectOnly && (mountCtx.mountType === "production" || mountCtx.mountType === "version") && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">文件夹路径（可选）</label>
          <input
            type="text"
            placeholder="如：设计/平面图"
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button onClick={onCancel} disabled={submitting}
            className="flex-1 rounded-lg border border-zinc-200 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors">
            取消
          </button>
        )}
        <button onClick={handleMount} disabled={!selected || submitting}
          className="flex-1 rounded-lg bg-zinc-800 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 transition-colors">
          {selectOnly ? "选择" : submitting ? "挂载中…" : "确认挂载"}
        </button>
      </div>
    </div>
  );
}
