"use client";

// Wrapper for MountPointAssets that resolves a stable blockId → snapshot_id before rendering.
// When versionId is absent, falls back to "block" (inherit) mount type.

import { useState, useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import MountPointAssets from "./MountPointAssets";

interface Props {
  productionId: string;
  blockId: string;
  versionId: string | null;
  label: string;
  canEdit?: boolean;
  display?: "compact" | "panel";
  onNavigate?: () => void;
  onChange?: () => void;
}

export default function BlockMountAssets({ productionId, blockId, versionId, label, canEdit, display, onNavigate, onChange }: Props) {
  const [resolved, setResolved] = useState<{ mountType: "block_snapshot" | "block"; mountId: string } | null>(null);

  useEffect(() => {
    if (!versionId) {
      setResolved({ mountType: "block", mountId: blockId });
      return;
    }
    const qs = new URLSearchParams({ type: "block", stableId: blockId, v: versionId });
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/resolve-mount?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { mountType: "block_snapshot"; mountId: string } | null) => {
        if (j) setResolved({ mountType: j.mountType, mountId: j.mountId });
        else setResolved({ mountType: "block", mountId: blockId });
      })
      .catch(() => setResolved({ mountType: "block", mountId: blockId }));
  }, [productionId, blockId, versionId]);

  if (!resolved) return null;

  return (
    <MountPointAssets
      productionId={productionId}
      mountType={resolved.mountType}
      mountId={resolved.mountId}
      versionId={versionId}
      stableId={blockId}
      label={label}
      canEdit={canEdit}
      display={display}
      onNavigate={onNavigate}
      onChange={onChange}
    />
  );
}
