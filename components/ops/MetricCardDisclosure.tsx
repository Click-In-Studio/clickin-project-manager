"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./home.module.css";

export default function MetricCardDisclosure({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={styles.progressMetricDisclosure}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.progressMetricLabel}
        aria-label={`查看完整里程碑：${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
      >
        {label}
      </button>
      {open && (
        <div id={panelId} role="region" aria-label="完整里程碑" className={styles.progressMetricDisclosurePanel}>
          {label}
        </div>
      )}
    </div>
  );
}
