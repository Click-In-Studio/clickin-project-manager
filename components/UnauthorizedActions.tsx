"use client";

import { useState } from "react";
import AccessRequestModal from "./AccessRequestModal";

type Props = {
  productionId: string;
  /** Atomic permission string that caused the 403 (e.g. ""). */
  resource?: string;
};

export default function UnauthorizedActions({ productionId, resource }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          padding: "9px 22px",
          borderRadius: 9,
          background: "var(--surface-2)",
          color: "var(--ink)",
          fontSize: 13,
          fontWeight: 700,
          border: "1px solid var(--line)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        申请权限
      </button>

      <AccessRequestModal
        open={open}
        onClose={() => setOpen(false)}
        productionId={productionId}
        permission={resource}
      />
    </>
  );
}
