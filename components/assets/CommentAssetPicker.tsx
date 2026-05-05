"use client";

import { useState } from "react";
import AssetMountModal from "./AssetMountModal";

export type PendingAsset = { id: string; label: string };

interface Props {
  productionId: string;
  selected: PendingAsset[];
  onSelect: (items: PendingAsset[]) => void;
  label?: string;
}

export default function CommentAssetPicker({ productionId, selected, onSelect, label = "评论附件" }: Props) {
  const [showModal, setShowModal] = useState(false);

  const remove = (id: string) => onSelect(selected.filter(a => a.id !== id));

  const handleDone = ({ assetId, fileName }: { assetId: string; fileName: string }) => {
    if (!selected.some(a => a.id === assetId)) {
      onSelect([...selected, { id: assetId, label: fileName }]);
    }
    setShowModal(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="text-[11px] text-zinc-400 hover:text-zinc-600"
        >
          📎 附件{selected.length > 0 ? ` (${selected.length})` : ""}
        </button>
        {selected.map(a => (
          <span key={a.id}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
            {a.label}
            <button type="button" onClick={() => remove(a.id)} className="ml-0.5 text-zinc-400 hover:text-zinc-700">×</button>
          </span>
        ))}
      </div>

      {showModal && (
        <AssetMountModal
          productionId={productionId}
          mountCtx={{ mountType: "comment", mountId: "__pending__", label }}
          selectOnly
          onDone={handleDone}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}
