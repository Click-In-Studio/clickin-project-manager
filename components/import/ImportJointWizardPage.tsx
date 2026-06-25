"use client";

import { useRouter } from "next/navigation";
import ImportJointWizard from "./ImportJointWizard";

export default function ImportJointWizardPage({ productionId, versionId }: { productionId: string; versionId?: string | null }) {
  const router = useRouter();
  return (
    <ImportJointWizard
      productionId={productionId}
      versionId={versionId}
      onDone={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
