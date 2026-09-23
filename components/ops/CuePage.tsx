"use client";

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import Link from "next/link";
import ProductionTopMenu, { PRODUCTION_PAGE_SCROLL_ROOT_CLASS, ProductionOverflowSubmenuButton, ProductionTopMenuDivider, PRODUCTION_TOP_MENU_RIGHT_CLASS, useProductionToolbar } from "@/components/shell/ProductionTopMenu";
import ChevronIcon from "@/components/ui/ChevronIcon";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { useVisibleEventSource } from "@/hooks/useVisibleEventSource";
import { BASE_PATH } from "@/lib/base-path";
import { isPointCue, anchorEq, anchorSortKey } from "@/lib/ops/cue-anchor";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";
import { buildMarkerLabelIndex } from "@/lib/script/script-generated-labels";
import { hasScriptInsertionGapBefore, sceneParentIdMap } from "@/lib/script/script-insertion-gaps";
import { buildMarkerContextById, isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script/script-marker-blocks";
import type { Block, Scene } from "@/lib/script/script-types";
import BlockText from "./cue-page/BlockText";
import CueChip from "./cue-page/CueChip";
import CueCommentsPanel from "./cue-page/CueCommentsPanel";
import CueJumpOptions, { CUE_JUMP_OPTIONS } from "./cue-page/CueJumpOptions";
import ExportModal from "./cue-page/ExportModal";
import InlineField from "./cue-page/InlineField";
import ShareModal from "./cue-page/ShareModal";
import { LIST_COLORS, colorFor } from "./cue-page/colors";
import type { CueSequenceItem, Props, Selection, CueMark, CuePresence } from "./cue-page/types";
import { patchCue, fetchListCues, createCue, deleteCueRemote, selfConfirmCueListAccess } from "@/lib/ops/cue-client";
import { useCueLists } from "./cue-page/use-cue-lists";
import { useCuePresence } from "./cue-page/use-cue-presence";
import { useCueComments } from "./cue-page/use-cue-comments";
import { useCueToolbarMenus } from "./cue-page/use-cue-toolbar-menus";
import { useCueVirtualWindow } from "./cue-page/use-cue-virtual-window";
import { useCueDrag } from "./cue-page/use-cue-drag";
import { useCueGuideLines } from "./cue-page/use-cue-guide-lines";

// ─── Comment helpers ─────────────────────────────────────────────────────────

// ─── Main component ───────────────────────────────────────────────────────────

export default function CuePage({
  productionId, productionName, blocks: rawBlocks, characters, scenes,
  cueLists, initialCues, editableListIds, manageListIds, myUserId, isAdmin, pageMap,
  versionId,
}: Props) {
  const { stage: toolbarStage, closeOverflow, overflowOpen } = useProductionToolbar();
  const orderedBlocks = useMemo(() => withLegacyOwnershipProjection(
    withMarkerOwnership(rawBlocks),
    buildMarkerContextById(rawBlocks),
  ), [rawBlocks]);
  const blocks = useMemo(() => orderedBlocks.filter((block) => !isMarkerBlock(block)), [orderedBlocks]);
  const rehearsalLabelByMarkerId = useMemo(
    () => buildMarkerLabelIndex(rawBlocks).rehearsalLabelByMarkerId,
    [rawBlocks],
  );
  const versionIdRef = useRef(versionId);
  useEffect(() => {
    versionIdRef.current = versionId;
    setCues(initialCues);
    setSelection({ kind: "none" });
  }, [versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cues, setCues] = useState<Cue[]>(initialCues);
  const [copiedCue, setCopiedCue] = useState<Cue | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [mobileChipSheetCueId, setMobileChipSheetCueId] = useState<string | null>(null);
  const {
    visibleListIds, setVisibleListIds, activeListId, setActiveListId, toggleListVisibility,
    localEditableIds, setLocalEditableIds, setLocalManageIds,
    shareModalListId, setShareModalListId,
    accessModal, setAccessModal, accessModalConfirming, setAccessModalConfirming,
    visibleListIdsRef, activeListIdRef,
    activeCueList, canShareActive, visibleLists, listColorIndex, canEditActive, canEditCue,
    handleActivateList,
  } = useCueLists({ productionId, cueLists, editableListIds, manageListIds, myUserId });
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [savingCueId, setSavingCueId] = useState<string | null>(null);
  const { comments, setComments, activeCommentCueId, setActiveCommentCueId } = useCueComments({ productionId, selection });
  const {
    jumpTarget, setJumpTarget, jumpValue, setJumpValue,
    openToolbarMenu, secondaryMenusFolded, cueTagsFolded, toolbarCompact,
    activeMenuPosition, settingsMenuPosition, toggleToolbarMenu, finishToolbarAction, selectJumpTarget,
  } = useCueToolbarMenus({ toolbarStage, overflowOpen, closeOverflow });
  const { clientId, setPresenceMap, lastSentPresRef, sendCuePresence, presenceForCue, presenceForList } =
    useCuePresence({ productionId, activeListId, selection });

  // ── Toolbar menus ─────────────────────────────────────────────────────────

  const blockIndexMapRef = useRef<Map<string, number>>(new Map());

  // ── Presence ──────────────────────────────────────────────────────────────
  // Fetch real name from session (same localStorage key as ScriptEditor)
  // Load cue comments for this production

  // ── updateCueField ────────────────────────────────────────────────────────
  const updateCueField = useCallback(async (
    cue: Cue,
    fields: { number?: string; name?: string; content?: string; warning?: boolean; start?: CueAnchor; end?: CueAnchor }
  ) => {
    setSavingCueId(cue.id);
    try {
      const res = await patchCue(productionId, cue.cueListId, cue.id, versionIdRef.current, fields);
      if (res.ok) {
        setCues(prev => prev.map(c => c.id === cue.id ? { ...c, ...fields } : c));
      } else if (res.status === 409) {
        alert(res.error || "修改被拒绝");
      }
    } finally {
      setSavingCueId(null);
    }
  }, [productionId]);

  const updateCueFieldRef = useRef(updateCueField);
  useEffect(() => { updateCueFieldRef.current = updateCueField; }, [updateCueField]);

  const { dragLive, justDraggedRef, startCueDrag } = useCueDrag({ cues, blockIndexMapRef, updateCueFieldRef });

  // ── Cue SSE: refetch visible lists when any client mutates cues ───────────
  // 连接受可见性门控（#467）：后台标签不占同源连接名额。
  const cueRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCueRefetch = useCallback(() => {
    if (cueRefetchTimerRef.current) clearTimeout(cueRefetchTimerRef.current);
    cueRefetchTimerRef.current = setTimeout(async () => {
      cueRefetchTimerRef.current = null;
      const ids = new Set(visibleListIdsRef.current);
      if (activeListIdRef.current) ids.add(activeListIdRef.current);
      const listIds = [...ids];
      const vid = versionIdRef.current;
      const results = await Promise.all(listIds.map(listId => fetchListCues(productionId, listId, vid)));
      const fresh = results.flat();
      setCues(prev => [...prev.filter(c => !ids.has(c.cueListId)), ...fresh]);
    }, 300);
  }, [productionId, visibleListIdsRef, activeListIdRef]);

  // debounce timer 的生命周期比单次连接长（连接随可见性开合），挂 ref 由卸载统一清
  useEffect(() => () => {
    if (cueRefetchTimerRef.current) clearTimeout(cueRefetchTimerRef.current);
  }, []);

  useVisibleEventSource(
    `${BASE_PATH}/api/production/${productionId}/cue-stream${clientId ? `?cid=${encodeURIComponent(clientId)}` : ""}`,
    {
      onReopen: () => {
        // ① 隐藏/断线期间的变更帧不补发，先对一次账；
        scheduleCueRefetch();
        // ② 断连时服务端已把本端移出在场表（cancel → removeCuePresence），不重报的话
        //    切回标签页后别人看不见我，直到我下次动选区。去重键要先清——「值没变」
        //    的短路会把这次重报吞掉。
        lastSentPresRef.current = "";
        sendCuePresence(activeListId, selection.kind === "cue" ? selection.cueId : null);
      },
      // 连接一断本端就已出场，本地这份名单同时作废
      onClose: () => setPresenceMap(new Map()),
      listeners: {
        presence: (e: MessageEvent) => {
          const list = JSON.parse(e.data as string) as CuePresence[];
          setPresenceMap(new Map(list.map(p => [p.clientId, p])));
        },
        message: () => scheduleCueRefetch(),
      },
    },
  );

  // Cue ordering and gap anchors use the complete script sequence, including markers.
  const blockIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    orderedBlocks.forEach((b, i) => m.set(b.id, i));
    return m;
  }, [orderedBlocks]);
  const textBlockIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    blocks.forEach((b, i) => m.set(b.id, i));
    return m;
  }, [blocks]);
  useEffect(() => { blockIndexMapRef.current = blockIndexMap; }, [blockIndexMap]);

  // ── Orphaned cues: either anchor references a block that no longer exists ──
  // 跨表列出（#655）：报警来自公告页 / 首页时用户未必激活了那张表，只列激活表会让
  // 面板恒空、报警无处可消。按钮按各自表的编辑权限出，不再要求激活。
  const orphanedCues = useMemo(() => {
    return cues.filter(cue => {
      const startId = cue.start.kind === "block" ? cue.start.blockId : cue.start.afterBlockId;
      const endId   = cue.end.kind   === "block" ? cue.end.blockId   : cue.end.afterBlockId;
      return (startId !== null && !blockIndexMap.has(startId)) || (endId !== null && !blockIndexMap.has(endId));
    });
  }, [cues, blockIndexMap]);
  const cueListNameById = useMemo(() => new Map(cueLists.map(cl => [cl.id, cl.abbr || cl.name])), [cueLists]);

  // ── effectiveCues: apply live drag override for preview ───────────────────
  const effectiveCues = useMemo(() => {
    if (!dragLive) return cues;
    return cues.map(c => {
      if (c.id !== dragLive.cueId) return c;
      if (dragLive.dragType === "move") {
        return { ...c, start: dragLive.anchor, end: dragLive.anchor };
      }
      if (dragLive.dragType === "expand" && dragLive.originalAnchor) {
        const k  = anchorSortKey(dragLive.anchor, blockIndexMap);
        const ok = anchorSortKey(dragLive.originalAnchor, blockIndexMap);
        if (k < ok) return { ...c, start: dragLive.anchor,         end: dragLive.originalAnchor };
        if (k > ok) return { ...c, start: dragLive.originalAnchor, end: dragLive.anchor };
        return c;
      }
      if (dragLive.dragType === "handle-start") return { ...c, start: dragLive.anchor };
      if (dragLive.dragType === "handle-end")   return { ...c, end: dragLive.anchor };
      return c;
    });
  }, [cues, dragLive, blockIndexMap]);

  // ── Group effective cues by list ──────────────────────────────────────────
  const cuesByList = useMemo(() => {
    const m = new Map<string, Cue[]>();
    for (const c of effectiveCues) {
      if (!m.has(c.cueListId)) m.set(c.cueListId, []);
      m.get(c.cueListId)!.push(c);
    }
    return m;
  }, [effectiveCues]);

  // ── Other derived state ───────────────────────────────────────────────────
  const charName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of characters) m.set(c.id, c.name);
    return m;
  }, [characters]);

  const sceneMap = useMemo(() => {
    const m = new Map<string, Scene>();
    for (const s of scenes) m.set(s.id, s);
    return m;
  }, [scenes]);
  const sceneParentIdById = useMemo(() => sceneParentIdMap(scenes), [scenes]);
  const { sequenceBeforeTextBlock, trailingSequence } = useMemo(() => {
    const beforeText = new Map<string, CueSequenceItem[]>();
    let pending: CueSequenceItem[] = [];
    for (let index = 0; index < orderedBlocks.length; index++) {
      const block = orderedBlocks[index];
      if (hasScriptInsertionGapBefore(orderedBlocks, index, sceneParentIdById)) {
        pending.push({ kind: "gap", afterBlockId: orderedBlocks[index - 1].id });
      }
      if (isMarkerBlock(block)) {
        pending.push({ kind: "marker", block });
      } else {
        beforeText.set(block.id, pending);
        pending = [];
      }
    }
    return { sequenceBeforeTextBlock: beforeText, trailingSequence: pending };
  }, [orderedBlocks, sceneParentIdById]);

  const handleContainerClick = useCallback(() => setSelection({ kind: "none" }), []);

  const handleBlockSelect = useCallback((blockId: string, start: number, end: number) => {
    setSelection({ kind: "pending", start: { kind: "block", blockId, offset: start }, end: { kind: "block", blockId, offset: end } });
  }, []);

  // Returns the first visible range cue whose highlighted area contains (blockId, offset).
  const findRangeCueAtPosition = useCallback((blockId: string, offset: number): Cue | null => {
    const bi = textBlockIndexMap.get(blockId) ?? -1;
    if (bi === -1) return null;
    for (const cl of visibleLists) {
      for (const cue of (cuesByList.get(cl.id) ?? [])) {
        if (isPointCue(cue)) continue;
        if (cue.start.kind !== "block" || cue.end.kind !== "block") continue;
        const si = textBlockIndexMap.get(cue.start.blockId) ?? -1;
        const ei = textBlockIndexMap.get(cue.end.blockId) ?? -1;
        if (bi < si || bi > ei) continue;
        if (bi === si && bi === ei) {
          if (offset < cue.start.offset || offset > cue.end.offset) continue;
        } else if (bi === si) {
          if (offset < cue.start.offset) continue;
        } else if (bi === ei) {
          if (offset > cue.end.offset) continue;
        }
        return cue;
      }
    }
    return null;
  }, [textBlockIndexMap, visibleLists, cuesByList]);

  const handleBlockClick = useCallback((blockId: string, offset: number) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const rangeCue = findRangeCueAtPosition(blockId, offset);
    if (rangeCue) { setSelection({ kind: "cue", cueId: rangeCue.id }); return; }
    setSelection({ kind: "pending", start: { kind: "block", blockId, offset }, end: { kind: "block", blockId, offset } });
  }, [findRangeCueAtPosition, justDraggedRef]);

  const handleMarkClick = useCallback((cueId: string) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const realId = cueId.endsWith(":end") ? cueId.slice(0, -4) : cueId;
    setSelection({ kind: "cue", cueId: realId });
  }, [justDraggedRef]);

  const handleGapClick = useCallback((afterBlockId: string) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const anchor: CueAnchor = { kind: "gap", afterBlockId };
    setSelection({ kind: "pending", start: anchor, end: anchor });
  }, [justDraggedRef]);

  // ── Insert cue ────────────────────────────────────────────────────────────
  const insertCue = useCallback(async () => {
    if (selection.kind !== "pending" || !activeListId || !canEditActive) return;
    const { start, end } = selection;

    const existing = (cuesByList.get(activeListId) ?? []).map(c => c.number);
    // parseInt stops at the first non-digit, so "7.5" → 7, "1-0" → 1.
    // The old replace(/\D/g,"") was too greedy: "7.5"→75, "1-0"→10.
    const nums = existing.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    const next = nums.length ? Math.max(...nums) + 1 : 1;

    const newCues = await createCue(productionId, activeListId, versionIdRef.current, { number: String(next), name: "", content: "", start, end });
    if (newCues) {
      setCues(prev => {
        const withoutList = prev.filter(c => c.cueListId !== activeListId);
        return [...withoutList, ...newCues];
      });
      const created = newCues.find(c => anchorEq(c.start, start) && anchorEq(c.end, end));
      if (created) setSelection({ kind: "cue", cueId: created.id });
    }
  }, [selection, activeListId, canEditActive, cuesByList, productionId]);

  // ── Delete cue ────────────────────────────────────────────────────────────
  const deleteCue = useCallback(async (cue: Cue) => {
    if (await deleteCueRemote(productionId, cue.cueListId, cue.id, versionIdRef.current)) {
      setCues(prev => prev.filter(c => c.id !== cue.id));
      setSelection({ kind: "none" });
    }
  }, [productionId]);

  const dismissWarning = useCallback(async (cue: Cue) => {
    await updateCueField(cue, { warning: false });
  }, [updateCueField]);

  // Re-anchor an orphaned cue to the current pending selection
  const reassignOrphanedCue = useCallback(async (cue: Cue) => {
    if (selection.kind !== "pending" || !localEditableIds.has(cue.cueListId)) return;
    await updateCueField(cue, { start: selection.start, end: selection.end, warning: false });
  }, [selection, localEditableIds, updateCueField]);

  // Start dragging an orphaned cue into the script; ensure the list is visible so preview renders
  const startOrphanDrag = useCallback((e: React.MouseEvent, cue: Cue) => {
    setVisibleListIds(prev => prev.has(cue.cueListId) ? prev : new Set([...prev, cue.cueListId]));
    startCueDrag(e, cue.id, "move");
  }, [startCueDrag, setVisibleListIds]);

  const {
    scrollContainerRef, topSpacerRef, botSpacerRef,
    windowRange, spacerH, highlightedCueId, setHighlightedCueId,
    scrollToBlockIdx, scrollToScene, jumpToLine, jumpToPage,
  } = useCueVirtualWindow({ blocks, productionId, pageMap });

  // ── URL params: ?cueList=&cueId= — deep-link from #script-mention chips ──
  const cueNavDoneRef = useRef(false);
  useEffect(() => {
    if (cueNavDoneRef.current) return;
    cueNavDoneRef.current = true;
    const sp = new URLSearchParams(window.location.search);
    const cueListParam = sp.get("cueList");
    const cueIdParam = sp.get("cueId");
    if (!cueListParam) return;
    setVisibleListIds(prev => prev.has(cueListParam) ? prev : new Set([...prev, cueListParam]));
    setActiveListId(cueListParam);
    if (!cueIdParam) return;
    // 链接里带的是稳定 cue_id（#302），高亮/滚动用的是本版本那条修订的行 id——
    // 查得按 cueId、设得按 id，两边不能都用 param。
    const cue = initialCues.find(c => c.cueId === cueIdParam);
    if (!cue) return;
    const blockId = cue.start.kind === "block" ? cue.start.blockId : cue.start.afterBlockId;
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx >= 0) scrollToBlockIdx(idx, "center");
    setHighlightedCueId(cue.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToBlockIdx]);

  const selectedCue = selection.kind === "cue"
    ? effectiveCues.find(c => c.id === selection.cueId) ?? null
    : null;

  const blockCharLabel = useCallback((block: Block) => {
    return block.characterIds.map(id => charName.get(id) ?? id).join("、");
  }, [charName]);

  // ── Per-block rendering data ──────────────────────────────────────────────

  const cuesForBlock = useMemo(() => {
    const map = new Map<string, { cue: Cue; listIdx: number }[]>();
    for (const cl of visibleLists) {
      const listCues = cuesByList.get(cl.id) ?? [];
      const idx = listColorIndex.get(cl.id) ?? 0;
      for (const cue of listCues) {
        const blockId = cue.start.kind === "block" ? cue.start.blockId : cue.start.afterBlockId;
        if (blockId === null) continue;
        if (!map.has(blockId)) map.set(blockId, []);
        map.get(blockId)!.push({ cue, listIdx: idx });
      }
    }
    return map;
  }, [visibleLists, cuesByList, listColorIndex]);

  const rangeHighlightsForBlock = useMemo(() => {
    const map = new Map<string, { start: number; end: number; colorIdx: number; label?: string }[]>();
    const push = (bId: string, start: number, end: number, colorIdx: number, label?: string) => {
      if (!map.has(bId)) map.set(bId, []);
      map.get(bId)!.push({ start, end, colorIdx, label });
    };
    for (const cl of visibleLists) {
      const listCues = cuesByList.get(cl.id) ?? [];
      const idx = listColorIndex.get(cl.id) ?? 0;
      const label = (cue: Cue) => `Q${cue.number}${cue.name ? ` ${cue.name}` : ""}`;
      for (const cue of listCues) {
        if (isPointCue(cue)) continue;
        if (cue.start.kind !== "block" || cue.end.kind !== "block") continue;
        const si = textBlockIndexMap.get(cue.start.blockId) ?? -1;
        const ei = textBlockIndexMap.get(cue.end.blockId) ?? -1;
        if (si === -1 || ei === -1) continue;
        if (si === ei) {
          push(cue.start.blockId, cue.start.offset, cue.end.offset, idx, label(cue));
        } else {
          push(cue.start.blockId, cue.start.offset, blocks[si].content.length, idx, label(cue));
          for (let i = si + 1; i < ei; i++)
            push(blocks[i].id, 0, blocks[i].content.length, idx, label(cue));
          push(cue.end.blockId, 0, cue.end.offset, idx, label(cue));
        }
      }
    }
    return map;
  }, [visibleLists, cuesByList, listColorIndex, blocks, textBlockIndexMap]);

  // Unified marks: point cue marks + range start marks (always, for guide lines) + end handles (when selected)
  const cueMarksForBlock = useMemo(() => {
    const map = new Map<string, CueMark[]>();
    for (const cl of visibleLists) {
      const listCues = cuesByList.get(cl.id) ?? [];
      const idx = listColorIndex.get(cl.id) ?? 0;
      const colorHex = LIST_COLORS[idx % LIST_COLORS.length].line;
      for (const cue of listCues) {
        const isSelected = selection.kind === "cue" && selection.cueId === cue.id;
        const canEdit = canEditCue(cue);
        if (isPointCue(cue)) {
          if (cue.start.kind !== "block") continue;
          const bId = cue.start.blockId;
          const origAnchor = cue.start;
          if (!map.has(bId)) map.set(bId, []);
          map.get(bId)!.push({
            cueId: cue.id,
            offset: cue.start.offset,
            colorHex,
            selected: isSelected,
            dragConfig: canEdit ? { dragType: "expand", origAnchor } : undefined,
          });
        } else {
          // Range: always show start mark (guide line anchor + handle when selected)
          if (cue.start.kind === "block") {
            const bId = cue.start.blockId;
            if (!map.has(bId)) map.set(bId, []);
            map.get(bId)!.push({
              cueId: cue.id,
              offset: cue.start.offset,
              colorHex,
              selected: isSelected,
              dragConfig: canEdit && isSelected ? { dragType: "handle-start" } : undefined,
            });
          }
          // End handle only when selected (different cueId so guide line doesn't use it)
          if (isSelected && cue.end.kind === "block") {
            const bId = cue.end.blockId;
            if (!map.has(bId)) map.set(bId, []);
            map.get(bId)!.push({
              cueId: `${cue.id}:end`,
              offset: cue.end.offset,
              colorHex,
              selected: true,
              dragConfig: canEdit ? { dragType: "handle-end" } : undefined,
            });
          }
        }
      }
    }
    return map;
  }, [visibleLists, cuesByList, listColorIndex, selection, canEditCue]);

  const pendingHighlightForBlock = useMemo((): Map<string, { start: number; end: number }> => {
    const map = new Map<string, { start: number; end: number }>();
    if (selection.kind === "pending" &&
        selection.start.kind === "block" && selection.end.kind === "block" &&
        selection.start.blockId === selection.end.blockId &&
        selection.start.offset !== selection.end.offset) {
      map.set(selection.start.blockId, { start: selection.start.offset, end: selection.end.offset });
    }
    return map;
  }, [selection]);

  const pendingIsGap = selection.kind === "pending" && selection.start.kind === "gap";
  const pendingGapBlockId = pendingIsGap
    ? (selection.start as { kind: "gap"; afterBlockId: string }).afterBlockId
    : null;

  const { blockRowRefs, guideLines } = useCueGuideLines({ cuesForBlock, selection, dragLive });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const selectedCueRef = useRef(selectedCue);
  useEffect(() => { selectedCueRef.current = selectedCue; }, [selectedCue]);

  // pasteRef holds the latest paste closure so the keyboard handler never goes stale
  const pasteRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    pasteRef.current = async () => {
      if (selection.kind !== "pending" || !activeListId || !canEditActive || !copiedCue) return;
      const { start, end } = selection;
      const existing = (cuesByList.get(activeListId) ?? []).map(c => c.number);
      const nums = existing.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const newCues = await createCue(productionId, activeListId, versionIdRef.current, { number: String(next), name: copiedCue.name, content: copiedCue.content, start, end });
      if (newCues) {
        setCues(prev => {
          const withoutList = prev.filter(c => c.cueListId !== activeListId);
          return [...withoutList, ...newCues];
        });
        const created = newCues.find(c => anchorEq(c.start, start) && anchorEq(c.end, end));
        if (created) setSelection({ kind: "cue", cueId: created.id });
      }
    };
  }, [selection, activeListId, canEditActive, copiedCue, cuesByList, productionId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Backspace" || e.key === "Delete") {
        const cue = selectedCueRef.current;
        if (cue && canEditCue(cue)) { e.preventDefault(); deleteCue(cue); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        const cue = selectedCueRef.current;
        if (cue) { e.preventDefault(); setCopiedCue(cue); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        e.preventDefault();
        pasteRef.current?.();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canEditCue, deleteCue]);

  // ── Final-gap derived values (avoids IIFE in JSX that confuses React compiler) ──
  const lastOrderedBlock = orderedBlocks.length > 0 ? orderedBlocks[orderedBlocks.length - 1] : null;
  const insertCueAvailable = selection.kind === "pending" && activeListId !== null && canEditActive;

  const renderGap = (afterBlockId: string, key: string, minHeight = 22) => {
    const gapChips = (cuesForBlock.get(afterBlockId) ?? []).filter(({ cue }) => cue.start.kind === "gap");
    const gapPending = pendingGapBlockId === afterBlockId;
    return (
      <div
        key={key}
        data-gap-after={afterBlockId}
        className={`flex cursor-pointer items-center gap-0 rounded transition-colors group ${
          gapPending ? "bg-zinc-200/70" : "hover:bg-zinc-100"
        }`}
        style={{ minHeight: `${minHeight}px` }}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); handleGapClick(afterBlockId); }}
      >
        <div className="flex w-8 shrink-0 flex-wrap gap-1 px-1 py-1 sm:w-44 sm:px-2">
          {gapChips.map(({ cue, listIdx }) => {
            const color = colorFor(listIdx);
            return (
              <React.Fragment key={cue.id}>
                <button
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white sm:hidden ${color.bg} ${cue.warning ? "ring-2 ring-amber-400" : ""}`}
                  onClick={event => { event.stopPropagation(); setMobileChipSheetCueId(cue.id); setSelection({ kind: "cue", cueId: cue.id }); }}
                >
                  {cue.number || "Q"}
                </button>
                <div className="hidden sm:block">
                  <CueChip
                    cue={cue}
                    colorIdx={listIdx}
                    selected={selection.kind === "cue" && selection.cueId === cue.id}
                    warning={cue.warning}
                    editable={canEditCue(cue)}
                    presenceUsers={presenceForCue.get(cue.id) ?? []}
                    onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                    onCommitNumber={value => updateCueField(cue, { number: value })}
                    onCommitName={value => updateCueField(cue, { name: value })}
                    highlighted={highlightedCueId === cue.id}
                    onDragStart={canEditCue(cue) ? (event) => startCueDrag(event, cue.id, "move") : undefined}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="flex flex-1 items-center gap-2 pr-2">
          <div className="h-px flex-1 bg-zinc-200 transition-colors group-hover:bg-zinc-300" />
          {activeListId && canEditActive && (
            <span className="select-none text-[10px] text-zinc-300 transition-colors group-hover:text-zinc-400">+ Cue</span>
          )}
        </div>
      </div>
    );
  };

  const renderMarker = (block: Block, key: string) => {
    if (block.type === "rehearsal_marker") {
      const label = rehearsalLabelByMarkerId.get(block.id) ?? "";
      return (
        <div key={key} className="px-2 pb-1 pt-3 text-[10px] font-bold text-zinc-400">
          {label}
        </div>
      );
    }
    const sceneId = block.sceneId ?? block.id;
    const scene = sceneMap.get(sceneId);
    if (!scene) return null;
    return (
      <div key={key} id={`cue-scene-${scene.id}`} className="scroll-mt-4 px-2 pb-1 pt-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400">
          {scene.number} {scene.name}
        </p>
      </div>
    );
  };

  const renderSequence = (items: CueSequenceItem[], keyPrefix: string) => items.map((item, index) => (
    item.kind === "gap"
      ? renderGap(item.afterBlockId, `${keyPrefix}:gap:${item.afterBlockId}:${index}`)
      : renderMarker(item.block, `${keyPrefix}:marker:${item.block.id}`)
  ));

  const toolbarTriggerClass = "flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800";

  const cueOverflow = toolbarCompact ? (
    <>
      <p className="px-3 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">跳转</p>
      <CueJumpOptions onSelect={selectJumpTarget} />
      <div className="my-1 border-t border-zinc-50" />
      <button
        type="button"
        onClick={() => { finishToolbarAction(); setShowExport(true); }}
        className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
      >
        导出
      </button>
      <ProductionOverflowSubmenuButton
        menuId="settings"
        label="设置"
        expanded={openToolbarMenu === "settings"}
        onToggle={(anchor) => {
          settingsMenuPosition.anchorRef.current = anchor;
          toggleToolbarMenu("settings");
        }}
      />
    </>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS} onClick={handleContainerClick}>

      {/* ── Top bar ── */}
      <ProductionTopMenu onClick={e => e.stopPropagation()} overflow={cueOverflow}>
        <div className="flex shrink-0 flex-col" style={{ lineHeight: 1.2 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--script)", whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
            {productionName}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>Cue</span>
        </div>
        <ProductionTopMenuDivider />
        <div className="relative -ml-1 shrink-0">
          <button
            ref={activeMenuPosition.anchorRef}
            type="button"
            data-cue-toolbar-menu-trigger="active"
            aria-expanded={openToolbarMenu === "active"}
            onClick={() => toggleToolbarMenu("active")}
            className={`flex ${cueTagsFolded ? "max-w-[118px]" : "max-w-40"} items-baseline gap-1 whitespace-nowrap rounded px-1.5 py-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
          >
            {!cueTagsFolded && (
              <span className="shrink-0 text-[10px] text-zinc-400">当前编辑</span>
            )}
            <span className="min-w-0 truncate text-sm">{activeCueList?.name ?? "—"}</span>
            <ChevronIcon size={12} className="shrink-0 self-center opacity-50" />
          </button>
          {openToolbarMenu === "active" && (
            <div
              data-cue-toolbar-menu-panel="active"
              ref={activeMenuPosition.menuRef}
              style={activeMenuPosition.style}
              className="z-40 w-52 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md"
            >
              <p className="px-3 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">当前正在编辑</p>
              <button
                type="button"
                onClick={() => { void handleActivateList(null); finishToolbarAction(); }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 ${
                  activeListId === null ? "font-medium text-zinc-800" : "text-zinc-600"
                }`}
              >
                <span>—</span>
                {activeListId === null && <span className="text-[10px] text-zinc-400">✓</span>}
              </button>
              {cueLists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => { void handleActivateList(list.id); finishToolbarAction(); }}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 ${
                    activeListId === list.id ? "font-medium text-zinc-800" : "text-zinc-600"
                  }`}
                >
                  <span className="min-w-0 truncate">{list.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {!localEditableIds.has(list.id) && <span className="text-[10px] text-zinc-400">只读</span>}
                    {activeListId === list.id && <span className="text-[10px] text-zinc-400">✓</span>}
                  </span>
                </button>
              ))}
              {cueTagsFolded && (
                <>
                  <div className="my-1 border-t border-zinc-50" />
                  <p className="px-3 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">显示</p>
                  <div className="max-h-56 overflow-y-auto">
                    {cueLists.length === 0 ? (
                      <p className="px-3 py-1.5 text-sm text-zinc-300">暂无 Cue 表</p>
                    ) : cueLists.map((list, index) => {
                      const color = colorFor(index);
                      const isActive = list.id === activeListId;
                      const isVisible = isActive || visibleListIds.has(list.id);
                      return (
                        <button
                          key={list.id}
                          type="button"
                          onClick={() => toggleListVisibility(list.id)}
                          disabled={isActive}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm text-zinc-600 ${
                            isActive ? "cursor-default" : "hover:bg-zinc-50"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${color.bg}`} />
                            <span className="truncate">{list.name}</span>
                          </span>
                          <span
                            aria-hidden
                            className={`relative h-4 w-7 rounded-full transition-colors ${
                              isVisible ? color.bg : "bg-zinc-200"
                            }`}
                          >
                            <span
                              className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                                isVisible ? "translate-x-3" : "translate-x-0"
                              }`}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <span className={`${canEditActive ? "ml-[3px]" : "ml-0.5"} shrink-0 rounded bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-zinc-400`}>
          {canEditActive ? "可编辑" : "只读"}
        </span>

        {/* List chips are the first controls folded when toolbar space runs out. */}
        {!cueTagsFolded && (
          <div className="flex min-w-0 flex-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          <div data-production-toolbar-flex-content="true" className="ml-2 flex w-max shrink-0 flex-nowrap gap-1.5">
            {cueLists.map((cl, i) => {
              const c = colorFor(i);
              const isActive = cl.id === activeListId;
              const on = isActive || visibleListIds.has(cl.id);
              const lp = presenceForList.get(cl.id) ?? [];
              return (
                <div key={cl.id} className="flex shrink-0 flex-col items-center gap-0.5">
                  <button
                    onClick={() => toggleListVisibility(cl.id)}
                    disabled={isActive}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-all ${
                      on ? `${c.bg} text-white` : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
                    } ${isActive ? "cursor-default" : ""}`}
                  >
                    {cl.name}
                  </button>
                  {lp.length > 0 && (
                    <div className="flex -space-x-0.5" title={lp.map(p => p.userName).join("、")}>
                      {lp.slice(0, 4).map(p => (
                        <div key={p.clientId} style={{ backgroundColor: p.color }} className="h-2 w-2 rounded-full ring-1 ring-white" />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        )}

        {!toolbarCompact && (
          <div className={`${PRODUCTION_TOP_MENU_RIGHT_CLASS} ml-auto flex shrink-0 items-center gap-1`}>
        {/* Desktop: list actions */}
        <div className="mx-0.5 h-4 w-px shrink-0 bg-zinc-100" />
        {!secondaryMenusFolded && canShareActive && (
          <>
            <button
              type="button"
              onClick={() => setShareModalListId(activeListId)}
              className={toolbarTriggerClass}
            >
              分享
            </button>
            <div className="mx-0.5 h-4 w-px shrink-0 bg-zinc-100" />
          </>
        )}
        {secondaryMenusFolded ? (
          <div className="relative shrink-0">
            <button
              type="button"
              data-cue-toolbar-menu-trigger="jump"
              aria-expanded={openToolbarMenu === "jump"}
              onClick={() => toggleToolbarMenu("jump")}
              className={`${toolbarTriggerClass} ${openToolbarMenu === "jump" ? "bg-zinc-100 text-zinc-800" : ""}`}
            >
              跳转 <ChevronIcon size={12} className="opacity-50" />
            </button>
            {openToolbarMenu === "jump" && (
              <div
                data-cue-toolbar-menu-panel="jump"
                className="absolute right-0 top-full z-40 mt-2.5 w-44 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md"
              >
                <CueJumpOptions onSelect={selectJumpTarget} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="mr-0.5 shrink-0 text-[10px] text-zinc-400">跳转至</span>
            {CUE_JUMP_OPTIONS.map(({ target, label }) => (
              <button
                key={target}
                type="button"
                onClick={() => selectJumpTarget(target)}
                className={`rounded px-1.5 py-1 text-sm transition-colors ${
                  jumpTarget === target
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {!secondaryMenusFolded && <div className="mx-0.5 h-4 w-px shrink-0 bg-zinc-100" />}
        <button
          type="button"
          onClick={() => setShowExport(true)}
          className={toolbarTriggerClass}
        >
          导出
        </button>
        {secondaryMenusFolded ? (
          <button
            ref={settingsMenuPosition.anchorRef}
            type="button"
            data-cue-toolbar-menu-trigger="settings"
            aria-expanded={openToolbarMenu === "settings"}
            onClick={() => toggleToolbarMenu("settings")}
            className={`${toolbarTriggerClass} ${openToolbarMenu === "settings" ? "bg-zinc-100 text-zinc-800" : ""}`}
          >
            设置 <ChevronIcon size={12} className="opacity-50" />
          </button>
        ) : (
          <Link href={`/production/${productionId}/cuelists`} className={toolbarTriggerClass}>
            设置
          </Link>
        )}
        {!cueTagsFolded && insertCueAvailable && (
          <button
            onClick={e => { e.stopPropagation(); insertCue(); }}
            className="block shrink-0 rounded bg-zinc-800 px-3 py-1 text-xs text-white hover:bg-zinc-900"
          >
            插入 Cue
          </button>
        )}

          </div>
        )}
        {secondaryMenusFolded && openToolbarMenu === "settings" && (
          <div
            data-cue-toolbar-menu-panel="settings"
            data-production-overflow-menu-child={toolbarCompact ? "true" : undefined}
            ref={settingsMenuPosition.menuRef}
            style={settingsMenuPosition.style}
            className="z-40 w-64 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md"
          >
            {canShareActive && (
              <button
                type="button"
                onClick={() => { finishToolbarAction(); setShareModalListId(activeListId); }}
                className="flex w-full min-w-0 px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
              >
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                  分享当前 Cue 表：{activeCueList?.name ?? "—"}
                </span>
              </button>
            )}
            <Link
              href={`/production/${productionId}/cuelists`}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
              onClick={finishToolbarAction}
            >
              Cue 表设置
            </Link>
          </div>
        )}
      </ProductionTopMenu>

      {/* ── Jump bar panel ── */}
      {jumpTarget && (
        <div className="shrink-0 border-t border-[var(--line)] bg-[var(--surface)] px-4 py-2 flex items-center gap-3" onClick={e => e.stopPropagation()}>
          {jumpTarget === "scene" ? (
            <>
              <span className="shrink-0 text-xs text-zinc-400">段落跳转</span>
              <OverflowSafeSelect
                autoFocus
                value={jumpValue}
                onChange={e => {
                  setJumpValue(e.target.value);
                  if (e.target.value) { scrollToScene(e.target.value); setJumpTarget(null); }
                }}
                className="flex-1 h-7 rounded border border-zinc-200 px-2 text-sm text-zinc-700 outline-none focus:border-zinc-400 bg-white"
              >
                <option value="">选择段落…</option>
                {scenes.map(s => (
                  <option key={s.id} value={s.id}>{s.number} {s.name}</option>
                ))}
              </OverflowSafeSelect>
              <button onClick={() => setJumpTarget(null)} className="text-xs text-zinc-300 hover:text-zinc-500">取消</button>
            </>
          ) : (
            <>
              <span className="shrink-0 text-xs text-zinc-400">
                {jumpTarget === "line" ? "行跳转" : "页跳转"}
              </span>
              <input
                autoFocus
                type="number"
                min={1}
                max={jumpTarget === "line" ? blocks.length : (Object.values(pageMap).length ? Math.max(...Object.values(pageMap)) : 1)}
                value={jumpValue}
                onChange={e => setJumpValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") setJumpTarget(null);
                  if (e.key === "Enter") {
                    const n = parseInt(jumpValue, 10);
                    if (!isNaN(n)) { if (jumpTarget === "line") jumpToLine(n); else jumpToPage(n); }
                    setJumpTarget(null);
                  }
                }}
                placeholder={jumpTarget === "line" ? `1–${blocks.length}` : `1–${Object.values(pageMap).length ? Math.max(...Object.values(pageMap)) : "?"}`}
                className="h-7 w-28 rounded border border-zinc-200 px-2 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
              />
              <button
                onClick={() => {
                  const n = parseInt(jumpValue, 10);
                  if (!isNaN(n)) { if (jumpTarget === "line") jumpToLine(n); else jumpToPage(n); }
                  setJumpTarget(null);
                }}
                className="rounded bg-zinc-800 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
              >跳转</button>
              <button onClick={() => setJumpTarget(null)} className="text-xs text-zinc-300 hover:text-zinc-500">取消</button>
            </>
          )}
        </div>
      )}

      {/* ── Script + Cue lanes ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto py-6 px-2">
          <div ref={topSpacerRef} style={{ height: spacerH.top }} aria-hidden="true" />
          {blocks.slice(windowRange.start, windowRange.end).map((block, wIdx) => {
            const blockIdx = windowRange.start + wIdx;
            const chipsHere = cuesForBlock.get(block.id) ?? [];
            const rangeHL = rangeHighlightsForBlock.get(block.id) ?? [];
            const pendingHL = pendingHighlightForBlock.get(block.id) ?? null;
            const prevBlock = blockIdx > 0 ? blocks[blockIdx - 1] : null;
            const rehearsalLabel = block.rehearsalMark ? rehearsalLabelByMarkerId.get(block.rehearsalMark) : null;
            const precedingSequence = sequenceBeforeTextBlock.get(block.id) ?? [];

            const scene = block.sceneId ? sceneMap.get(block.sceneId) : null;
            const prevScene = prevBlock?.sceneId ? sceneMap.get(prevBlock.sceneId) : null;
            const sequenceContainsScene = !!scene && precedingSequence.some(item => (
              item.kind === "marker" && (item.block.sceneId ?? item.block.id) === scene.id
            ));
            const showSceneHeading = scene && scene.id !== prevScene?.id && !sequenceContainsScene;

            return (
              <div key={block.id} data-cue-bwrap={block.id}>
                {renderSequence(precedingSequence, block.id)}

                {/* Scene heading */}
                {showSceneHeading && (
                  <div id={`cue-scene-${scene!.id}`} className="px-2 pt-3 pb-1 scroll-mt-4">
                    <p className="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase">
                      {scene!.number} {scene!.name}
                    </p>
                  </div>
                )}

                {/* Block row */}
                <div
                  id={`cue-block-${block.id}`}
                  ref={el => { if (el) blockRowRefs.current.set(block.id, el); else blockRowRefs.current.delete(block.id); }}
                  className="flex gap-0 rounded-lg py-1.5 hover:bg-white/60 transition-colors relative scroll-mt-4"
                  onClick={e => e.stopPropagation()}
                >
                  {/* SVG guide lines: Bezier curves from chip right edge to inline mark */}
                  {(guideLines.get(block.id) ?? []).length > 0 && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible hidden sm:block" style={{ zIndex: 1 }}>
                      {(guideLines.get(block.id)!).map(line => {
                        const sel = selection.kind === "cue" && selection.cueId === line.cueId;
                        const mx = (line.chipX + line.markX) / 2;
                        return (
                          <path
                            key={line.cueId}
                            d={`M ${line.chipX},${line.chipY} C ${mx},${line.chipY} ${mx},${line.markY} ${line.markX},${line.markY}`}
                            stroke={line.color}
                            strokeWidth={sel ? 1.5 : 1}
                            fill="none"
                            opacity={sel ? 0.65 : 0.22}
                            strokeDasharray="3 2"
                          />
                        );
                      })}
                    </svg>
                  )}
                  <div className="w-8 sm:w-44 shrink-0 flex flex-col gap-1 pt-0.5 px-1 sm:px-2" data-chip-col-for={block.id}>
                    {chipsHere
                      .filter(({ cue }) => cue.start.kind === "block")
                      .map(({ cue, listIdx }) => {
                        const c = colorFor(listIdx);
                        const isSel = selection.kind === "cue" && selection.cueId === cue.id;
                        return (
                          <React.Fragment key={cue.id}>
                            {/* Mobile handle: colored circle */}
                            <button
                              className={`sm:hidden flex items-center justify-center w-6 h-6 rounded-full text-white text-[9px] font-bold shrink-0 ${c.bg} ${cue.warning ? "ring-2 ring-amber-400" : ""}`}
                              onClick={e => { e.stopPropagation(); setMobileChipSheetCueId(cue.id); setSelection({ kind: "cue", cueId: cue.id }); }}
                            >
                              {cue.number || "Q"}
                            </button>
                            {/* Desktop: full CueChip */}
                            <div className="hidden sm:block">
                              <CueChip
                                cue={cue}
                                colorIdx={listIdx}
                                selected={isSel}
                                warning={cue.warning}
                                editable={canEditCue(cue)}
                                presenceUsers={presenceForCue.get(cue.id) ?? []}
                                onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                                onCommitNumber={v => updateCueField(cue, { number: v })}
                                onCommitName={v => updateCueField(cue, { name: v })}
                                highlighted={highlightedCueId === cue.id}
                                onDragStart={canEditCue(cue) ? (e) => startCueDrag(e, cue.id, "move") : undefined}
                              />
                            </div>
                          </React.Fragment>
                        );
                      })
                    }
                  </div>

                  <div className="flex-1 min-w-0 sm:w-[520px] sm:flex-none pr-4">
                    {block.characterIds.length > 0 && (
                      <p className="text-[10px] font-semibold text-zinc-400 mb-0.5">
                        {blockCharLabel(block)}
                        {block.lyric && <span className="ml-1 text-zinc-300">♪</span>}
                      </p>
                    )}
                    <p className={`text-sm leading-relaxed text-zinc-700 ${block.type === "stage" ? "italic text-zinc-500" : ""}`}>
                      <BlockText
                        blockId={block.id}
                        content={block.content}
                        rangeHighlights={rangeHL}
                        pendingHighlight={pendingHL}
                        pointMarks={cueMarksForBlock.get(block.id) ?? []}
                        pendingCursor={
                          selection.kind === "pending" &&
                          selection.start.kind === "block" &&
                          selection.start.blockId === block.id &&
                          anchorEq(selection.start, selection.end)
                            ? selection.start.offset
                            : null
                        }
                        onClick={handleBlockClick}
                        onSelect={handleBlockSelect}
                        onMarkDrag={startCueDrag}
                        onMarkClick={handleMarkClick}
                      />
                    </p>
                  </div>

                  {/* Line / page / rehearsal mark info */}
                  <div className="shrink-0 hidden sm:flex flex-col items-end justify-start pt-0.5 pr-2 gap-0.5 w-14 select-none">
                    {rehearsalLabel && (
                      <span className="text-[10px] font-bold text-zinc-500 leading-none">{rehearsalLabel}</span>
                    )}
                    <span className="text-[10px] text-zinc-300 tabular-nums leading-none">#{blockIdx + 1}</span>
                    {pageMap[block.id] != null && (
                      <span className="text-[10px] text-zinc-300 tabular-nums leading-none">p.{pageMap[block.id]}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {renderSequence(trailingSequence, "trailing")}
          {lastOrderedBlock && renderGap(lastOrderedBlock.id, "final-gap", 32)}
          <div ref={botSpacerRef} style={{ height: spacerH.bot }} aria-hidden="true" />
        </div>
      </div>

      {/* ── Orphaned cues panel (hidden when empty) ── */}
      {orphanedCues.length > 0 && (
        <div
          className="shrink-0 bg-amber-50 border-t border-amber-200 px-4 py-2.5"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-semibold text-amber-700">⚠ 失效的 Cue</span>
            <span className="text-[10px] text-amber-500">所在的剧本块已删除 · 从此处拖拽或选中脚本范围后点击「定位到选区」</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {orphanedCues.map(cue => {
              const listIdx = listColorIndex.get(cue.cueListId) ?? 0;
              const isDragging = dragLive?.cueId === cue.id;
              const canEdit = localEditableIds.has(cue.cueListId);
              const canReassign = selection.kind === "pending" && canEdit;
              return (
                <div
                  key={cue.id}
                  className={`flex items-center gap-1.5 transition-opacity ${isDragging ? "opacity-25" : ""}`}
                >
                  <span className="text-[10px] text-amber-700/70 shrink-0">{cueListNameById.get(cue.cueListId) ?? ""}</span>
                  <CueChip
                    cue={cue}
                    colorIdx={listIdx}
                    selected={selection.kind === "cue" && selection.cueId === cue.id}
                    warning={true}
                    editable={false}
                    presenceUsers={presenceForCue.get(cue.id) ?? []}
                    onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                    onCommitNumber={() => {}}
                    onCommitName={() => {}}
                    onDragStart={canEdit ? (e) => startOrphanDrag(e, cue) : undefined}
                  />
                  {canReassign && (
                    <button
                      onClick={e => { e.stopPropagation(); void reassignOrphanedCue(cue); }}
                      className="text-[10px] text-blue-600 hover:text-blue-800 underline shrink-0"
                    >
                      定位到选区
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={e => { e.stopPropagation(); void deleteCue(cue); }}
                      className="text-[10px] text-red-400 hover:text-red-600 shrink-0"
                    >
                      删除
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Bottom bar: selected cue inspector (desktop only) ── */}
      {selectedCue && (() => {
        const canEdit = canEditCue(selectedCue);
        const commentCount = comments.filter(c => c.contextId === selectedCue.id).length;
        return (
          <div
            className="shrink-0 hidden sm:flex bg-[var(--surface)] border-t border-[var(--line)] px-4 py-2.5 items-center gap-3"
            onClick={e => e.stopPropagation()}
          >
            {selectedCue.warning && (
              <span className="text-[10px] text-amber-500 shrink-0">⚠ 位置可能已偏移</span>
            )}
            <span className="text-[10px] text-zinc-400 shrink-0">Q#</span>
            {canEdit ? (
              <InlineField value={selectedCue.number} onCommit={v => updateCueField(selectedCue, { number: v })}
                placeholder="编号" className="w-14 text-xs border border-zinc-200 rounded px-2 py-1 outline-none focus:border-zinc-400" />
            ) : (
              <span className="w-14 text-xs text-zinc-600 px-2 py-1">{selectedCue.number}</span>
            )}
            <span className="text-[10px] text-zinc-400 shrink-0">名称</span>
            {canEdit ? (
              <InlineField value={selectedCue.name} onCommit={v => updateCueField(selectedCue, { name: v })}
                placeholder="—" className="w-32 text-xs border border-zinc-200 rounded px-2 py-1 outline-none focus:border-zinc-400" />
            ) : (
              <span className="w-32 text-xs text-zinc-600 px-2 py-1">{selectedCue.name || "—"}</span>
            )}
            <span className="text-[10px] text-zinc-400 shrink-0">内容</span>
            {canEdit ? (
              <InlineField value={selectedCue.content} onCommit={v => updateCueField(selectedCue, { content: v })}
                placeholder="—" className="flex-1 text-xs border border-zinc-200 rounded px-2 py-1 outline-none focus:border-zinc-400" />
            ) : (
              <span className="flex-1 text-xs text-zinc-600 px-2 py-1">{selectedCue.content || "—"}</span>
            )}
            <span className="text-[10px] text-zinc-400 shrink-0">{isPointCue(selectedCue) ? "点" : "范围"}</span>
            <button
              onClick={() => setActiveCommentCueId(prev => prev ? null : selectedCue.id)}
              className={`text-xs shrink-0 transition-colors ${
                activeCommentCueId ? "text-blue-500 hover:text-blue-700" : commentCount > 0 ? "text-zinc-600 hover:text-zinc-800" : "text-zinc-400 hover:text-zinc-600"
              }`}
            >
              {commentCount > 0 ? `评论 (${commentCount})` : "评论"}
            </button>
            {canEdit && selectedCue.warning && (
              <button onClick={() => dismissWarning(selectedCue)} disabled={savingCueId === selectedCue.id}
                className="text-[10px] text-amber-500 hover:text-amber-700 underline shrink-0 disabled:opacity-50">
                清除警告
              </button>
            )}
            {canEdit && (
              <button onClick={() => deleteCue(selectedCue)}
                className="text-xs text-red-400 hover:text-red-600 transition-colors shrink-0">
                删除
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Mobile: Cue detail bottom sheet (opened via circle handle) ── */}
      {mobileChipSheetCueId !== null && (() => {
        const sheetCue = effectiveCues.find(c => c.id === mobileChipSheetCueId);
        if (!sheetCue) return null;
        const canEdit = canEditCue(sheetCue);
        const commentCount = comments.filter(c => c.contextId === sheetCue.id).length;
        const close = () => setMobileChipSheetCueId(null);
        return (
          <div className="sm:hidden fixed inset-0 z-50 flex items-end" onClick={close}>
            <div
              className="w-full rounded-t-2xl bg-[var(--surface)] border-t border-[var(--line)] shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-10 h-1 rounded-full bg-zinc-200" />
              </div>
              {sheetCue.warning && (
                <p className="px-5 py-1 text-xs text-amber-500">⚠ 位置可能已偏移</p>
              )}
              <div className="px-5 py-3 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-10 shrink-0">Q#</span>
                  {canEdit ? (
                    <InlineField value={sheetCue.number} onCommit={v => { updateCueField(sheetCue, { number: v }); }}
                      placeholder="编号" className="flex-1 text-sm border border-zinc-200 rounded px-3 py-2 outline-none focus:border-zinc-400" />
                  ) : (
                    <span className="flex-1 text-sm text-zinc-700">{sheetCue.number || "—"}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-10 shrink-0">名称</span>
                  {canEdit ? (
                    <InlineField value={sheetCue.name} onCommit={v => { updateCueField(sheetCue, { name: v }); }}
                      placeholder="—" className="flex-1 text-sm border border-zinc-200 rounded px-3 py-2 outline-none focus:border-zinc-400" />
                  ) : (
                    <span className="flex-1 text-sm text-zinc-700">{sheetCue.name || "—"}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-10 shrink-0">内容</span>
                  {canEdit ? (
                    <InlineField value={sheetCue.content} onCommit={v => { updateCueField(sheetCue, { content: v }); }}
                      placeholder="—" className="flex-1 text-sm border border-zinc-200 rounded px-3 py-2 outline-none focus:border-zinc-400" />
                  ) : (
                    <span className="flex-1 text-sm text-zinc-700">{sheetCue.content || "—"}</span>
                  )}
                </div>
              </div>
              <div className="border-t border-zinc-100 flex flex-col">
                <button
                  onClick={() => { setActiveCommentCueId(prev => prev === sheetCue.id ? null : sheetCue.id); close(); }}
                  className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-b border-zinc-100"
                >
                  {commentCount > 0 ? `评论（${commentCount}）` : "评论"}
                </button>
                {canEdit && sheetCue.warning && (
                  <button
                    onClick={() => { dismissWarning(sheetCue); close(); }}
                    disabled={savingCueId === sheetCue.id}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-amber-500 border-b border-zinc-100 disabled:opacity-50"
                  >
                    清除偏移警告
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => { deleteCue(sheetCue); close(); }}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-red-500"
                  >
                    删除此 Cue
                  </button>
                )}
              </div>
              <div className="h-6" />
            </div>
          </div>
        );
      })()}

      {/* ── Folded/mobile: floating insert Cue button (when pending selection) ── */}
      {cueTagsFolded && insertCueAvailable && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
          <button
            onClick={e => { e.stopPropagation(); insertCue(); }}
            className="pointer-events-auto rounded-full bg-zinc-800 px-6 py-3 text-sm font-medium text-white shadow-2xl hover:bg-zinc-900 flex items-center gap-2"
          >
            <span>＋</span>
            <span>插入 Cue</span>
          </button>
        </div>
      )}

      {showExport && (
        <ExportModal
          cueLists={cueLists}
          defaultSelectedIds={visibleListIds}
          productionId={productionId}
          onClose={() => setShowExport(false)}
        />
      )}

      {activeCommentCueId && (
        <CueCommentsPanel
          cueId={activeCommentCueId}
          logicalCueId={effectiveCues.find(c => c.id === activeCommentCueId)?.cueId ?? activeCommentCueId}
          productionId={productionId}
          comments={comments}
          currentUserId={myUserId}
          isAdmin={isAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentCueId(null)}
        />
      )}

      {/* ── Phase 4: Cue list access modal (Level 2-A) ───────────────────── */}
      {accessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { setAccessModal(null); }}>
          <div
            className="relative mx-4 w-full max-w-sm rounded-2xl bg-[var(--surface)] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {accessModal.status === "loading" && (
              <div className="flex flex-col items-center gap-4 py-4">
                <span className="text-2xl">⏳</span>
                <p className="text-sm text-zinc-500">正在检查权限…</p>
              </div>
            )}

            {accessModal.status === "can_self_confirm" && (
              <>
                <h2 className="mb-1 text-base font-semibold text-zinc-900">确认编辑访问</h2>
                <p className="mb-4 text-sm text-zinc-500">
                  你即将以部门成员身份编辑
                  <span className="font-medium text-zinc-800">「{accessModal.listName}」</span>
                  。确认后，系统将为你创建编辑授权记录。
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAccessModal(null)}
                    className="flex-1 rounded-xl border border-zinc-200 py-2.5 text-sm text-zinc-600 hover:bg-zinc-50"
                  >
                    取消
                  </button>
                  <button
                    disabled={accessModalConfirming}
                    onClick={async () => {
                      setAccessModalConfirming(true);
                      try {
                        if (await selfConfirmCueListAccess(productionId, accessModal.listId, accessModal.selfConfirmLevel)) {
                          setLocalEditableIds(prev => new Set([...prev, accessModal.listId]));
                          if (accessModal.selfConfirmLevel === "manage") {
                            setLocalManageIds(prev => new Set([...prev, accessModal.listId]));
                          }
                          setAccessModal(null);
                        }
                      } finally {
                        setAccessModalConfirming(false);
                      }
                    }}
                    className="flex-1 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {accessModalConfirming ? "确认中…" : "确认编辑"}
                  </button>
                </div>
              </>
            )}

            {accessModal.status === "needs_approval" && (
              <>
                <h2 className="mb-1 text-base font-semibold text-zinc-900">需要申请访问</h2>
                <p className="mb-4 text-sm text-zinc-500">
                  你没有
                  <span className="font-medium text-zinc-800">「{accessModal.listName}」</span>
                  的编辑权限。如需访问，请联系该 Cue 表的负责部门 POC 或制作人进行授权。
                </p>
                <p className="mb-4 text-xs text-zinc-400">
                  （审批流将在后续版本中支持。）
                </p>
                <button
                  onClick={() => setAccessModal(null)}
                  className="w-full rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
                >
                  知道了
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {shareModalListId && (
        <ShareModal
          productionId={productionId}
          cueListId={shareModalListId}
          cueListName={cueLists.find(cl => cl.id === shareModalListId)?.name ?? ""}
          onClose={() => setShareModalListId(null)}
        />
      )}
    </div>
  );
}
