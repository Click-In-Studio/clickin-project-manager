"use client";

// 挂载点四动作模态（#420 第二批 PR-B）：挂载资产 / 上传资产 / 挂载文档 / 新建文档。
// 资产两 tab 复用 AssetSelectPanel/AssetUploadPanel（上传完自动转到选择 tab 预选，
// 与 AssetMountModal 同款流转）；文档两 tab 见 WikiMountPanels。
// AssetMountModal 本身不动——CommentAssetPicker 等纯资产场景继续用它。
import { useState } from "react";
import AssetUploadPanel, { type UploadResult } from "./AssetUploadPanel";
import AssetSelectPanel, { type MountContext } from "./AssetSelectPanel";
import { WikiSelectPanel, WikiCreatePanel } from "@/components/wiki/WikiMountPanels";

type Tab = "asset-select" | "asset-upload" | "wiki-select" | "wiki-create";

const TAB_LABELS: Record<Tab, string> = {
  "asset-select": "挂载资产",
  "asset-upload": "上传资产",
  "wiki-select": "挂载文档",
  "wiki-create": "新建文档",
};

interface Props {
  productionId: string;
  mountCtx: MountContext;
  onDone: () => void;
  onClose: () => void;
}

export default function MountAttachModal({ productionId, mountCtx, onDone, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("asset-select");
  const [uploadedAssetId, setUploadedAssetId] = useState<string | null>(null);

  function handleUploadDone(result: UploadResult) {
    setUploadedAssetId(result.assetId);
    setTab("asset-select");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative z-10 w-full max-w-sm rounded-t-2xl sm:rounded-2xl bg-white shadow-xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase">添加附件</p>
            <p className="text-sm font-medium text-zinc-700">{mountCtx.label}</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-lg leading-none">✕</button>
        </div>

        <div className="grid grid-cols-4 rounded-lg overflow-hidden border border-zinc-200 text-xs mb-4">
          {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`py-2 font-medium transition-colors ${
                tab === t ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
              }`}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === "asset-upload" ? (
          <AssetUploadPanel
            productionId={productionId}
            onUploaded={handleUploadDone}
            onCancel={() => setTab("asset-select")}
          />
        ) : tab === "asset-select" ? (
          <AssetSelectPanel
            productionId={productionId}
            mountCtx={mountCtx}
            preSelectedId={uploadedAssetId}
            onMounted={() => onDone()}
            onCancel={onClose}
          />
        ) : tab === "wiki-select" ? (
          <WikiSelectPanel
            productionId={productionId}
            mountCtx={mountCtx}
            onMounted={() => onDone()}
            onCancel={onClose}
          />
        ) : (
          <WikiCreatePanel
            productionId={productionId}
            mountCtx={mountCtx}
            onMounted={() => onDone()}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}
