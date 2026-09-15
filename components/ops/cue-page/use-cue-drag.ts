"use client";

import { useState, useRef, useCallback, useEffect, type MutableRefObject } from "react";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";
import { anchorSortKey } from "@/lib/ops/cue-anchor";
import type { DragStateRef, DragType } from "./types";

/**
 * cue 芯片 / 标记的鼠标拖拽：按下记起点，超过阈值后按鼠标位置解析锚点并实时预览，
 * 松手按拖拽类型（move / expand / 两端把手）落库。从 CuePage 主函数体原样搬出（#487 C3）。
 */
export function useCueDrag({ cues, blockIndexMapRef, updateCueFieldRef }: {
  cues: Cue[];
  blockIndexMapRef: MutableRefObject<Map<string, number>>;
  updateCueFieldRef: MutableRefObject<(
    cue: Cue,
    fields: { number?: string; name?: string; content?: string; warning?: boolean; start?: CueAnchor; end?: CueAnchor },
  ) => Promise<void>>;
}) {
  const dragStateRef = useRef<DragStateRef>({
    active: false, dragType: "move", cueId: "",
    startX: 0, startY: 0, thresholdMet: false, liveAnchor: null, originalAnchor: null,
  });
  const [dragLive, setDragLive] = useState<{
    cueId: string; dragType: DragType; anchor: CueAnchor; originalAnchor: CueAnchor | null;
  } | null>(null);


  // Stable refs for use inside event handlers (avoid stale closures in global listeners)
  const cuesRef = useRef(cues);
  useEffect(() => { cuesRef.current = cues; }, [cues]);
  // Suppresses the browser click event that fires immediately after a completed drag mouseup.
  const justDraggedRef = useRef(false);

  // ── anchorFromPoint: resolve mouse coordinates to a CueAnchor ─────────────
  const anchorFromPoint = useCallback((x: number, y: number): CueAnchor | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    // Gap zones take priority (they're outside block text)
    const gapEl = el.closest("[data-gap-after]") as HTMLElement | null;
    if (gapEl?.dataset.gapAfter) return { kind: "gap", afterBlockId: gapEl.dataset.gapAfter };

    // Chip column → treat as block start (offset 0)
    const chipColEl = el.closest("[data-chip-col-for]") as HTMLElement | null;
    if (chipColEl?.dataset.chipColFor)
      return { kind: "block", blockId: chipColEl.dataset.chipColFor, offset: 0 };

    // Block text area
    const blockEl = el.closest("[data-block-id]") as HTMLElement | null;
    if (!blockEl?.dataset.blockId) return null;

    const caretRange = document.caretRangeFromPoint?.(x, y);
    if (!caretRange) return { kind: "block", blockId: blockEl.dataset.blockId, offset: 0 };

    let offset = 0;
    const iter = document.createNodeIterator(blockEl, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = iter.nextNode())) {
      if (cur === caretRange.startContainer) { offset += caretRange.startOffset; break; }
      offset += cur.textContent?.length ?? 0;
    }
    return { kind: "block", blockId: blockEl.dataset.blockId, offset };
  }, []);

  // ── startCueDrag: begin a drag operation ──────────────────────────────────
  const startCueDrag = useCallback((
    e: React.MouseEvent, cueId: string, dragType: DragType, originalAnchor?: CueAnchor
  ) => {
    e.preventDefault();
    e.stopPropagation();
    // End handle marks use "${cueId}:end" to avoid guide-line querySelector collision;
    // strip the suffix here to get the real cue id (same pattern as handleMarkClick).
    const realCueId = cueId.endsWith(":end") ? cueId.slice(0, -4) : cueId;
    dragStateRef.current = {
      active: true, dragType, cueId: realCueId,
      startX: e.clientX, startY: e.clientY,
      thresholdMet: false, liveAnchor: null,
      originalAnchor: originalAnchor ?? null,
    };
  }, []);

  // ── Global drag event listeners ───────────────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      if (!ds.thresholdMet) {
        const dist = Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY);
        if (dist < 5) return;
        ds.thresholdMet = true;
        document.body.style.cursor = "crosshair";
      }
      const anchor = anchorFromPoint(e.clientX, e.clientY);
      if (anchor) {
        ds.liveAnchor = anchor;
        setDragLive({ cueId: ds.cueId, dragType: ds.dragType, anchor, originalAnchor: ds.originalAnchor });
      }
    };

    const handleMouseUp = () => {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      const wasThreshold = ds.thresholdMet;
      const anchor = ds.liveAnchor;
      const origAnchor = ds.originalAnchor;
      ds.active = false;
      ds.thresholdMet = false;
      ds.liveAnchor = null;
      ds.originalAnchor = null;
      document.body.style.cursor = "";
      setDragLive(null);
      if (!wasThreshold || !anchor) return;
      justDraggedRef.current = true; // suppress the browser click that fires right after mouseup
      const cue = cuesRef.current.find(c => c.id === ds.cueId);
      if (!cue) return;
      if (ds.dragType === "move") {
        updateCueFieldRef.current(cue, { start: anchor, end: anchor, warning: false });
      } else if (ds.dragType === "expand" && origAnchor) {
        const k  = anchorSortKey(anchor, blockIndexMapRef.current);
        const ok = anchorSortKey(origAnchor, blockIndexMapRef.current);
        if (k < ok)       updateCueFieldRef.current(cue, { start: anchor,    end: origAnchor, warning: false });
        else if (k > ok)  updateCueFieldRef.current(cue, { start: origAnchor, end: anchor,    warning: false });
        // k === ok: stayed at same spot, no-op
      } else if (ds.dragType === "handle-start") {
        updateCueFieldRef.current(cue, { start: anchor, warning: false });
      } else if (ds.dragType === "handle-end") {
        updateCueFieldRef.current(cue, { end: anchor, warning: false });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [anchorFromPoint, blockIndexMapRef, updateCueFieldRef]);

  return { dragLive, justDraggedRef, startCueDrag };
}
