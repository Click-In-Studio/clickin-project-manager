"use client";

import { useState } from "react";
import AssetUploadPanel, { type UploadResult } from "./AssetUploadPanel";
import AssetSelectPanel, { type MountContext } from "./AssetSelectPanel";

type Tab = "select" | "upload";

interface Props {
  productionId: string;
  mountCtx: MountContext;
  versionId?: string | null;
  selectOnly?: boolean;
  onDone: (mount: { assetId: string; fileName: string }) => void;
  onClose: () => void;
}

export default function AssetMountModal({ productionId, mountCtx, versionId, selectOnly, onDone, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("select");
  const [uploadedAssetId, setUploadedAssetId] = useState<string | null>(null);

  function handleUploadDone(result: UploadResult) {
    setUploadedAssetId(result.assetId);
    setTab("select");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative z-10 w-full max-w-sm rounded-t-2xl sm:rounded-2xl bg-white shadow-xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[10px] font-semibold tracking-widest text-zinc-300 uppercase">添加 Asset</p>
            <p className="text-sm font-medium text-zinc-700">{mountCtx.label}</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-lg leading-none">✕</button>
        </div>

        <div className="flex rounded-lg overflow-hidden border border-zinc-200 text-xs mb-4">
          {(["select", "upload"] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2 font-medium transition-colors ${
                tab === t ? "bg-zinc-800 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"
              }`}>
              {t === "select" ? "选择已有" : "上传新建"}
            </button>
          ))}
        </div>

        {tab === "upload" ? (
          <AssetUploadPanel
            productionId={productionId}
            versionId={versionId}
            onUploaded={handleUploadDone}
            onCancel={() => setTab("select")}
          />
        ) : (
          <AssetSelectPanel
            productionId={productionId}
            mountCtx={mountCtx}
            preSelectedId={uploadedAssetId}
            selectOnly={selectOnly}
            onMounted={(assetId, label) => onDone({ assetId, fileName: label })}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}
