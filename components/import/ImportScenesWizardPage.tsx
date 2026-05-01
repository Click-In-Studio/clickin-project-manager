"use client";

import { useRouter } from "next/navigation";
import ImportScenesWizard from "./ImportScenesWizard";

export default function ImportScenesWizardPage({ productionId }: { productionId: string }) {
  const router = useRouter();
  return (
    <ImportScenesWizard
      productionId={productionId}
      onDone={() => router.push(`/production/${productionId}/scenes`)}
    />
  );
}
