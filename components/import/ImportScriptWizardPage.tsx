"use client";

import { useRouter } from "next/navigation";
import ImportScriptWizard from "./ImportScriptWizard";

export default function ImportScriptWizardPage({ productionId }: { productionId: string }) {
  const router = useRouter();
  return (
    <ImportScriptWizard
      productionId={productionId}
      onDone={() => router.push(`/production/${productionId}/script`)}
    />
  );
}
