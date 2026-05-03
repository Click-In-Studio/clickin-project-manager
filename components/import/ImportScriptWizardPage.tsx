"use client";

import { useRouter } from "next/navigation";
import ImportScriptWizard from "./ImportScriptWizard";

export default function ImportScriptWizardPage({ productionId, versionId }: { productionId: string; versionId?: string | null }) {
  const router = useRouter();
  return (
    <ImportScriptWizard
      productionId={productionId}
      versionId={versionId}
      onDone={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
