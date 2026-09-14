"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "@/components/ops/planning.module.css";

export default function BoundedTimePicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [popoverSide, setPopoverSide] = useState<"up" | "down">("down");
  const [listMaxHeight, setListMaxHeight] = useState(190);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [hour = "00", minute = "00"] = value.split(":");

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !popoverRef.current) return;

    const triggerRect = rootRef.current.getBoundingClientRect();
    let boundaryTop = 8;
    let boundaryBottom = window.innerHeight - 8;

    // 时间选择器常出现在可滚动弹窗内。以最近的裁切/滚动祖先为边界，
    // 不能只看 viewport，否则绝对定位弹层仍会被弹窗底部截断。
    for (let parent = rootRef.current.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
        const rect = parent.getBoundingClientRect();
        boundaryTop = Math.max(boundaryTop, rect.top + 8);
        boundaryBottom = Math.min(boundaryBottom, rect.bottom - 8);
        break;
      }
    }

    const below = Math.max(0, boundaryBottom - triggerRect.bottom - 6);
    const above = Math.max(0, triggerRect.top - boundaryTop - 6);
    const side = below < 206 && above > below ? "up" : "down";
    const available = side === "up" ? above : below;
    setPopoverSide(side);
    setListMaxHeight(Math.max(96, Math.min(190, available - 18)));
  }, [open]);

  return (
    <div ref={rootRef} className={styles.timeField}>
      <span style={{ display: "block", marginBottom: 5, fontSize: 11, color: "var(--muted)" }}>{label}</span>
      <button type="button" className={styles.timeButton} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span>{hour}:{minute}</span><span aria-hidden>⌄</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={styles.timePopover}
          data-side={popoverSide}
          style={{ "--time-list-max-height": `${listMaxHeight}px` } as React.CSSProperties}
          role="group"
          aria-label={`${label}选择`}
        >
          <div className={styles.timeList} aria-label="小时 0 到 23">
            {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map(option => (
              <button key={option} type="button" className={`${styles.timeOption} ${option === hour ? styles.timeOptionActive : ""}`} onClick={() => onChange(`${option}:${minute}`)}>{option} 时</button>
            ))}
          </div>
          <div className={styles.timeList} aria-label="分钟 00 到 59">
            {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map(option => (
              <button key={option} type="button" className={`${styles.timeOption} ${option === minute ? styles.timeOptionActive : ""}`} onClick={() => { onChange(`${hour}:${option}`); setOpen(false); }}>{option} 分</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
