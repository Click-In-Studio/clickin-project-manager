"use client";

// Wrapper for MountPointAssets that resolves a stable cueId → revision_id before rendering.

import { useState, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import MountPointAssets from "./MountPointAssets";

interface Props {
  productionId: string;
  cueId: string;
  versionId: string | null;
  label: string;
  canEdit?: boolean;
  display?: "compact" | "panel";
}

export default function CueMountAssets({ productionId, cueId, versionId, label, canEdit, display }: Props) {
  const [resolved, setResolved] = useState<{ mountType: "cue_revision" | "cue"; mountId: string } | null>(null);

  useEffect(() => {
    if (!versionId) {
      setResolved({ mountType: "cue", mountId: cueId });
      return;
    }
    const qs = new URLSearchParams({ type: "cue", stableId: cueId, v: versionId });
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/resolve-mount?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { mountType: "cue_revision"; mountId: string } | null) => {
        if (j) setResolved({ mountType: j.mountType, mountId: j.mountId });
        else setResolved({ mountType: "cue", mountId: cueId });
      })
      .catch(() => setResolved({ mountType: "cue", mountId: cueId }));
  }, [productionId, cueId, versionId]);

  if (!resolved) return null;

  return (
    <MountPointAssets
      productionId={productionId}
      mountType={resolved.mountType}
      mountId={resolved.mountId}
      versionId={versionId}
      stableId={cueId}
      label={label}
      canEdit={canEdit}
      display={display}
    />
  );
}
