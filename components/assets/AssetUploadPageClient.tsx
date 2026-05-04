"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import AssetUploadPanel from "./AssetUploadPanel";

interface Props {
  productionId: string;
  versionId: string | null;
}

export default function AssetUploadPageClient({ productionId, versionId }: Props) {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-sm mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}/assets`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <p className="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase">上传 Asset</p>
        </div>

        <div className="rounded-2xl bg-white shadow-sm p-5">
          <AssetUploadPanel
            productionId={productionId}
            versionId={versionId}
            onUploaded={() => router.push(`/production/${productionId}/assets`)}
            onCancel={() => router.push(`/production/${productionId}/assets`)}
          />
        </div>
      </div>
    </div>
  );
}
