"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Block } from "@/lib/script/script-types";
import { isTextBlock } from "@/lib/script/script-block-layout";
import { stripHtmlText } from "@/lib/script/script-block-stream";

/**
 * 顶栏搜索框（含「精确 / 仅当前页」开关与命中游标）与跳行 / 跳页。
 * 从 ScriptEditor 主函数体原样搬出（#487 S4）。
 */
export function useScriptSearch({ blocks, pageMap, focusedId, loadState, initialSearchQuery, scrollToBlockIdx }: {
  blocks: Block[];
  pageMap: Record<string, number>;
  focusedId: string | null;
  loadState: string;
  initialSearchQuery: string | undefined;
  scrollToBlockIdx: (idx: number, align?: ScrollLogicalPosition) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExact, setSearchExact] = useState(false);
  const [searchCurrentPage, setSearchCurrentPage] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  // initialSearchQueryRef — consumed after load (see effect below, after loadState declaration)
  const initialSearchQueryRef = useRef(initialSearchQuery);

  // ── Jump (line / page) ──────────────────────────────────────────────────────
  const [jumpTarget, setJumpTarget] = useState<"line" | "page" | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  // Auto-open search when arriving from appshell search with a query
  useEffect(() => {
    const q = initialSearchQueryRef.current;
    if (!q || loadState !== "ready") return;
    initialSearchQueryRef.current = undefined;
    setSearchOpen(true);
    setSearchQuery(q);
    setSearchIdx(0);
  }, [loadState]);

  // ── Search matches (computed from blocks + pageMap) ─────────────────────────
  const currentPageNum = focusedId ? pageMap[focusedId] : undefined;

  const searchMatches = useMemo<number[]>(() => {
    if (!searchOpen || !searchQuery.trim()) return [];
    const q = searchExact ? searchQuery : searchQuery.toLowerCase();
    return blocks.reduce<number[]>((acc, block, idx) => {
      if (!isTextBlock(block)) return acc;
      const text = stripHtmlText(block.content);
      const haystack = searchExact ? text : text.toLowerCase();
      if (!haystack.includes(q)) return acc;
      if (searchCurrentPage && currentPageNum !== undefined && pageMap[block.id] !== currentPageNum) return acc;
      acc.push(idx);
      return acc;
    }, []);
  }, [searchOpen, searchQuery, searchExact, searchCurrentPage, blocks, pageMap, currentPageNum]);

  // Scroll to focused search result
  useEffect(() => {
    const matchIdx = searchMatches[searchIdx];
    if (matchIdx === undefined) return;
    scrollToBlockIdx(matchIdx, 'center');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchIdx, searchMatches]);

  // Jump helpers
  const jumpToLine = useCallback((n: number) => {
    const targetLine = Math.max(1, n);
    let lineNumber = 0;
    for (let idx = 0; idx < blocks.length; idx++) {
      if (!isTextBlock(blocks[idx])) continue;
      lineNumber += 1;
      if (lineNumber === targetLine) {
        scrollToBlockIdx(idx, 'center');
        return;
      }
    }
  }, [blocks, scrollToBlockIdx]);

  const jumpToPage = useCallback((n: number) => {
    const idx = blocks.findIndex(b => pageMap[b.id] === n);
    if (idx >= 0) scrollToBlockIdx(idx, 'start');
  }, [blocks, pageMap, scrollToBlockIdx]);

  return {
    searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchExact, setSearchExact,
    searchCurrentPage, setSearchCurrentPage, searchIdx, setSearchIdx, searchMatches,
    jumpTarget, setJumpTarget, jumpValue, setJumpValue, jumpToLine, jumpToPage,
  };
}
