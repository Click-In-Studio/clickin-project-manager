"use client";

import { useState } from "react";
import AdminModal from "@/components/ui/AdminModal";
import AssetAccessModal from "./AssetAccessModal";
import AssetSharePanel from "./AssetSharePanel";

type ShareMode = "choose" | "internal" | "external";

export default function AssetShareModal({
  productionId, assetId, assetName, userName, members, departments,
  canShareInternally, canManageExternalShare, canCreateExternalShare, onClose,
}: {
  productionId: string;
  assetId: string;
  assetName: string;
  userName: string;
  members: { userId: string; name: string }[];
  departments: { id: string; name: string }[];
  canShareInternally: boolean;
  canManageExternalShare: boolean;
  canCreateExternalShare: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ShareMode>("choose");

  if (mode === "internal") {
    return <AssetAccessModal productionId={productionId} assetId={assetId} assetName={assetName}
      members={members} departments={departments} onClose={onClose} />;
  }

  if (mode === "external") {
    return <AssetSharePanel productionId={productionId} assetId={assetId} assetName={assetName}
      userName={userName} canCreateLink={canCreateExternalShare} onClose={onClose} />;
  }

  const choices = [
    {
      id: "internal" as const,
      label: "对内分享",
      description: "设置项目成员、部门和目录中的访问范围",
      enabled: canShareInternally,
      reason: "需要该资产的授权管理权",
    },
    {
      id: "external" as const,
      label: "对外链接",
      description: "生成、查看或撤销发给项目外人员的链接",
      enabled: canManageExternalShare,
      reason: "需要对外分享资格",
    },
  ];

  return (
    <AdminModal title={`分享「${assetName}」`} onClose={onClose} width={460}>
      <div className="space-y-3">
        {choices.map(choice => (
          <button key={choice.id} type="button"
            aria-disabled={!choice.enabled}
            title={choice.enabled ? choice.label : choice.reason}
            onClick={() => { if (choice.enabled) setMode(choice.id); }}
            className="block w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-45">
            <span className="block text-sm font-semibold text-zinc-800">{choice.label}</span>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">
              {choice.enabled ? choice.description : choice.reason}
            </span>
          </button>
        ))}
      </div>
    </AdminModal>
  );
}
