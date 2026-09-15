"use client";

import { useState, useRef, useEffect } from "react";
import type { Cue } from "@/lib/ops/cue-types";
import { LIST_COLORS } from "./colors";
import type { GuideLineData, Selection } from "./types";

/**
 * 芯片列到正文标记的引导线：按块量 chip / mark 的位置，只在几何变化时换 Map（哈希去重）。
 * 拖拽预览期间不量。从 CuePage 主函数体原样搬出（#487 C3）。
 */
export function useCueGuideLines({ cuesForBlock, selection, dragLive }: {
  cuesForBlock: Map<string, { cue: Cue; listIdx: number }[]>;
  selection: Selection;
  dragLive: unknown;
}) {
  const blockRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [guideLines, setGuideLines] = useState<Map<string, GuideLineData[]>>(new Map());
  const guideLinesHashRef = useRef("");

  useEffect(() => {
    if (dragLive) return; // skip during live drag — measure only committed state
    const newMap = new Map<string, GuideLineData[]>();
    let hash = "";

    for (const [blockId, rowEl] of blockRowRefs.current) {
      const blockChips = (cuesForBlock.get(blockId) ?? []).filter(c => c.cue.start.kind === "block");
      if (blockChips.length === 0) continue;
      const isMulti = blockChips.length >= 2;
      const rowRect = rowEl.getBoundingClientRect();
      const lines: GuideLineData[] = [];

      for (const { cue, listIdx } of blockChips) {
        const chipEl = rowEl.querySelector(`[data-chip-cue-id="${cue.id}"]`) as HTMLElement | null;
        const markEl = rowEl.querySelector(`[data-mark-cue-id="${cue.id}"]`) as HTMLElement | null;
        if (!chipEl || !markEl) continue;
        const chipRect = chipEl.getBoundingClientRect();
        const markRect = markEl.getBoundingClientRect();
        const chipY = Math.round((chipRect.top + chipRect.bottom) / 2 - rowRect.top);
        const markY = Math.round((markRect.top + markRect.bottom) / 2 - rowRect.top);
        if (!isMulti && chipY === markY) continue;
        lines.push({
          cueId: cue.id,
          color: LIST_COLORS[listIdx % LIST_COLORS.length].line,
          chipX: Math.round(chipRect.right - rowRect.left),
          chipY,
          markX: Math.round((markRect.left + markRect.right) / 2 - rowRect.left),
          markY,
        });
      }
      if (lines.length > 0) {
        newMap.set(blockId, lines);
        hash += blockId + lines.map(l => `${l.chipX},${l.chipY},${l.markX},${l.markY}`).join(";") + "|";
      }
    }

    if (hash !== guideLinesHashRef.current) {
      guideLinesHashRef.current = hash;
      setGuideLines(newMap);
    }
  }, [cuesForBlock, selection, dragLive]);

  return { blockRowRefs, guideLines };
}
