"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { Block } from "@/lib/script/script-types";
import { readCookie, writeCookie } from "./cookies";

/**
 * 剧本正文的虚拟滚动窗口 + 滚动位置 cookie + 定位导航（跳行 / 跳页 / 跳场）+ cue 高亮清除。
 * 从 CuePage 主函数体原样搬出（#487 C3）；effect 顺序与原文件一致。
 */
export function useCueVirtualWindow({ blocks, productionId, pageMap }: {
  blocks: Block[];
  productionId: string;
  pageMap: Record<string, number>;
}) {
  const [highlightedCueId, setHighlightedCueId] = useState<string | null>(null);
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollLockedRef = useRef(true);

  const VSCROLL_BUFFER = 80;
  const DEFAULT_BLOCK_H = 80;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const botSpacerRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const cumulativeHRef = useRef<number[]>([0]);
  const [windowRange, setWindowRange] = useState(() => ({ start: 0, end: Math.min(160, blocks.length) }));
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });
  const pendingNavigateRef = useRef<
    { kind: "block"; id: string; align: ScrollLogicalPosition } | { kind: "scene"; id: string } | null
  >(null);
  const postNavCorrectionRef = useRef<
    { kind: "block"; id: string; align: ScrollLogicalPosition } | { kind: "scene"; id: string } | null
  >(null);
  const [correctionTick, setCorrectionTick] = useState(0);

  const rebuildCumulative = useCallback(() => {
    const measured = measuredHeightsRef.current;
    let avgH = DEFAULT_BLOCK_H;
    if (measured.size > 0) {
      let sum = 0;
      measured.forEach(h => { sum += h; });
      avgH = sum / measured.size;
    }
    const arr = new Array(blocks.length + 1);
    arr[0] = 0;
    for (let i = 0; i < blocks.length; i++) {
      arr[i + 1] = arr[i] + (measured.get(blocks[i].id) ?? avgH);
    }
    cumulativeHRef.current = arr;
  }, [blocks]);

  const blockAtOffset = (offset: number) => {
    const cum = cumulativeHRef.current;
    const n = cum.length - 1;
    if (n <= 0) return 0;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const recomputeWindow = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || blocks.length === 0) return;
    const sy = container.scrollTop;
    const viewStart = sy;
    const viewEnd = viewStart + container.clientHeight;
    const newStart = Math.max(0, blockAtOffset(viewStart) - VSCROLL_BUFFER);
    const newEnd = Math.min(blocks.length, blockAtOffset(viewEnd) + VSCROLL_BUFFER + 1);
    setWindowRange(prev =>
      prev.start === newStart && prev.end === newEnd ? prev : { start: newStart, end: newEnd }
    );
  }, [blocks.length]);

  // Always-fresh scroll-position saver (reads DOM directly; avoids stale cumulative-height estimates)
  const saveScrollPosRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveScrollPosRef.current = () => {
      const c = scrollContainerRef.current;
      if (!c || !productionId) return;
      const containerTop = c.getBoundingClientRect().top;
      // Find the last rendered block whose top edge is at or above the container's viewport top.
      let savedId: string | null = null;
      for (const el of c.querySelectorAll<HTMLElement>("[data-cue-bwrap]")) {
        if (el.getBoundingClientRect().top <= containerTop) savedId = el.dataset.cueBwrap ?? null;
        else break;
      }
      if (savedId) writeCookie(`cue_pos_${productionId}`, savedId);
    };
  });

  // Keep scrollLockedRef in sync
  useEffect(() => { scrollLockedRef.current = scrollLocked; }, [scrollLocked]);

  // Block user scroll while locked
  useEffect(() => {
    if (!scrollLocked) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const prevent = (e: Event) => e.preventDefault();
    const preventKeys = (e: Event) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes((e as globalThis.KeyboardEvent).key)) e.preventDefault();
    };
    container.addEventListener('wheel', prevent, { passive: false });
    container.addEventListener('touchmove', prevent, { passive: false });
    container.addEventListener('keydown', preventKeys);
    return () => {
      container.removeEventListener('wheel', prevent);
      container.removeEventListener('touchmove', prevent);
      container.removeEventListener('keydown', preventKeys);
    };
  }, [scrollLocked]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recomputeWindow);
      if (!scrollLockedRef.current) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveScrollPosRef.current(), 400);
        // User took control of scroll — abandon any pending post-navigation correction
        postNavCorrectionRef.current = null;
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    recomputeWindow();
    return () => { container.removeEventListener("scroll", onScroll); cancelAnimationFrame(rafId); clearTimeout(saveTimer); };
  }, [recomputeWindow]);

  useLayoutEffect(() => {
    setWindowRange(prev => ({
      start: Math.min(prev.start, Math.max(0, blocks.length - 1)),
      end: Math.min(prev.end, blocks.length),
    }));
  }, [blocks.length]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let changed = false;
    container.querySelectorAll<HTMLElement>("[data-cue-bwrap]").forEach(el => {
      const id = el.dataset.cueBwrap;
      if (!id) return;
      const h = el.offsetHeight;
      if (h > 0 && measuredHeightsRef.current.get(id) !== h) {
        measuredHeightsRef.current.set(id, h);
        changed = true;
      }
    });
    if (changed) {
      rebuildCumulative();
      recomputeWindow();
      if (postNavCorrectionRef.current) setCorrectionTick(t => t + 1);
    }
  });

  useLayoutEffect(() => {
    if (correctionTick === 0) return;
    const nav = postNavCorrectionRef.current;
    if (!nav) return;
    postNavCorrectionRef.current = null;
    const el = nav.kind === "block"
      ? document.getElementById(`cue-block-${nav.id}`)
      : document.getElementById(`cue-scene-${nav.id}`);
    if (!el) return;
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    el.scrollIntoView({ behavior: "instant", block: nav.kind === "block" ? nav.align : "start" });
    setScrollLocked(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange]);

  useLayoutEffect(() => {
    const nav = pendingNavigateRef.current;
    if (!nav) return;
    const el = nav.kind === "block"
      ? document.getElementById(`cue-block-${nav.id}`)
      : document.getElementById(`cue-scene-${nav.id}`);
    if (!el) return;
    pendingNavigateRef.current = null;
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    el.scrollIntoView({ behavior: "instant", block: nav.kind === "block" ? nav.align : "start" });
    postNavCorrectionRef.current = nav;
  }, [windowRange, rebuildCumulative, blocks.length]);

  useLayoutEffect(() => {
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const top = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total = cum[n] ?? n * DEFAULT_BLOCK_H;
    const bot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    setSpacerH(prev => prev.top === top && prev.bot === bot ? prev : { top, bot });
  }, [windowRange, blocks.length]);

  // ── Navigation functions ──────────────────────────────────────────────────

  const scrollToBlockIdx = useCallback((idx: number, align: ScrollLogicalPosition = "center") => {
    if (idx < 0 || idx >= blocks.length) return;
    const block = blocks[idx];
    const el = document.getElementById(`cue-block-${block.id}`);
    if (el) { el.scrollIntoView({ behavior: "instant", block: align }); return; }
    pendingNavigateRef.current = { kind: "block", id: block.id, align };
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocks.length, idx + VSCROLL_BUFFER + 1),
    });
  }, [blocks]);

  // ── Cookie: restore scroll position once on mount ────────────────────────
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    // Fallback: unlock 300ms after mount (covers immediate restore and no-save cases)
    const unlockTimer = setTimeout(() => setScrollLocked(false), 300);
    if (scrollRestoredRef.current) return () => clearTimeout(unlockTimer);
    scrollRestoredRef.current = true;
    const savedId = readCookie(`cue_pos_${productionId}`);
    if (!savedId) return () => clearTimeout(unlockTimer);
    const idx = blocks.findIndex(b => b.id === savedId);
    if (idx >= 0) scrollToBlockIdx(idx, "start");
    return () => clearTimeout(unlockTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToBlockIdx]);

  // ── Clear cue highlight on scroll or click ───────────────────────────────
  useEffect(() => {
    if (!highlightedCueId) return;
    const clear = () => setHighlightedCueId(null);
    const container = scrollContainerRef.current;
    const timer = setTimeout(() => {
      if (container) container.addEventListener("scroll", clear, { passive: true });
      document.addEventListener("click", clear);
    }, 400);
    return () => {
      clearTimeout(timer);
      if (container) container.removeEventListener("scroll", clear);
      document.removeEventListener("click", clear);
    };
  }, [highlightedCueId]);

  const scrollToScene = useCallback((sceneId: string) => {
    const el = document.getElementById(`cue-scene-${sceneId}`);
    if (el) { el.scrollIntoView({ behavior: "instant", block: "start" }); return; }
    const idx = blocks.findIndex(b => b.sceneId === sceneId);
    if (idx < 0) return;
    pendingNavigateRef.current = { kind: "scene", id: sceneId };
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocks.length, idx + VSCROLL_BUFFER + 1),
    });
  }, [blocks]);

  const jumpToLine = useCallback((n: number) => {
    scrollToBlockIdx(Math.max(0, Math.min(n - 1, blocks.length - 1)), "center");
  }, [blocks.length, scrollToBlockIdx]);

  const jumpToPage = useCallback((n: number) => {
    const idx = blocks.findIndex(b => pageMap[b.id] === n);
    if (idx >= 0) scrollToBlockIdx(idx, "start");
  }, [blocks, pageMap, scrollToBlockIdx]);

  return {
    scrollContainerRef, topSpacerRef, botSpacerRef,
    windowRange, spacerH, highlightedCueId, setHighlightedCueId,
    scrollToBlockIdx, scrollToScene, jumpToLine, jumpToPage,
  };
}
