"use client";

import { useState, useEffect } from "react";
import type { Asset } from "@/lib/asset/db";
import type { MountType } from "@/lib/node/mount";
import { ASSET_TYPE_LABELS } from "@/lib/asset/types";
import { BASE_PATH } from "@/lib/base-path";

export type MountContext = {
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  label: string;
};


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
      // #420：挂载一律锚稳定 id（版本纪律），模式/目录/版本参数全部退役
      const body: Record<string, unknown> = {
        mountType: mountCtx.mountType,
        mountId: mountCtx.mountId,
        mountAuxId: mountCtx.mountAuxId ?? null,
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
                </p>
              </div>
            </button>
          ))}
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
