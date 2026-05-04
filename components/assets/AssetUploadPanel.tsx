"use client";

import { useState, useRef } from "react";
import type { AssetType } from "@/lib/asset-db";
import { BASE_PATH } from "@/lib/base-path";

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

type UploadMode = "file" | "feishu";

export type UploadResult = {
  assetId: string;
  name: string | null;
  fileName: string;
  assetType: AssetType;
  storageType: "r2" | "feishu_link";
};

interface Props {
  productionId: string;
  versionId?: string | null;
  onUploaded: (result: UploadResult) => void;
  onCancel?: () => void;
}

export default function AssetUploadPanel({ productionId, versionId, onUploaded, onCancel }: Props) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [assetType, setAssetType] = useState<AssetType>("reference");
  const [name, setName] = useState("");
  const [isUniversal, setIsUniversal] = useState(true);
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuName, setFeishuName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSubmit() {
    setError(null);
    setLoading(true);
    try {
      const base = `${BASE_PATH}/api/production/${productionId}/assets`;
      let res: Response;

      if (mode === "feishu") {
        if (!feishuUrl.trim() || !feishuName.trim()) {
          setError("请填写飞书链接和文件名");
          setLoading(false);
          return;
        }
        res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageType: "feishu_link",
            feishuUrl: feishuUrl.trim(),
            fileName: feishuName.trim(),
            name: name.trim() || null,
            assetType,
            isUniversal,
            versionId: isUniversal ? null : (versionId ?? null),
          }),
        });
      } else {
        if (!file) {
          setError("请选择文件");
          setLoading(false);
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        fd.append("assetType", assetType);
        if (name.trim()) fd.append("name", name.trim());
        fd.append("isUniversal", String(isUniversal));
        if (!isUniversal && versionId) fd.append("versionId", versionId);
        res = await fetch(base, { method: "POST", body: fd });
      }

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? `上传失败 (${res.status})`);
        return;
      }
      const j = await res.json() as { asset: { id: string; name: string | null; fileName: string; assetType: AssetType; storageType: "r2" | "feishu_link" } };
      onUploaded({ assetId: j.asset.id, name: j.asset.name, fileName: j.asset.fileName, assetType: j.asset.assetType, storageType: j.asset.storageType });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-zinc-200 text-xs">
        {(["file", "feishu"] as UploadMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2 font-medium transition-colors ${
              mode === m ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
            }`}>
            {m === "file" ? "上传文件" : "飞书链接"}
          </button>
        ))}
      </div>

      {mode === "file" ? (
        <div>
          <div
            onClick={() => fileRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 py-8 cursor-pointer hover:border-zinc-400 transition-colors">
            {file ? (
              <>
                <p className="text-sm font-medium text-zinc-700">{file.name}</p>
                <p className="text-xs text-zinc-400">{(file.size / 1024).toFixed(1)} KB</p>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-400">点击选择文件</p>
                <p className="text-xs text-zinc-300">支持所有格式，图片自动生成缩略图</p>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" className="hidden"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            placeholder="飞书 Wiki 节点链接"
            value={feishuUrl}
            onChange={e => setFeishuUrl(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
          <input
            type="text"
            placeholder="文件名（必填）"
            value={feishuName}
            onChange={e => setFeishuName(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {/* Display name */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">显示名称（可选，留空则使用文件名）</label>
        <input
          type="text"
          placeholder={file?.name ?? (feishuName || "例：幕前幕后音响设计图纸 v3")}
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
        />
      </div>

      {/* Asset type */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">类型</label>
        <select
          value={assetType}
          onChange={e => setAssetType(e.target.value as AssetType)}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 bg-white">
          {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][]).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      {/* Version scope */}
      {versionId && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!isUniversal} onChange={e => setIsUniversal(!e.target.checked)}
            className="rounded" />
          <span className="text-xs text-zinc-600">绑定到当前版本</span>
        </label>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button onClick={onCancel} disabled={loading}
            className="flex-1 rounded-lg border border-zinc-200 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors">
            取消
          </button>
        )}
        <button onClick={handleSubmit} disabled={loading}
          className="flex-1 rounded-lg bg-zinc-800 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors">
          {loading ? "上传中…" : "确认上传"}
        </button>
      </div>
    </div>
  );
}
