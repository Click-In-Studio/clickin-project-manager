"use client";

import { useRouter } from "next/navigation";
import ImportJointWizard from "./ImportJointWizard";

export default function ImportJointWizardPage({ productionId, versionId }: { productionId: string; versionId?: string | null }) {
  const router = useRouter();
  return (
    <div className="min-h-full bg-white text-zinc-900">
      <ImportJointWizard
        productionId={productionId}
        versionId={versionId}
        onDone={() => router.push(`/production/${productionId}/script`)}
      />
    </div>
  );
}
