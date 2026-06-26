"use client";

import { useRouter } from "next/navigation";
import ImportJointWizard from "./ImportJointWizard";

export default function ImportScenesWizardPage({ productionId, versionId }: { productionId: string; versionId?: string | null }) {
  const router = useRouter();
  return (
    <ImportJointWizard
      productionId={productionId}
      versionId={versionId}
      onDone={() => router.push(`/production/${productionId}/scenes`)}
    />
  );
}
