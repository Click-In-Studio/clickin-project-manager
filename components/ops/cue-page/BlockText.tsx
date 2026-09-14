"use client";

import React, { useRef, useCallback, useMemo } from "react";
import type { CueAnchor } from "@/lib/ops/cue-types";
import { LIST_COLORS } from "./colors";
import type { DragType, DragConfig, CueMark } from "./types";

export default function BlockText({
  blockId, content, rangeHighlights, pendingHighlight, pointMarks, pendingCursor,
  onClick, onSelect, onMarkDrag, onMarkClick,
}: {
  blockId: string;
  content: string;
  rangeHighlights: { start: number; end: number; colorIdx: number; label?: string }[];
  pendingHighlight: { start: number; end: number } | null;
  pointMarks: CueMark[];
  pendingCursor: number | null;
  onClick: (blockId: string, offset: number) => void;
  onSelect: (blockId: string, start: number, end: number) => void;
  onMarkDrag?: (e: React.MouseEvent, cueId: string, dragType: DragType, origAnchor?: CueAnchor) => void;
  onMarkClick?: (cueId: string) => void;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const justRangeSelectedRef = useRef(false);

  const getOffset = useCallback((container: HTMLSpanElement, node: Node, nodeOffset: number): number => {
    let offset = 0;
    const iter = document.createNodeIterator(container, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = iter.nextNode())) {
      if (cur === node) return offset + nodeOffset;
      offset += cur.textContent?.length ?? 0;
    }
    return offset;
  }, []);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return;
    const range = sel.getRangeAt(0);
    const container = containerRef.current;
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

    const start = getOffset(container, range.startContainer, range.startOffset);
    const end = getOffset(container, range.endContainer, range.endOffset);
    if (start < end) {
      justRangeSelectedRef.current = true;
      onSelect(blockId, start, end);
    }
    sel.removeAllRanges();
  }, [blockId, onSelect, getOffset]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (justRangeSelectedRef.current) { justRangeSelectedRef.current = false; return; }
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!range || !containerRef.current?.contains(range.startContainer)) return;
    onClick(blockId, getOffset(containerRef.current!, range.startContainer, range.startOffset));
  }, [blockId, onClick, getOffset]);

  type RenderItem =
    | { kind: "text"; text: string; bgHex: string | null; pending: boolean; rangeLabel?: string }
    | { kind: "cue-mark"; colorHex: string; selected: boolean; cueId: string; dragConfig?: DragConfig }
    | { kind: "pending-cursor" };

  const items: RenderItem[] = useMemo(() => {
    if (!content) return [];

    type Event =
      | { pos: number; sort: number; action: "range-open";  colorIdx: number; label?: string }
      | { pos: number; sort: number; action: "range-close"; colorIdx: number }
      | { pos: number; sort: number; action: "pend-open" }
      | { pos: number; sort: number; action: "pend-close" }
      | { pos: number; sort: number; action: "cue-mark"; colorHex: string; selected: boolean; cueId: string; dragConfig?: DragConfig }
      | { pos: number; sort: number; action: "pending-cursor" };

    const evts: Event[] = [];
    for (const h of rangeHighlights) {
      evts.push({ pos: h.start, sort: 2, action: "range-open",  colorIdx: h.colorIdx, label: h.label });
      evts.push({ pos: h.end,   sort: 0, action: "range-close", colorIdx: h.colorIdx });
    }
    if (pendingHighlight) {
      evts.push({ pos: pendingHighlight.start, sort: 2, action: "pend-open" });
      evts.push({ pos: pendingHighlight.end,   sort: 0, action: "pend-close" });
    }
    for (const pm of pointMarks)
      evts.push({ pos: Math.min(pm.offset, content.length), sort: 1, action: "cue-mark", colorHex: pm.colorHex, selected: pm.selected, cueId: pm.cueId, dragConfig: pm.dragConfig });
    if (pendingCursor !== null)
      evts.push({ pos: Math.min(pendingCursor, content.length), sort: 1, action: "pending-cursor" });

    evts.sort((a, b) => a.pos - b.pos || a.sort - b.sort);

    const result: RenderItem[] = [];
    let textPos = 0;
    let activeColorIdx: number | null = null;
    let activeLabel: string | undefined;
    let isPending = false;

    const flush = (to: number) => {
      if (to > textPos) {
        result.push({
          kind: "text",
          text: content.slice(textPos, to),
          bgHex: activeColorIdx !== null ? LIST_COLORS[activeColorIdx % LIST_COLORS.length].line + "33" : null,
          pending: isPending,
          rangeLabel: activeColorIdx !== null ? activeLabel : undefined,
        });
        textPos = to;
      }
    };

    for (const e of evts) {
      flush(e.pos);
      if (e.action === "range-open")       { activeColorIdx = e.colorIdx; activeLabel = e.label; }
      else if (e.action === "range-close") { activeColorIdx = null; activeLabel = undefined; }
      else if (e.action === "pend-open")   isPending = true;
      else if (e.action === "pend-close")  isPending = false;
      else if (e.action === "cue-mark")    result.push({ kind: "cue-mark", colorHex: e.colorHex, selected: e.selected, cueId: e.cueId, dragConfig: e.dragConfig });
      else if (e.action === "pending-cursor") result.push({ kind: "pending-cursor" });
    }
    flush(content.length);
    return result;
  }, [content, rangeHighlights, pendingHighlight, pointMarks, pendingCursor]);

  return (
    <span
      ref={containerRef}
      data-block-id={blockId}
      className="cursor-text select-text"
      onMouseUp={handleMouseUp}
      onClick={handleClick}
    >
      {items.map((item, i) =>
        item.kind === "text" ? (
          item.bgHex ? (
            <mark key={i} title={item.rangeLabel} className="rounded-sm cursor-pointer" style={{ backgroundColor: item.bgHex }}>{item.text}</mark>
          ) : item.pending ? (
            <mark key={i} className="bg-zinc-200 rounded-sm">{item.text}</mark>
          ) : (
            <span key={i}>{item.text}</span>
          )
        ) : item.kind === "cue-mark" ? (
          <span
            key={i}
            data-mark-cue-id={item.cueId}
            onMouseDown={item.dragConfig && onMarkDrag
              ? (e) => onMarkDrag(e, item.cueId, item.dragConfig!.dragType, item.dragConfig!.origAnchor)
              : undefined}
            onClick={onMarkClick
              ? (e) => { e.stopPropagation(); onMarkClick(item.cueId); }
              : undefined}
            className={`inline-block w-[3px] h-[1em] rounded-full align-middle mx-[-1px] transition-transform
              ${item.dragConfig ? "cursor-ew-resize" : "cursor-pointer"}
              ${item.selected ? "scale-y-125" : ""}`}
            style={{ backgroundColor: item.colorHex }}
          />
        ) : (
          <span key={i} className="inline-block w-[2px] h-[1em] rounded-full align-middle mx-[-1px] bg-zinc-400 animate-pulse" />
        )
      )}
    </span>
  );
}
