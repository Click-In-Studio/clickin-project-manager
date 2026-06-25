"use client";

import { useRouter } from "next/navigation";
import ImportScenesWizard from "./ImportScenesWizard";

export default function ImportScenesWizardPage({ productionId, versionId }: { productionId: string; versionId?: string | null }) {
  const router = useRouter();
  return (
    <ImportScenesWizard
      productionId={productionId}
      versionId={versionId}
      onDone={() => router.push(`/production/${productionId}/scenes`)}
    />
  );
}
