"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import MountPointAssets from "@/components/assets/MountPointAssets";
import MarkerDeleteDialog, { type MarkerDeleteDialogState } from "@/components/script/MarkerDeleteDialog";
import ModeSwitch from "@/components/script/ModeSwitch";
import ScriptDialog, { SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS, SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS } from "@/components/script/ScriptDialog";
import TagGroupEditor from "@/components/script/TagGroupEditor";
import ProductionTopMenu, { ProductionOverflowSubmenuButton, ProductionTopMenuDivider, PRODUCTION_TOP_MENU_RIGHT_CLASS, useProductionToolbarStage } from "@/components/shell/ProductionTopMenu";
import ChevronIcon from "@/components/ui/ChevronIcon";
import Kbd from "@/components/ui/Kbd";
import { formatShortcut, useIsMacLike } from "@/components/ui/shortcut-label";
import { useDocumentVisible } from "@/hooks/useVisibleEventSource";
import { useAgentMutation } from "@/lib/agent/agent-mutations";
import { BASE_PATH } from "@/lib/base-path";
import { createSaveDebounce } from "@/lib/editor/save-debounce";
import type { TagGroup, BlockTagValue, SceneDetail } from "@/lib/db";
import { formatDuration, parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/ops/scene-duration";
import { isTextBlock, sameCharacters, shouldHideCharacterLabel, shouldShowCharacterGap, shouldShowSceneEndGap } from "@/lib/script/script-block-layout";
import { uid, makeBlock, makeMarkerBlock, isBlockEmptyForDelete, isEmptyTextBlock, mergeServerBlocks, expandLegacyMarkersToBlocks, normalizeScriptBlockStream, normalizeScriptMarkerInvariants, insertMarkerWithEmptyBlockIfNeeded, findTocSceneBlockIndex, findSceneMarkerBlockIndex, mergeDirtyRanges, markerChangeFromOperations } from "@/lib/script/script-block-stream";
import { sameDragTarget, resolveDragTarget, getDragInsertIndex, type DragTarget } from "@/lib/script/script-drag-target";
import { buildEmptyScriptCleanupRemovalPlan, isOnlyTextBlockInMarkerSegment, analyzeEmptyScriptCleanup, type EmptyScriptCleanupTarget } from "@/lib/script/script-empty-cleanup";
import { publishScriptFocus } from "@/lib/script/script-focus";
import { buildMarkerLabelIndex } from "@/lib/script/script-generated-labels";
import { hasScriptInsertionGapBefore, sceneParentIdMap } from "@/lib/script/script-insertion-gaps";
import { LARGE_SELECTION_BLOCK_THRESHOLD, largeSelectionOperationMessage, type LargeSelectionOperation, type PendingLargeSelectionConfirmation } from "@/lib/script/script-large-selection";
import { buildMarkerContextById, isMarkerBlock, withLegacyOwnershipProjection } from "@/lib/script/script-marker-blocks";
import { convertMarker, executeMarkerDeletion, getMarkerChange, insertMarker, markerCacheUpdateBlockIds, planMarkerDeletion, type BlockChange, type MarkerChange, type MarkerDeleteOperation } from "@/lib/script/script-marker-domain";
import { updateMarkerOwnership, type MarkerOwnershipDirty, type MarkerOwnershipRange } from "@/lib/script/script-marker-ownership-cache";
import { mdToHtml } from "@/lib/script/script-md";
import { diffState, type TagEntry } from "@/lib/script/script-ops";
import { updateEstimatedPageMap, type EstimatedPageMapCache } from "@/lib/script/script-page";
import { computeLyricFromTags, sceneDetailDeleteBlockedMessage, markerBlockDramaturgyDeleteBlockedKind, markerDetailFields, markerExpectedDuration, toSceneDetail, syncSceneDetailsWithScenes, sameSceneRows, type SceneMetaFields, type MarkerDetailDeleteBlockedKind, type NonEmptyDramaturgyMarker, type MarkerDetailField } from "@/lib/script/script-scene-details";
import { addSelectionRange, replaceSelectionItem, replaceSelectionRange, toggleSelectionItem, type SelectionState } from "@/lib/script/script-selection";
import { DEFAULT_SCRIPT_CONFIG, type Block, type BlockType, type Character, type Scene, type ScriptState, type ScriptConfig } from "@/lib/script/script-types";
import BlockGap from "./script-editor/BlockGap";
import CharacterPanel from "./script-editor/CharacterPanel";
import CommentsPanel from "./script-editor/CommentsPanel";
import InsertZone from "./script-editor/InsertZone";
import PresenceAvatar from "./script-editor/PresenceAvatar";
import ScenePanel from "./script-editor/ScenePanel";
import ScriptBlock from "./script-editor/ScriptBlock";
import ScriptMarkerRow, { type ScriptMarkerNode } from "./script-editor/ScriptMarkerRow";
import ScriptSceneDetailRail from "./script-editor/ScriptSceneDetailRail";
import ScriptToolbarMenuController, { type ScriptToolbarOpenMenu } from "./script-editor/ScriptToolbarMenuController";
import SideBlockPanel from "./script-editor/SideBlockPanel";
import TableOfContents from "./script-editor/TableOfContents";
import { EMPTY_COMMENTS, EMPTY_BLOCK_ASSETS, buildCommentBlockCaption, findSideBlockPanelNavigationTargets, type RemotePresence } from "./script-editor/comments";
import { SCRIPT_TOC_CENTER_EVENT, SCRIPT_EDITOR_MAX_WIDTH_PX, SCRIPT_BODY_HORIZONTAL_PADDING_REM, SCRIPT_PRODUCTION_SIDEBAR_FULL_WIDTH_PX, SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM, SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM, SCRIPT_TOC_RAIL_COMPACT_NUMBER_PADDING_REM, SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM, SCRIPT_SCENE_DETAIL_RAIL_MAX_WIDTH_PX, SCRIPT_SCENE_DETAIL_RAIL_RIGHT_INSET_PX, SCRIPT_SCENE_DETAIL_MODE_LABEL, SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX, DISABLED_CHECKBOX_OPTION_CLASS, checkboxOptionClass, COMMENT_BUBBLE_MIN_WIDTH_PX, COMMENT_BUBBLE_GAP_REM, SIDE_PANEL_FALLBACK_WIDTH_PX, SCRIPT_SHORTCUTS } from "./script-editor/constants";
import { readDisplayCookie, writeDisplayCookie, type DisplaySettings } from "./script-editor/display-settings";
import { useScriptSearch } from "./script-editor/use-script-search";
import { useDragCountBadge } from "./script-editor/use-drag-count-badge";
import { useReorderLock } from "./script-editor/use-reorder-lock";
import {
  fetchScriptState, loadScriptEnvelope, patchScript, putScriptConfig,
  fetchTagGroups, fetchBlockTags, fetchSceneDetails,
  createScene, renameScene, deleteScene, patchSceneMetadata,
} from "@/lib/script/script-client";
import { useScriptPresence } from "./script-editor/use-script-presence";
import { useBlockSidePanels } from "./script-editor/use-block-side-panels";
import {
  clampWindowRange as clampWindowRangePure,
  buildCumulativeHeights,
  blockAtOffset as blockAtOffsetPure,
  spacerHeightsFor,
  resolveActiveSceneIdForBlockIndex as resolveActiveSceneIdForBlockIndexPure,
  nextWindowRange,
} from "@/lib/script/script-virtual-window";
import { useCharacterFocus } from "./script-editor/use-character-focus";
import { useSceneDetailDialog } from "./script-editor/use-scene-detail-dialog";
import { useMobileBlockMenus } from "./script-editor/use-mobile-block-menus";
import { useDisplaySettings } from "./script-editor/use-display-settings";
import { useScriptToolbarFold } from "./script-editor/use-script-toolbar-fold";
import { useWorkspaceWidth } from "./script-editor/use-workspace-width";
import { setCursorAtStart, setCursorAtEnd, setCursorAtTextOffset, getEditableElementForRange, isTextEditingTarget, isFormEditingTarget, getTextLength } from "./script-editor/dom-cursor";
import { getScrollEl, getScrollMetrics, scrollContainerBy, scrollElementIntoView, estimateVirtualScrollAnchor, measureScriptTocNumberWidths, clearTimeoutMap, markProgrammaticScroll } from "./script-editor/dom-scroll";
import { replaceInlineStageDelimiters, toggleInlineTag, wrapSelectionAsInlineStageCue } from "./script-editor/inline-stage";
import { EDITABLE_MODE_VISIBLE_PRESENCE_AVATARS, REHEARSAL_MODE_VISIBLE_PRESENCE_AVATARS, presenceColor } from "./script-editor/presence";
import { flushSync } from "react-dom";

type PendingStageDelimiterChange = {
  open: string;
  close: string;
};

// 打印相关组件已抽到 components/print/ScriptPrint.tsx（#335）

// 自动同步（#520）：trailing 1.5s，但自第一次改动起最迟 5s 必落一笔——
// 连续打字不再无界不落库（丢数据窗口 / 协作延迟 / presence 先于内容到达）。
const SYNC_DEBOUNCE_MS = 1500;
const SYNC_MAX_WAIT_MS = 5000;

const REHEARSAL_SWITCH_OPTICAL_OFFSET_STYLE: React.CSSProperties = { position: "relative", left: "3%" };

// ─── ScriptEditor ─────────────────────────────────────────────────────────────

export default function ScriptEditor({
  scriptId = "default",
  productionId,
  productionName,
  canEditText: canEditTextProp = true,
  canEditMetadata: canEditMetadataProp = true,
  canEditLayout = true,
  canEditRehearsalMark = true,
  canImport = false,
  initialSearchQuery,
}: {
  scriptId?: string;
  productionId?: string;
  productionName?: string;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  /** 剧本排版（页面类型 / 紧凑排版 / 模版）的门：script_view/<主本>@edit——与
   *  app/api/script/[id]/config 的版式字段判定同一把钥匙。canEditMetadata 是
   *  「任一 scene 字段可改」的粗门，不能拿来当排版开关的依据。 */
  canEditLayout?: boolean;
  canEditRehearsalMark?: boolean;
  canImport?: boolean;
  initialSearchQuery?: string;
}) {
  const toolbarStage = useProductionToolbarStage();
  const effectiveScriptId = productionId ?? scriptId;

  // ── Version state ─────────────────────────────────────────────────────────────
  // 版本退役 Phase B：版本恒为 head（服务端解析活跃版本），无选择、无状态门。
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);

  const baseCanEditText = canEditTextProp;
  const baseCanEditMetadata = canEditMetadataProp;
  const baseCanEditTextLayout = canEditLayout;
  const baseCanEdit = baseCanEditText || baseCanEditMetadata || canEditRehearsalMark;
  const [manualLockedMode, setManualLockedMode] = useState(() => readDisplayCookie().rehearsalMode);
  const isLockedMode = !baseCanEdit || manualLockedMode;
  const canEditText = baseCanEditText && !isLockedMode;
  const canEditMetadata = baseCanEditMetadata && !isLockedMode;
  const effectiveCanEditRehearsalMark = canEditRehearsalMark && !isLockedMode;

  const canEdit = canEditText || canEditMetadata || effectiveCanEditRehearsalMark;
  const [characters, setCharacters] = useState<Character[]>([]);
  const {
    focusedCharacterIds, pendingAggregateFocusPrompt,
    toggleCharacterFocus, clearCharacterFocus,
    confirmAggregateFocusPrompt, addAllAggregateFocusPrompt, cancelAggregateFocusPrompt, togglePendingAggregateFocus,
  } = useCharacterFocus({ effectiveScriptId, characters });
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneDetails, setSceneDetails] = useState<SceneDetail[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([makeBlock()]);
  const [rehearsalLabels, setRehearsalLabels] = useState(() => buildMarkerLabelIndex(blocks));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [isScriptDragging, setIsScriptDragging] = useState(false);
  const [selectionChangeNotice, setSelectionChangeNotice] = useState("");
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(() => new Set());
  const {
    mobileBlockMenuBlockId, setMobileBlockMenuBlockId,
    mobileInsertMenuOpen, setMobileInsertMenuOpen,
    mobileBatchAction, setMobileBatchAction,
    closeMobileBlockMenu,
  } = useMobileBlockMenus();
  const { sceneDetailDialogSceneId, sceneDetailDialogEditing, setSceneDetailDialogEditing, openSceneDetailDialog, closeSceneDetailDialog } = useSceneDetailDialog();
  const [mobileDeleteConfirmation, setMobileDeleteConfirmation] = useState<
    | { kind: "marker"; markerId: string; message: string }
    | { kind: "blocks"; blockIds: string[]; message: string; blocked: boolean }
    | null
  >(null);
  const selectedDetailBlockId = selectedBlockIds.size === 1
    ? selectedBlockIds.values().next().value as string | undefined
    : undefined;
  // AI 信封的剧本 focus 上下文（lib/script/script-focus.ts → AgentPopout chip）：
  // 多选 > 光标 > 视野顶部块（纯浏览兜底——用户没点任何块时也要能感知"正在看哪"）。
  // 只发指针（块 id），正文由 AI 用读工具自取。
  const [viewportBlockId, setViewportBlockId] = useState<string | null>(null);
  const viewportBlockIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedBlockIds.size > 0) {
      publishScriptFocus({ kind: "selection", blockIds: Array.from(selectedBlockIds).slice(0, 5), total: selectedBlockIds.size });
    } else if (focusedId) {
      publishScriptFocus({ kind: "caret", blockIds: [focusedId], total: 1 });
    } else if (viewportBlockId) {
      publishScriptFocus({ kind: "viewport", blockIds: [viewportBlockId], total: 1 });
    } else {
      publishScriptFocus(null);
    }
  }, [selectedBlockIds, focusedId, viewportBlockId]);
  useEffect(() => () => publishScriptFocus(null), []);
  const selectionAnchorBlockIdRef = useRef<string | null>(null);
  const selectionDetachedRef = useRef(false);
  const markerEndedScopeIdsRef = useRef<Set<string>>(new Set());
  const [invalidSelectionEndIds, setInvalidSelectionEndIds] = useState<Set<string>>(() => new Set());
  const [shiftKeyDown, setShiftKeyDown] = useState(false);
  const [recentlyMovedBlockIds, setRecentlyMovedBlockIds] = useState<Set<string>>(() => new Set());
  const [tocHighlightedMarkerIds, setTocHighlightedMarkerIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmationRequest, setDeleteConfirmationRequest] = useState<{ anchorId: string; token: number } | null>(null);
  const [deleteConfirmingBlockIds, setDeleteConfirmingBlockIds] = useState<Set<string>>(() => new Set());
  const [markerDeleteConfirmBlockId, setMarkerDeleteConfirmBlockId] = useState<string | null>(null);
  const [markerDeleteDialog, setMarkerDeleteDialog] = useState<(MarkerDeleteDialogState & { source: "local" | "server" }) | null>(null);
  const [markerDeleteDialogBusy, setMarkerDeleteDialogBusy] = useState(false);
  const [dismissActionToken, setDismissActionToken] = useState(0);
  const [pendingLargeSelectionConfirmation, setPendingLargeSelectionConfirmation] =
    useState<PendingLargeSelectionConfirmation | null>(null);
  const [markerDetailDeleteBlockedKind, setMarkerDetailDeleteBlockedKind] =
    useState<MarkerDetailDeleteBlockedKind | null>(null);
  const [pendingNonEmptyMarkerSelectionDeleteIds, setPendingNonEmptyMarkerSelectionDeleteIds] =
    useState<string[] | null>(null);
  const [selectedNonEmptyMarkerDeleteIds, setSelectedNonEmptyMarkerDeleteIds] =
    useState<Set<string>>(() => new Set());
  const [expandedNonEmptyMarkerDetailIds, setExpandedNonEmptyMarkerDetailIds] =
    useState<Set<string>>(() => new Set());
  const [pendingEmptyScriptCleanup, setPendingEmptyScriptCleanup] =
    useState<EmptyScriptCleanupTarget[] | null>(null);
  const [selectedEmptyScriptCleanupKeys, setSelectedEmptyScriptCleanupKeys] =
    useState<Set<string>>(() => new Set());
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollLockedRef = useRef(true);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const activeSceneIdRef = useRef<string | null>(null);
  const [detailBlockVisibility, setDetailBlockVisibility] = useState({ selected: false, focused: false });
  const [charEditTokens, setCharEditTokens] = useState<Record<string, number>>({});

  // ── Block tags ───────────────────────────────────────────────────────────────
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [blockTagMap, setBlockTagMap] = useState<Map<string, BlockTagValue[]>>(new Map());
  const blockTagMapRef = useRef<Map<string, BlockTagValue[]>>(new Map());
  const tagClipboardRef = useRef<BlockTagValue[] | null>(null);

  // ── Script config (page layout, stage delimiters) ─────────────────────────
  const [scriptConfig, setScriptConfig] = useState<ScriptConfig>(DEFAULT_SCRIPT_CONFIG);
  const canAddRehearsalMark = effectiveCanEditRehearsalMark && scriptConfig.useRehearsalMarks;
  const scriptConfigRef = useRef(scriptConfig);
  useEffect(() => { scriptConfigRef.current = scriptConfig; }, [scriptConfig]);
  const syncOpeningChapterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (syncOpeningChapterTimerRef.current) clearTimeout(syncOpeningChapterTimerRef.current); }, []);
  const [aboutOpen, setAboutOpen] = useState(false);
  const isMac = useIsMacLike(); // 「关于 · 快捷键」表格按平台显示 ⌘ / Ctrl（#542）
  const [pendingLockedMode, setPendingLockedMode] = useState<boolean | null>(null);
  const pendingModeScrollAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const [pendingStageDelimiterChange, setPendingStageDelimiterChange] =
    useState<PendingStageDelimiterChange | null>(null);
  const toolbarOpenMenuRef = useRef<ScriptToolbarOpenMenu>(null);
  const toolbarMenuCloseRef = useRef<() => void>(() => {});
  const closeToolbarMenu = useCallback(() => toolbarMenuCloseRef.current(), []);

  // config PUT 的门是 scene 的 meta/name@edit（app/api/script/[id]/config），
  // 与 baseCanEditTextLayout 同源；用粗门 baseCanEditMetadata 会让只有别的
  // scene 字段权限的人白写一次再被 403。
  const saveScriptConfig = useCallback(async (patch: Partial<ScriptConfig>) => {
    if (!baseCanEditTextLayout) return;
    const previous = scriptConfigRef.current;
    const next = { ...previous, ...patch };
    scriptConfigRef.current = next;
    setScriptConfig(next);
    const ok = await putScriptConfig(effectiveScriptId, activeVersionId, next);
    if (!ok && scriptConfigRef.current === next) {
      scriptConfigRef.current = previous;
      setScriptConfig(previous);
    }
  }, [activeVersionId, baseCanEditTextLayout, effectiveScriptId]);

  const syncOpeningChapterMarkerId = useCallback((nextBlocks: Block[]) => {
    if (!baseCanEditTextLayout) return;
    const openingChapterMarkerId = nextBlocks.find((block) => block.type === "chapter_marker")?.id ?? null;
    if (openingChapterMarkerId === scriptConfigRef.current.openingChapterMarkerId) return;
    const next = { ...scriptConfigRef.current, openingChapterMarkerId };
    scriptConfigRef.current = next;
    setScriptConfig(next);
    // Debounce: rapid chapter reordering collapses into a single PUT using the
    // latest ref value, preventing out-of-order stale writes.
    if (syncOpeningChapterTimerRef.current) clearTimeout(syncOpeningChapterTimerRef.current);
    syncOpeningChapterTimerRef.current = setTimeout(() => {
      syncOpeningChapterTimerRef.current = null;
      void putScriptConfig(effectiveScriptId, activeVersionId, scriptConfigRef.current);
    }, 500);
  }, [activeVersionId, baseCanEditTextLayout, effectiveScriptId]);

  const requestStageDelimiterChange = useCallback((open: string, close: string) => {
    if (scriptConfig.stageDelimOpen === open && scriptConfig.stageDelimClose === close) {
      closeToolbarMenu();
      return;
    }
    setPendingStageDelimiterChange({ open, close });
    closeToolbarMenu();
  }, [closeToolbarMenu, scriptConfig.stageDelimOpen, scriptConfig.stageDelimClose]);

  // ── Page map (computed client-side, deterministic) ──────────────────────────
  const ownershipDirtyRef = useRef<MarkerOwnershipDirty>("full");
  const pageMapCacheRef = useRef<EstimatedPageMapCache | null>(null);
  const pageMapDirtyRef = useRef<MarkerOwnershipDirty>("full");
  const markPageMapDirty = useCallback((dirty: Exclude<MarkerOwnershipDirty, null>) => {
    pageMapDirtyRef.current = mergeDirtyRanges(pageMapDirtyRef.current, dirty);
  }, []);
  const markOwnershipDirty = useCallback((dirty: Exclude<MarkerOwnershipDirty, null>) => {
    ownershipDirtyRef.current = mergeDirtyRanges(ownershipDirtyRef.current, dirty);
    markPageMapDirty(dirty);
  }, [markPageMapDirty]);
  const markBlockStructureDirty = useCallback((previous: Block[], next: Block[], movedBlockIds?: Iterable<string>) => {
    const change = getMarkerChange(previous, next, movedBlockIds);
    if (change.positions.length === 0) return;
    if (change.markerStructureChanged) setRehearsalLabels(buildMarkerLabelIndex(next));
    markPageMapDirty(change.positions.map((start) => ({ start, end: start + 1 })));
    const nextIndexById = new Map(next.map((block, index) => [block.id, index]));
    const ownershipRanges = markerCacheUpdateBlockIds(next, change).flatMap((id): MarkerOwnershipRange[] => {
      const start = nextIndexById.get(id);
      return start === undefined ? [] : [{ start, end: start + 1, throughNextMarker: false }];
    });
    if (ownershipRanges.length > 0) markOwnershipDirty(ownershipRanges);
  }, [markOwnershipDirty, markPageMapDirty]);
  const ownedBlocks = useMemo(() => {
    const owned = updateMarkerOwnership(blocks, ownershipDirtyRef.current);
    ownershipDirtyRef.current = null;
    return owned;
  }, [blocks]);
  const markerContextById = useMemo(() => buildMarkerContextById(ownedBlocks), [ownedBlocks]);
  const legacyProjectedBlocks = useMemo(
    () => withLegacyOwnershipProjection(ownedBlocks, markerContextById),
    [markerContextById, ownedBlocks],
  );
  const openingChapterState = useMemo(() => {
    const openingChapterMarkerId = scriptConfig.openingChapterMarkerId;
    const markerIndex = openingChapterMarkerId
      ? blocks.findIndex((block) => block.id === openingChapterMarkerId)
      : -1;
    const marker = markerIndex >= 0 ? blocks[markerIndex] : null;
    let mustBeVisible = false;
    for (let index = markerIndex + 1; markerIndex >= 0 && index < blocks.length; index++) {
      const block = blocks[index];
      if (block.type === "chapter_marker") break;
      if (block.type === "scene_marker" || block.type === "rehearsal_marker") {
        mustBeVisible = true;
        break;
      }
    }
    return {
      mustBeVisible,
      sceneId: marker?.type === "chapter_marker" ? marker.sceneId : null,
    };
  }, [blocks, scriptConfig.openingChapterMarkerId]);
  const openingChapterSceneId = openingChapterState.sceneId;
  const openingChapterMustBeVisible = openingChapterState.mustBeVisible;
  const openingChapterVisible = scriptConfig.showOpeningChapter || openingChapterMustBeVisible;
  const tocScenes = useMemo(
    () => openingChapterVisible
      ? scenes
      : scenes.filter((scene) => scene.id !== openingChapterSceneId),
    [openingChapterSceneId, openingChapterVisible, scenes]
  );
  const pageMap = useMemo(() => {
    const cache = updateEstimatedPageMap(
      pageMapCacheRef.current,
      ownedBlocks,
      scriptConfig.pageLayout,
      scriptConfig.textLayoutMode,
      true,
      pageMapDirtyRef.current,
      // 模版必须传：服务端 page_map（saveEstimatedPageMaps/getEstimatedPageMap）
      // 按主本模版几何算页，这里漏传就退回 legacy 模版——配了模版的演出会出现
      // 屏上页码与 AI/搜索页码整页级分叉（52 vs 57 事故）
      scriptConfig.templateId ?? null,
    );
    pageMapCacheRef.current = cache;
    pageMapDirtyRef.current = null;
    return cache.pageMap;
  }, [ownedBlocks, scriptConfig.pageLayout, scriptConfig.textLayoutMode, scriptConfig.templateId]);
  const reloadScriptState = useCallback(async () => {
    const serverState = await fetchScriptState(effectiveScriptId, activeVersionId);
    if (!serverState) throw new Error("Failed to reload script state");
    const expandedBlocks = expandLegacyMarkersToBlocks(serverState.blocks, serverState.scenes);
    const normalized = normalizeScriptMarkerInvariants(expandedBlocks, serverState.scenes, serverState.config ?? DEFAULT_SCRIPT_CONFIG);
    markOwnershipDirty("full");
    setRehearsalLabels(buildMarkerLabelIndex(normalized.blocks));
    setBlocks(normalized.blocks);
    setCharacters(serverState.characters);
    setScenes(normalized.scenes);
    setScriptConfig(normalized.config);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
    syncedStateRef.current = { ...serverState, blocks: normalized.blocks, scenes: normalized.scenes, config: normalized.config };
  }, [activeVersionId, effectiveScriptId, markOwnershipDirty]);
  // AI 写剧本（scope "script" 的 mutation 信号）落库后整体重载——最粗但最稳的粒度：
  // reloadScriptState 会重置 syncedStateRef，编辑器后续 diff 以新服务端状态为基准，
  // 不会把 AI 的改动当作"本地被删的内容"再冲掉。
  useAgentMutation({ scope: "script", productionId: productionId ?? undefined }, () => {
    void reloadScriptState().catch((err) => console.error("[script-editor] AI 写入后重载失败:", err));
  });
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const sceneParentIdById = useMemo(() => sceneParentIdMap(scenes), [scenes]);
  const sceneDetailById = useMemo(() => new Map(sceneDetails.map((scene) => [scene.id, scene])), [sceneDetails]);
  const firstRehearsalMarkerLabel = useMemo(() => {
    const markerId = rehearsalLabels.rehearsalLabelByMarkerId.keys().next().value;
    if (!markerId) return null;
    return rehearsalLabels.labelByMarkerId.get(markerId)
      ?? "（未命名）";
  }, [rehearsalLabels]);
  const rehearsalMarksCannotBeDisabled = scriptConfig.useRehearsalMarks && firstRehearsalMarkerLabel !== null;
  const scriptLineNumberByBlockId = useMemo(() => {
    const map = new Map<string, number>();
    let lineNumber = 0;
    for (const block of blocks) {
      if (!isTextBlock(block)) continue;
      lineNumber += 1;
      map.set(block.id, lineNumber);
    }
    return map;
  }, [blocks]);
  const maxLineIndexText = String(Math.max(1, scriptLineNumberByBlockId.size));
  const applyBlockStructureEdit = useCallback((previousBlocks: Block[], nextBlocks: Block[], change: MarkerChange | "full") => {
    const normalized = normalizeScriptMarkerInvariants(
      nextBlocks,
      scenes,
      scriptConfigRef.current,
      change === "full" ? undefined : change,
    );
    if (change === "full") {
      setRehearsalLabels(buildMarkerLabelIndex(normalized.blocks));
      markOwnershipDirty("full");
    }
    else markBlockStructureDirty(previousBlocks, normalized.blocks);
    setBlocks(normalized.blocks);
    if (!sameSceneRows(normalized.scenes, scenes)) {
      setScenes(normalized.scenes);
      setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
    }
    if (normalized.config.openingChapterMarkerId !== scriptConfigRef.current.openingChapterMarkerId) {
      syncOpeningChapterMarkerId(normalized.blocks);
    }
  }, [markBlockStructureDirty, markOwnershipDirty, scenes, syncOpeningChapterMarkerId]);

  const {
    display, setDisplay, toggleDisplay,
    lineIndexMeasureRef, lineIndexMinMeasureRef, lineIndexWidthStyle, markerLineIndexWidthStyle,
  } = useDisplaySettings({ maxLineIndexText });

  const {
    isReorderLocked, reorderNotice, isReorderLockedRef, reorderUnlockFrame, reorderNoticeTimer,
    lockReorder, unlockReorder, unlockReorderAfterCommit, showReorderNotice,
  } = useReorderLock({ blocks });

  const {
    clientId, userName, setUserName, presenceMap, setPresenceMap,
    presenceCountRef, presenceTimerRef, presenceLayoutTimerRef, sendPresence,
  } = useScriptPresence({ effectiveScriptId, activeVersionId });
  const {
    setComments, blockAssetsByBlockId, loadBlockAssetBubbles, commentsByBlockId,
    activeCommentBlockId, setActiveCommentBlockId, activeAssetBlockId, setActiveAssetBlockId,
    tagEditorOpen, setTagEditorOpen, tagEditorOnTop, setTagEditorOnTop,
    commentDraftsRef, updateCommentDraft, openBlockSidePanel,
  } = useBlockSidePanels({ productionId });

  const prepareForNavigation = useCallback(() => {
    navigatingAwayRef.current = true;
    if (windowRangeFrameRef.current !== null) {
      cancelAnimationFrame(windowRangeFrameRef.current);
      windowRangeFrameRef.current = null;
    }
    pendingWindowRangeRef.current = null;
    if (reorderUnlockFrame.current !== null) {
      cancelAnimationFrame(reorderUnlockFrame.current);
      reorderUnlockFrame.current = null;
    }
    if (reorderNoticeTimer.current !== null) {
      clearTimeout(reorderNoticeTimer.current);
      reorderNoticeTimer.current = null;
    }
    if (selectionChangeNoticeTimer.current !== null) {
      clearTimeout(selectionChangeNoticeTimer.current);
      selectionChangeNoticeTimer.current = null;
    }
    if (programmaticScrollFrameRef.current !== null) {
      cancelAnimationFrame(programmaticScrollFrameRef.current);
      programmaticScrollFrameRef.current = null;
    }
    suppressProgrammaticScrollRef.current = false;
    clearTimeoutMap(movedHighlightTimersRef.current);
    clearTimeoutMap(tocMarkerGlowTimersRef.current);
    if (presenceTimerRef.current !== null) {
      clearTimeout(presenceTimerRef.current);
      presenceTimerRef.current = null;
    }
    if (presenceLayoutTimerRef.current !== null) {
      clearTimeout(presenceLayoutTimerRef.current);
      presenceLayoutTimerRef.current = null;
    }
    if (streamDebounceTimerRef.current !== null) {
      clearTimeout(streamDebounceTimerRef.current);
      streamDebounceTimerRef.current = null;
    }
    if (eventSourceRef.current !== null) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    pendingNavigateRef.current = null;
    postNavCorrectionRef.current = null;
    pendingMoveCenterRef.current = null;
  }, [reorderNoticeTimer, reorderUnlockFrame, presenceLayoutTimerRef, presenceTimerRef]);

  const taRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFocus = useRef<{ id: string; textOffset?: number; atEnd?: boolean } | null>(null);
  const pendingCharOpen = useRef<string | null>(null);
  const draggingBlockId = useRef<string | null>(null);
  const draggingBlockIds = useRef<string[]>([]);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragInvalidReasonRef = useRef<string | null>(null);
  const dropHandledRef = useRef(false);
  const windowRangeFrameRef = useRef<number | null>(null);
  const pendingMoveCenterRef = useRef<string | null>(null);
  const selectionChangeNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedHighlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const tocMarkerGlowTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const suppressProgrammaticScrollRef = useRef(false);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const navigatingAwayRef = useRef(false);
  const { toolbarCompact, toolbarShort, presenceFolded, setToolbarElement, setToolbarMeasureTick, resetToolbarMeasurement } = useScriptToolbarFold({
    toolbarStage, navigatingAwayRef, toolbarOpenMenuRef, closeToolbarMenu, activeVersionId, isLockedMode, canEditMetadata,
  });
  const blocksRef = useRef(blocks);
  const ownedBlocksRef = useRef(ownedBlocks);
  const scenesRef = useRef(scenes);
  const charactersRef = useRef(characters);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  const sceneIdSetRef = useRef<Set<string>>(new Set(scenes.map((scene) => scene.id)));
  const blockIndexByIdRef = useRef<Map<string, number>>(new Map(blocks.map((block, index) => [block.id, index])));
  const clampWindowRange = useCallback((range: { start: number; end: number }, blockCount = blocksRef.current.length) => (
    clampWindowRangePure(range, blockCount)
  ), []);
  useLayoutEffect(() => {
    blocksRef.current = blocks;
    blockIndexByIdRef.current = new Map(blocks.map((block, index) => [block.id, index]));
  }, [blocks]);
  useLayoutEffect(() => { ownedBlocksRef.current = ownedBlocks; }, [ownedBlocks]);
  useLayoutEffect(() => {
    scenesRef.current = scenes;
    sceneIdSetRef.current = new Set(scenes.map((scene) => scene.id));
  }, [scenes]);
  useEffect(() => { blockTagMapRef.current = blockTagMap; }, [blockTagMap]);
  const markBlockPageMapDirty = useCallback((id: string) => {
    const idx = blockIndexByIdRef.current.get(id);
    if (idx !== undefined) markPageMapDirty({ start: idx, end: idx + 1 });
  }, [markPageMapDirty]);
  const markBlockIdsPageMapDirty = useCallback((ids: Set<string>) => {
    markPageMapDirty(Array.from(ids, (id) => {
      const index = blockIndexByIdRef.current.get(id);
      return index === undefined ? null : { start: index, end: index + 1 };
    }).filter((range): range is MarkerOwnershipRange => range !== null));
  }, [markPageMapDirty]);
  useEffect(() => () => {
    if (reorderUnlockFrame.current !== null) cancelAnimationFrame(reorderUnlockFrame.current);
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    pendingWindowRangeRef.current = null;
    if (programmaticScrollFrameRef.current !== null) cancelAnimationFrame(programmaticScrollFrameRef.current);
    if (reorderNoticeTimer.current !== null) clearTimeout(reorderNoticeTimer.current);
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    clearTimeoutMap(movedHighlightTimersRef.current);
    clearTimeoutMap(tocMarkerGlowTimersRef.current);
  }, [reorderNoticeTimer, reorderUnlockFrame]);

  const blocksContainerRef = useRef<HTMLDivElement>(null);
  const { dragCountBadgeRef, dragButtonDownSeenRef, dragButtonReleasedRef, clearDragCountBadge, updateDragCountBadge } = useDragCountBadge({ blocksContainerRef });
  const setScriptDragging = useCallback((dragging: boolean) => {
    setIsScriptDragging((current) => current === dragging ? current : dragging);
  }, []);

  const resetScriptInteractions = useCallback(() => {
    selectionAnchorBlockIdRef.current = null;
    selectionDetachedRef.current = false;
    markerEndedScopeIdsRef.current = new Set();
    pendingFocus.current = null;
    pendingCharOpen.current = null;
    draggingBlockId.current = null;
    draggingBlockIds.current = [];
    dragTargetRef.current = null;
    dragInvalidReasonRef.current = null;
    dropHandledRef.current = false;
    setSelectedBlockIds((current) => current.size === 0 ? current : new Set());
    setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setDeleteConfirmationRequest(null);
    setMarkerDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
    setDragTarget(null);
    setIsScriptDragging(false);
    clearDragCountBadge();
    window.getSelection()?.removeAllRanges();
  }, [clearDragCountBadge]);

  const toggleLockedMode = useCallback(() => {
    setPendingLockedMode(!manualLockedMode);
    closeToolbarMenu();
  }, [closeToolbarMenu, manualLockedMode]);

  const confirmLockedModeChange = useCallback(() => {
    if (pendingLockedMode === null) return;
    const container = blocksContainerRef.current;
    if (container) {
      const { viewTop, viewBottom } = getScrollMetrics();
      const visibleBlock = Array.from(container.querySelectorAll<HTMLElement>("[data-vitem]"))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.bottom > viewTop && rect.top < viewBottom;
        });
      const id = visibleBlock?.dataset.vitem;
      pendingModeScrollAnchorRef.current = id
        ? { id, top: visibleBlock.getBoundingClientRect().top }
        : null;
    }
    resetScriptInteractions();
    closeToolbarMenu();
    setManualLockedMode(pendingLockedMode);
    setDisplay(prev => {
      const next = { ...prev, rehearsalMode: pendingLockedMode };
      writeDisplayCookie(next);
      return next;
    });
    setPendingLockedMode(null);
  }, [closeToolbarMenu, pendingLockedMode, resetScriptInteractions, setDisplay]);

  const showSelectionChangeNotice = useCallback((message: string) => {
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    setSelectionChangeNotice(message);
    selectionChangeNoticeTimer.current = setTimeout(() => {
      selectionChangeNoticeTimer.current = null;
      setSelectionChangeNotice("");
    }, 1800);
  }, []);

  const commitBlockSelection = useCallback((next: SelectionState) => {
    markerEndedScopeIdsRef.current = next.markerEndIds;
    setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
    setSelectedBlockIds(next.selectedIds);
    if (next.selectedIds.size === 0) {
      selectionAnchorBlockIdRef.current = null;
      selectionDetachedRef.current = false;
    }
  }, []);

  const clearBlockSelection = useCallback(() => {
    markerEndedScopeIdsRef.current = new Set();
    setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
    setSelectedBlockIds((current) => current.size === 0 ? current : new Set());
    selectionAnchorBlockIdRef.current = null;
    selectionDetachedRef.current = false;
  }, []);

  const canPerformSelectedBlockAction = useCallback((ids: string[]) => {
    if (ids.length <= 1 || markerEndedScopeIdsRef.current.size === 0) {
      setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
      return true;
    }
    setInvalidSelectionEndIds(new Set(markerEndedScopeIdsRef.current));
    showSelectionChangeNotice("每个选中范围的最后一行必须是剧本行。");
    return false;
  }, [showSelectionChangeNotice]);

  const requestLargeSelectionOperation = useCallback((
    operation: LargeSelectionOperation,
    count: number,
    onConfirm: () => void,
    onCancel?: () => void
  ) => {
    if (count <= LARGE_SELECTION_BLOCK_THRESHOLD) {
      onConfirm();
      return;
    }
    setPendingLargeSelectionConfirmation({ operation, count, onConfirm, onCancel });
  }, []);

  const glowChangedBlocks = useCallback((ids: string[]) => {
    const nextIds = ids.filter(Boolean);
    if (nextIds.length === 0) return;
    const idsToStart = nextIds.filter((id) => !movedHighlightTimersRef.current.has(id));
    if (idsToStart.length === 0) return;
    setRecentlyMovedBlockIds((current) => {
      const next = new Set(current);
      idsToStart.forEach((id) => next.add(id));
      return next;
    });
    idsToStart.forEach((id) => {
      const timer = setTimeout(() => {
        movedHighlightTimersRef.current.delete(id);
        setRecentlyMovedBlockIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, 1000);
      movedHighlightTimersRef.current.set(id, timer);
    });
  }, []);

  const glowTocMarker = useCallback((id: string) => {
    if (tocMarkerGlowTimersRef.current.has(id)) return;
    setTocHighlightedMarkerIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    const timer = setTimeout(() => {
      tocMarkerGlowTimersRef.current.delete(id);
      setTocHighlightedMarkerIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 1500);
    tocMarkerGlowTimersRef.current.set(id, timer);
  }, []);

  const clearEditorFocusForDrag = useCallback(() => {
    focusedIdRef.current = null;
    setFocusedId(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-bwrap]")) active.blur();
    window.getSelection()?.removeAllRanges();
  }, []);

  // ── Virtual scroll ────────────────────────────────────────────────────────────
  const VSCROLL_BUFFER = 120;
  const DEFAULT_BLOCK_H = 80;
  const INITIAL_WINDOW_SIZE = 240;
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const botSpacerRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const measuredHeightTotalRef = useRef(0);
  const cumulativeHRef = useRef<number[]>([0]); // indexed 0..blocks.length
  const [windowRange, setWindowRange] = useState(() => ({ start: 0, end: Math.min(INITIAL_WINDOW_SIZE, blocks.length) }));
  const windowRangeRef = useRef(windowRange);
  useLayoutEffect(() => { windowRangeRef.current = windowRange; }, [windowRange]);
  const pendingWindowRangeRef = useRef<{ start: number; end: number } | null>(null);
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });
  const pendingVirtualScrollAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const pendingVirtualWindowRefreshRef = useRef(false);
  // Pending navigation: set before windowRange update, consumed by useLayoutEffect after DOM commit
  const pendingNavigateRef = useRef<
    { kind: 'block'; id: string; align: ScrollLogicalPosition; viewportTopRatio?: number } | { kind: 'scene'; id: string } | null
  >(null);
  // After the initial estimated scroll, store the target for a precise correction after measurement
  const postNavCorrectionRef = useRef<
    { kind: 'block'; id: string; align: ScrollLogicalPosition; viewportTopRatio?: number } | { kind: 'scene'; id: string } | null
  >(null);
  // Incremented by the measurement effect to trigger the correction layout effect
  const [correctionTick, setCorrectionTick] = useState(0);

  const captureVirtualScrollAnchor = useCallback((): { id: string; top: number } | null => {
    const container = blocksContainerRef.current;
    if (!container) return null;
    const { viewTop, viewBottom } = getScrollMetrics();
    const anchorLine = Math.max(viewTop, Math.min(viewBottom - 1, viewTop + SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX));
    let fallback: { id: string; top: number } | null = null;
    for (const el of container.querySelectorAll<HTMLElement>("[data-vitem]")) {
      const id = el.dataset.vitem;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < viewTop) continue;
      if (rect.top > viewBottom) break;
      fallback ??= { id, top: rect.top };
      if (rect.bottom >= anchorLine) return { id, top: rect.top };
    }
    return fallback;
  }, []);

  const restoreVirtualScrollAnchor = useCallback((anchor: { id: string; top: number } | null) => {
    if (!anchor) return;
    const container = blocksContainerRef.current;
    if (!container) return;
    let target: HTMLElement | null = null;
    for (const el of container.querySelectorAll<HTMLElement>("[data-vitem]")) {
      if (el.dataset.vitem === anchor.id) {
        target = el;
        break;
      }
    }
    if (!target) return;
    const delta = target.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 0.5) return;
    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    scrollContainerBy({ top: delta, behavior: "instant" });
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingModeScrollAnchorRef.current;
    if (!anchor) return;
    pendingModeScrollAnchorRef.current = null;
    restoreVirtualScrollAnchor(anchor);
  }, [isLockedMode, scriptConfig.textLayoutMode, restoreVirtualScrollAnchor]);

  const requestVirtualWindowRefresh = useCallback(() => {
    pendingVirtualScrollAnchorRef.current = captureVirtualScrollAnchor();
    pendingVirtualWindowRefreshRef.current = true;
  }, [captureVirtualScrollAnchor]);

  const applyWindowRange = useCallback((next: { start: number; end: number }, sync = false, preserveAnchor = false, flushCommit = false) => {
    const targetRange = clampWindowRange(next);
    const pending = pendingWindowRangeRef.current;
    const current = pending ?? windowRangeRef.current;
    if (current.start === targetRange.start && current.end === targetRange.end) return;
    if (preserveAnchor) {
      // 视口里一个已渲染块都没有（快速滚动冲进 spacer 空白区）时抓不到 DOM 锚，
      // 退回按估算累计表合成的锚——否则视口上方缓冲区的估算误差会整体位移（#508）。
      const container = blocksContainerRef.current;
      pendingVirtualScrollAnchorRef.current = captureVirtualScrollAnchor()
        ?? (container ? estimateVirtualScrollAnchor(container, blocksRef.current, cumulativeHRef.current) : null);
    }
    pendingWindowRangeRef.current = targetRange;
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    const commit = () => {
      windowRangeFrameRef.current = null;
      const target = pendingWindowRangeRef.current ? clampWindowRange(pendingWindowRangeRef.current) : null;
      pendingWindowRangeRef.current = null;
      if (!target) return;
      setWindowRange((currentRange) => {
        if (currentRange.start === target.start && currentRange.end === target.end) {
          windowRangeRef.current = currentRange;
          return currentRange;
        }
        windowRangeRef.current = target;
        return target;
      });
    };
    if (sync) {
      if (flushCommit) {
        queueMicrotask(() => {
          if (navigatingAwayRef.current) return;
          if (pendingWindowRangeRef.current !== targetRange) return;
          flushSync(commit);
        });
      }
      else commit();
    }
    else windowRangeFrameRef.current = requestAnimationFrame(commit);
  }, [captureVirtualScrollAnchor, clampWindowRange]);

  // Rebuild cumulative heights from cache
  const rebuildCumulative = useCallback(() => {
    cumulativeHRef.current = buildCumulativeHeights(
      ownedBlocksRef.current,
      measuredHeightsRef.current,
      measuredHeightTotalRef.current,
      openingChapterVisible ? null : scriptConfigRef.current.openingChapterMarkerId,
      DEFAULT_BLOCK_H,
    );
  }, [openingChapterVisible]);
  const syncSpacerHeights = useCallback((range: { start: number; end: number }, anchor: { id: string; top: number } | null = null) => {
    const { top, bot } = spacerHeightsFor(cumulativeHRef.current, range, blocksRef.current.length, DEFAULT_BLOCK_H);
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${top}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${bot}px`;
    if (anchor) restoreVirtualScrollAnchor(anchor);
    const next = { top, bot };
    setSpacerH((prev) => prev.top === top && prev.bot === bot ? prev : next);
  }, [restoreVirtualScrollAnchor]);
  useEffect(() => {
    rebuildCumulative();
    syncSpacerHeights(windowRangeRef.current);
  }, [openingChapterVisible, rebuildCumulative, syncSpacerHeights]);

  // Binary search: first block index whose top >= offset
  const blockAtOffset = useCallback((offset: number) => blockAtOffsetPure(cumulativeHRef.current, offset), []);

  const getBlockScrollElement = useCallback((blockId: string) => (
    document.getElementById(`block-content-${blockId}`) ?? document.getElementById(`block-${blockId}`)
  ), []);

  const resolveActiveSceneIdForBlockIndex = useCallback((index: number): string | null => (
    resolveActiveSceneIdForBlockIndexPure(blocksRef.current, ownedBlocksRef.current, sceneIdSetRef.current, index, VSCROLL_BUFFER)
  ), []);

  const updateActiveSceneFromScroll = useCallback(() => {
    const container = blocksContainerRef.current;
    const bl = blocksRef.current;
    if (!container || bl.length === 0) {
      if (activeSceneIdRef.current !== null) {
        activeSceneIdRef.current = null;
        setActiveSceneId(null);
        return true;
      }
      return false;
    }

    const { viewTop } = getScrollMetrics();
    const anchorY = viewTop + SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX;
    let idx = -1;
    let previousIdx = -1;
    for (const el of container.querySelectorAll<HTMLElement>("[data-bwrap]")) {
      const id = el.dataset.bwrap;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      const blockIdx = blockIndexByIdRef.current.get(id) ?? -1;
      if (blockIdx < 0) continue;

      if (rect.bottom > anchorY) {
        idx = blockIdx;
        break;
      }

      previousIdx = blockIdx;
    }

    if (idx < 0 && previousIdx >= 0) idx = previousIdx;

    if (idx < 0) {
      idx = blockAtOffset(Math.max(0, anchorY - container.getBoundingClientRect().top));
    }

    // 视野顶部块顺手发布给 AI focus 通道（滚动已有 rAF 节流；ref 比对免于每帧 setState）
    const viewportId = idx >= 0 ? bl[idx]?.id ?? null : null;
    if (viewportBlockIdRef.current !== viewportId) {
      viewportBlockIdRef.current = viewportId;
      setViewportBlockId(viewportId);
    }

    const nextSceneId = resolveActiveSceneIdForBlockIndex(idx) ?? activeSceneIdRef.current;
    if (nextSceneId !== activeSceneIdRef.current) {
      activeSceneIdRef.current = nextSceneId;
      setActiveSceneId(nextSceneId);
      return true;
    }
    return false;
  }, [blockAtOffset, resolveActiveSceneIdForBlockIndex]);

  const recomputeWindow = useCallback(() => {
    if (navigatingAwayRef.current) return false;
    if (draggingBlockId.current || isReorderLockedRef.current) return false;
    const container = blocksContainerRef.current;
    const bl = blocksRef.current;
    if (!container || bl.length === 0) return false;

    const { viewTop, viewBottom, clientHeight } = getScrollMetrics();
    let firstVisibleIdx = -1;
    let lastVisibleIdx = -1;
    for (const el of container.querySelectorAll<HTMLElement>("[data-vitem]")) {
      const id = el.dataset.vitem;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < viewTop) continue;
      if (rect.top > viewBottom) break;
      const idx = blockIndexByIdRef.current.get(id) ?? -1;
      if (idx < 0) continue;
      if (firstVisibleIdx < 0) firstVisibleIdx = idx;
      lastVisibleIdx = idx;
    }

    if (firstVisibleIdx < 0 || lastVisibleIdx < 0) {
      const viewStart = Math.max(0, viewTop - container.getBoundingClientRect().top);
      const viewEnd = viewStart + clientHeight;
      firstVisibleIdx = blockAtOffset(viewStart);
      lastVisibleIdx = blockAtOffset(viewEnd);
    }

    const fi = focusedIdRef.current ? blockIndexByIdRef.current.get(focusedIdRef.current) ?? -1 : -1;
    const pfi = pendingFocus.current ? blockIndexByIdRef.current.get(pendingFocus.current.id) ?? -1 : -1;
    const next = nextWindowRange(windowRangeRef.current, firstVisibleIdx, lastVisibleIdx, bl.length, VSCROLL_BUFFER, [fi, pfi]);
    if (!next) {
      return updateActiveSceneFromScroll();
    }

    applyWindowRange(next, true, true, true);
    return updateActiveSceneFromScroll();
  }, [applyWindowRange, blockAtOffset, updateActiveSceneFromScroll, isReorderLockedRef]);

  type LoadState = "loading" | "ready" | "not-found" | "error";
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string>("");

  // Keep scrollLockedRef in sync
  useEffect(() => { scrollLockedRef.current = scrollLocked; }, [scrollLocked]);

  // Block user scroll (wheel, touch, arrow keys) while scroll is locked
  useEffect(() => {
    if (!scrollLocked) return;
    const prevent = (e: Event) => e.preventDefault();
    const preventKeys = (e: Event) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes((e as globalThis.KeyboardEvent).key)) e.preventDefault();
    };
    window.addEventListener('wheel', prevent, { passive: false });
    window.addEventListener('touchmove', prevent, { passive: false });
    window.addEventListener('keydown', preventKeys);
    return () => {
      window.removeEventListener('wheel', prevent);
      window.removeEventListener('touchmove', prevent);
      window.removeEventListener('keydown', preventKeys);
    };
  }, [scrollLocked]);

  // Always-fresh scroll-position saver — reads DOM directly to avoid stale estimates
  const saveScrollPosRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveScrollPosRef.current = () => {
      if (loadState !== "ready" || !productionId) return;
      const container = blocksContainerRef.current;
      if (!container) return;
      let savedId: string | null = null;
      const { viewTop: saveViewTop } = getScrollMetrics();
      for (const el of container.querySelectorAll<HTMLElement>("[data-bwrap]")) {
        if (el.getBoundingClientRect().top <= saveViewTop) savedId = el.dataset.bwrap ?? null;
        else break;
      }
      if (savedId) {
        const idx = blockIndexByIdRef.current.get(savedId) ?? 0;
        document.cookie = `script_pos_${productionId}=${encodeURIComponent(`${savedId}:${idx}`)}; path=/; max-age=31536000; SameSite=Lax`;
      }
    };
  });

  // Scroll listener + debounced position save
  useEffect(() => {
    let rafId = 0;
    let didCenterForScrollGesture = false;
    let scrollGestureTimer: ReturnType<typeof setTimeout> | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelPendingCorrectionForUserScroll = () => {
      if (suppressProgrammaticScrollRef.current) return;
      postNavCorrectionRef.current = null;
      pendingNavigateRef.current = null;
      setScrollLocked(false);
    };
    const onScroll = () => {
      if (navigatingAwayRef.current) return;
      if (suppressProgrammaticScrollRef.current) return;
      cancelAnimationFrame(rafId);
      const shouldRecenterToc = !didCenterForScrollGesture;
      didCenterForScrollGesture = true;
      clearTimeout(scrollGestureTimer);
      scrollGestureTimer = setTimeout(() => {
        didCenterForScrollGesture = false;
      }, 350);
      rafId = requestAnimationFrame(() => {
        const activeSceneChanged = recomputeWindow();
        if (shouldRecenterToc || activeSceneChanged) window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
      });
      if (!scrollLockedRef.current) {
        postNavCorrectionRef.current = null;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveScrollPosRef.current(), 400);
      }
    };
    const scrollEl = getScrollEl();
    window.addEventListener('wheel', cancelPendingCorrectionForUserScroll, { passive: true });
    window.addEventListener('touchmove', cancelPendingCorrectionForUserScroll, { passive: true });
    window.addEventListener('keydown', cancelPendingCorrectionForUserScroll);
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    recomputeWindow();
    updateActiveSceneFromScroll();
    return () => {
      window.removeEventListener('wheel', cancelPendingCorrectionForUserScroll);
      window.removeEventListener('touchmove', cancelPendingCorrectionForUserScroll);
      window.removeEventListener('keydown', cancelPendingCorrectionForUserScroll);
      scrollEl.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
      clearTimeout(scrollGestureTimer);
      clearTimeout(saveTimer);
    };
  }, [recomputeWindow, updateActiveSceneFromScroll]);

  useEffect(() => {
    updateActiveSceneFromScroll();
  }, [blocks.length, updateActiveSceneFromScroll]);

  useLayoutEffect(() => {
    const bl = blocksRef.current;
    const current = windowRangeRef.current;
    const measured = measuredHeightsRef.current;
    if (measured.size > 0) {
      const liveIds = new Set(bl.map((block) => block.id));
      let total = 0;
      let changed = false;
      measured.forEach((height, id) => {
        if (liveIds.has(id)) total += height;
        else {
          measured.delete(id);
          changed = true;
        }
      });
      if (changed) measuredHeightTotalRef.current = total;
    }
    if (bl.length === 0) {
      applyWindowRange({ start: 0, end: 0 }, true);
      return;
    }
    let start = Math.min(current.start, Math.max(0, bl.length - 1));
    let end = Math.min(Math.max(current.end, start + 1), bl.length);
    const pendingFocusId = pendingFocus.current?.id ?? pendingCharOpen.current;
    const pendingFocusIdx = pendingFocusId ? blockIndexByIdRef.current.get(pendingFocusId) ?? -1 : -1;
    if (pendingFocusIdx >= 0) {
      start = Math.min(start, pendingFocusIdx);
      end = Math.max(end, pendingFocusIdx + 1);
    }
    applyWindowRange({ start, end }, true, true);
  }, [blocks.length, applyWindowRange]);

  const measureVirtualItemElements = useCallback((elements: Iterable<HTMLElement>) => {
    let changed = false;
    for (const el of elements) {
      const id = el.dataset.vitem;
      if (!id) continue;
      const h = el.offsetHeight;
      const prevH = measuredHeightsRef.current.get(id);
      if (h > 0 && prevH !== h) {
        measuredHeightsRef.current.set(id, h);
        measuredHeightTotalRef.current += h - (prevH ?? 0);
        changed = true;
      }
    }
    if (changed) {
      rebuildCumulative();
      const anchor = pendingMoveCenterRef.current === null ? captureVirtualScrollAnchor() : null;
      syncSpacerHeights(windowRangeRef.current, anchor);
      // If there's a pending navigation correction, trigger the layout effect that will re-scroll
      if (postNavCorrectionRef.current) {
        setCorrectionTick(t => t + 1);
      }
    }
  }, [captureVirtualScrollAnchor, rebuildCumulative, syncSpacerHeights]);

  // Measure rendered block heights after each render pass
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const container = blocksContainerRef.current;
    if (!container) return;
    measureVirtualItemElements(container.querySelectorAll<HTMLElement>('[data-vitem]'));
  }, [blocks.length, scriptConfig.textLayoutMode, windowRange.start, windowRange.end, measureVirtualItemElements]);

  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    if (!pendingVirtualWindowRefreshRef.current) return;
    pendingVirtualWindowRefreshRef.current = false;
    rebuildCumulative();
    const anchor = pendingVirtualScrollAnchorRef.current;
    if (anchor) {
      const anchorIdx = blockIndexByIdRef.current.get(anchor.id) ?? -1;
      const currentRange = windowRangeRef.current;
      if (anchorIdx >= 0 && (anchorIdx < currentRange.start || anchorIdx >= currentRange.end)) {
        const windowSize = Math.min(INITIAL_WINDOW_SIZE, blocksRef.current.length);
        let start = Math.max(0, anchorIdx - Math.floor(windowSize / 2));
        const end = Math.min(blocksRef.current.length, start + windowSize);
        start = Math.max(0, end - windowSize);
        applyWindowRange({ start, end }, true, false, true);
        return;
      }
    }
    const container = blocksContainerRef.current;
    if (container) {
      measureVirtualItemElements(container.querySelectorAll<HTMLElement>("[data-vitem]"));
    }
    pendingVirtualScrollAnchorRef.current = null;
    syncSpacerHeights(windowRangeRef.current, anchor);
    updateActiveSceneFromScroll();
  }, [blocks, applyWindowRange, measureVirtualItemElements, rebuildCumulative, syncSpacerHeights, updateActiveSceneFromScroll]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const container = blocksContainerRef.current;
    if (!container) return;
    let frame = 0;
    const pendingEntries = new Set<HTMLElement>();
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const target = entry.target;
        if (target instanceof HTMLElement && target.hasAttribute("data-vitem")) {
          pendingEntries.add(target);
        }
      });
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const elements = Array.from(pendingEntries);
        pendingEntries.clear();
        measureVirtualItemElements(elements);
      });
    });
    container.querySelectorAll<HTMLElement>("[data-vitem]").forEach((el) => observer.observe(el));
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [blocks.length, windowRange.start, windowRange.end, measureVirtualItemElements]);

  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const centerTarget = pendingMoveCenterRef.current;
    if (centerTarget === null) return;
    pendingVirtualScrollAnchorRef.current = null;
    postNavCorrectionRef.current = null;
    if (blocks.length === 0) {
      pendingMoveCenterRef.current = null;
      return;
    }
    const currentTargetIndex = blockIndexByIdRef.current.get(centerTarget);
    if (currentTargetIndex === undefined) {
      pendingMoveCenterRef.current = null;
      return;
    }
    const windowSize = Math.min(INITIAL_WINDOW_SIZE, blocks.length);
    const centerIdx = Math.max(0, Math.min(blocks.length - 1, currentTargetIndex));
    let start = Math.max(0, centerIdx - Math.floor(windowSize / 2));
    const end = Math.min(blocks.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    pendingMoveCenterRef.current = null;
    const nextRange = { start, end };
    const currentRange = windowRangeRef.current;
    const rangeChanged = currentRange.start !== nextRange.start || currentRange.end !== nextRange.end;
    pendingNavigateRef.current = { kind: "block", id: centerTarget, align: "center" };
    applyWindowRange(nextRange, true, false, true);
    if (!rangeChanged) {
      const el = document.getElementById(`block-${centerTarget}`);
      const scrollEl = getBlockScrollElement(centerTarget);
      if (scrollEl || el) {
        pendingNavigateRef.current = null;
        rebuildCumulative();
        syncSpacerHeights(windowRangeRef.current);
        markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
        (scrollEl ?? el)?.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
  }, [blocks, applyWindowRange, getBlockScrollElement, rebuildCumulative, syncSpacerHeights]);

  // 窗口 commit 后：先把 spacer 对齐新窗口，再把 commit 前抓的锚点块拉回原位。
  // 顺序不能反——spacer 一变，锚点块就跟着位移；先恢复锚点再改 spacer 等于白恢复。
  // 测量 effect 只在窗口里有没量过的块时才顺手同步 spacer（带锚）；窗口里全是量过的块
  // （窗口触底后每滚一格平移一块、或来回滚过的区段）就只靠这里——之前这一步在锚点恢复
  // 之后无锚执行，表现为每格回弹一块高、快速上滚回弹一两幕（#508）。
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    syncSpacerHeights(windowRange);
    const anchor = pendingVirtualScrollAnchorRef.current;
    if (!anchor) return;
    pendingVirtualScrollAnchorRef.current = null;
    restoreVirtualScrollAnchor(anchor);
  }, [windowRange, blocks.length, spacerH.top, spacerH.bot, syncSpacerHeights, restoreVirtualScrollAnchor]);

  // Precise correction pass: fires after newly-rendered blocks are measured (before next paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    if (correctionTick === 0) return;
    const nav = postNavCorrectionRef.current;
    if (!nav) return;
    postNavCorrectionRef.current = null;
    const el = nav.kind === 'block'
      ? getBlockScrollElement(nav.id)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    // Measurements are now fresh — rebuild and re-correct spacers before scrollIntoView
    rebuildCumulative();
    syncSpacerHeights(windowRange);
    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    scrollElementIntoView(el, nav.kind === 'block' ? nav.align : 'center', nav.kind === 'block' ? nav.viewportTopRatio : undefined);
    setScrollLocked(false);
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  // windowRange is intentionally in deps — ensures this captures the post-recomputeWindow value;
  // postNavCorrectionRef going null after the first correction prevents repeated firing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange, getBlockScrollElement, syncSpacerHeights, updateActiveSceneFromScroll]);

  // After each window-changing render, execute any pending navigation (fires before paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const nav = pendingNavigateRef.current;
    if (!nav) return;
    const el = nav.kind === 'block'
      ? getBlockScrollElement(nav.id)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    pendingNavigateRef.current = null;

    rebuildCumulative();
    syncSpacerHeights(windowRange);

    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    scrollElementIntoView(el, nav.kind === 'block' ? nav.align : 'center', nav.kind === 'block' ? nav.viewportTopRatio : undefined);

    // Newly-rendered blocks haven't been measured yet so the cumulative heights are estimated.
    // Store the target so the measurement effect can trigger a precise correction pass.
    postNavCorrectionRef.current = nav;
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  }, [windowRange, rebuildCumulative, getBlockScrollElement, syncSpacerHeights, updateActiveSceneFromScroll]);

  // Teleport to a block: load target window, then instant-jump in the layout effect.
  const scrollToBlockIdx = useCallback((
    idx: number,
    align: ScrollLogicalPosition = 'center',
    viewportTopRatio?: number,
  ) => {
    if (idx < 0 || idx >= blocksRef.current.length) return;
    const block = blocksRef.current[idx];
    pendingNavigateRef.current = { kind: 'block', id: block.id, align, viewportTopRatio };
    const windowSize = Math.min(INITIAL_WINDOW_SIZE, blocksRef.current.length);
    let start = Math.max(0, idx - Math.floor(windowSize / 2));
    const end = Math.min(blocksRef.current.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    const nextRange = { start, end };
    const currentRange = windowRangeRef.current;
    const rangeChanged = currentRange.start !== nextRange.start || currentRange.end !== nextRange.end;
    applyWindowRange(nextRange, true, false, true);
    if (!rangeChanged) {
      const el = getBlockScrollElement(block.id);
      if (!el) return;
      pendingNavigateRef.current = null;
      markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
      scrollElementIntoView(el, align, viewportTopRatio);
      requestAnimationFrame(() => {
        updateActiveSceneFromScroll();
        window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
      });
    }
  }, [applyWindowRange, getBlockScrollElement, updateActiveSceneFromScroll]);

  const openMobileBlockMenu = useCallback((blockId: string, blockIndex: number) => {
    setMobileBatchAction(null);
    setMobileInsertMenuOpen(false);
    scrollToBlockIdx(blockIndex, "start", 0.2);
    setMobileBlockMenuBlockId(blockId);
  }, [scrollToBlockIdx, setMobileBatchAction, setMobileBlockMenuBlockId, setMobileInsertMenuOpen]);

  const scrollToScene = useCallback((sceneId: string) => {
    const markerIdx = findSceneMarkerBlockIndex(sceneId, blocksRef.current);
    if (markerIdx >= 0) glowTocMarker(blocksRef.current[markerIdx].id);
    activeSceneIdRef.current = sceneId;
    setActiveSceneId(sceneId);
    const idx = markerIdx >= 0
      ? markerIdx
      : findTocSceneBlockIndex(sceneId, scenesRef.current, ownedBlocksRef.current);
    if (idx >= 0) {
      scrollToBlockIdx(idx, "start");
      return;
    }
    const existing = document.getElementById(`scene-block-${sceneId}`);
    if (existing) {
      markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
      existing.scrollIntoView({ behavior: 'instant', block: 'start' });
      requestAnimationFrame(() => window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT)));
      return;
    }
    showReorderNotice("跳转失败：该章节或段落没有对应剧本块。");
  }, [glowTocMarker, scrollToBlockIdx, showReorderNotice]);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);

  const readBlockInViewport = useCallback((blockId: string | null | undefined): boolean => {
    if (!blockId || typeof window === "undefined") return false;
    const el = document.getElementById(`block-${blockId}`);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const { viewTop: rvt, viewBottom: rvb } = getScrollMetrics();
    return rect.bottom > rvt && rect.top < rvb;
  }, []);

  useEffect(() => {
    const update = () => {
      const next = {
        selected: readBlockInViewport(selectedDetailBlockId),
        focused: readBlockInViewport(focusedId),
      };
      setDetailBlockVisibility((current) => (
        current.selected === next.selected && current.focused === next.focused ? current : next
      ));
    };
    update();
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(update);
    const observedIds = new Set([selectedDetailBlockId, focusedId].filter(Boolean));
    for (const blockId of observedIds) {
      const el = document.getElementById(`block-${blockId}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [focusedId, readBlockInViewport, selectedDetailBlockId, windowRange.start, windowRange.end]);

  // ── Server sync ─────────────────────────────────────────────────────────────

  const syncedStateRef = useRef<ScriptState | null>(null);
  // Mirrors the tag state that was last successfully pushed to the server.
  // Used to diff tag changes and embed them in block ops.
  const syncedBlockTagMapRef = useRef<Map<string, BlockTagValue[]>>(new Map());
  // Tags registered by inheritTags() that must be included in the NEXT insert op
  // for the corresponding blockId.  Written synchronously from the event handler;
  // consumed by pushPatchRef when the insert op is found.
  const pendingTagInsertsRef = useRef<Map<string, TagEntry[]>>(new Map());
  const clientSeqRef = useRef(0);
  const serverSeqRef = useRef(0);
  const isSyncingRef = useRef(false);
  const syncIdleWaitersRef = useRef<Array<() => void>>([]);
  // 计时器到期时上一笔还在飞：记下来，飞完重排一轮（不能丢——停手前最后一段
  // 输入若恰好撞锁，没有下一个击键就再也不落库）。
  const deferredSyncRef = useRef(false);
  // 卸载时若上一笔还在飞，它的 finally 不能再重排（会在卸载后 arm 计时器）
  const syncUnmountedRef = useRef(false);
  const pendingMovedBlockIdsRef = useRef<Set<string>>(new Set());

  // Stable ref to the push function so the debounce closure never goes stale.
  const pushPatchRef = useRef<(curr: ScriptState) => void>(() => {});
  const [syncDebounce] = useState(() => createSaveDebounce(() => {
    const curr: ScriptState = {
      config: scriptConfigRef.current,
      blocks: normalizeScriptBlockStream(blocksRef.current),
      characters: charactersRef.current,
      scenes: scenesRef.current,
    };
    pushPatchRef.current(curr);
  }, { wait: SYNC_DEBOUNCE_MS, maxWait: SYNC_MAX_WAIT_MS }));

  useEffect(() => {
    pushPatchRef.current = async (curr: ScriptState) => {
      if (!canEdit || loadState !== "ready" || syncedStateRef.current === null) return;
      if (isSyncingRef.current) { deferredSyncRef.current = true; return; }
      isSyncingRef.current = true;
      try {
        const seq = ++clientSeqRef.current;
        const patch = diffState(syncedStateRef.current, curr, seq);
        const movedIdsForPatch = [...pendingMovedBlockIdsRef.current];
        if (movedIdsForPatch.length > 0) {
          const reorder = patch.blockOps.find((op) => op.op === "reorder");
          if (reorder?.op === "reorder") reorder.movedIds = movedIdsForPatch;
        }

        // ── Step 1: pending tag inserts (from inheritTags) ───────────────────────
        // These are written synchronously into pendingTagInsertsRef when a new block
        // is created via Enter.  Consume them first so the insert op always carries
        // the inherited tags, regardless of useEffect / blockTagMapRef timing.
        if (pendingTagInsertsRef.current.size > 0) {
          for (const [blockId, tags] of pendingTagInsertsRef.current) {
            const insertOp = patch.blockOps.find(
              o => o.op === 'insert' && (o as { block: { id: string } }).block.id === blockId
            );
            if (insertOp) {
              (insertOp as { tags?: TagEntry[] }).tags = tags;
              pendingTagInsertsRef.current.delete(blockId); // consumed
            }
            // If no insert op yet (shouldn't happen), leave for the diff pass below.
          }
        }

        // ── Step 2: tag diff — embed all other tag changes into block ops ─────────
        // blockTagMapRef.current is kept in sync with blockTagMap state via useEffect.
        const currTagMap = blockTagMapRef.current;
        const syncedTagMap = syncedBlockTagMapRef.current;
        const deletedBlockIds = new Set(
          patch.blockOps.filter(o => o.op === 'delete').map(o => (o as { id: string }).id)
        );

        const changedTagBlockIds: string[] = [];
        for (const [blockId, tags] of currTagMap) {
          if (deletedBlockIds.has(blockId)) continue;
          const syncedTags = syncedTagMap.get(blockId) ?? [];
          if (JSON.stringify(tags) !== JSON.stringify(syncedTags)) changedTagBlockIds.push(blockId);
        }
        for (const blockId of syncedTagMap.keys()) {
          if (!currTagMap.has(blockId) && !deletedBlockIds.has(blockId))
            changedTagBlockIds.push(blockId);
        }

        if (changedTagBlockIds.length > 0) {
          for (const blockId of changedTagBlockIds) {
            const tags: TagEntry[] = (currTagMap.get(blockId) ?? []).map(t => ({
              groupId: t.groupId, optionId: t.optionId, value: t.value,
            }));
            const insertOp = patch.blockOps.find(o => o.op === 'insert' && (o as { block: { id: string } }).block.id === blockId);
            const updateOp = patch.blockOps.find(o => o.op === 'update' && (o as { block: { id: string } }).block.id === blockId);
            if (insertOp && 'block' in insertOp) {
              (insertOp as { tags?: TagEntry[] }).tags = tags; // may already be set by step 1
            } else if (updateOp && 'block' in updateOp) {
              (updateOp as { tags?: TagEntry[] }).tags = tags;
            } else {
              // Tag-only change: synthesise a minimal update op so tags reach the server.
              const block = curr.blocks.find(b => b.id === blockId);
              if (block) patch.blockOps.push({ op: 'update', block, tags });
            }
          }
        }
        // ── End tag handling ─────────────────────────────────────────────────────

        if (!patch.blockOps.length && !patch.charOps.length && !patch.sceneOps.length) {
          for (const id of movedIdsForPatch) pendingMovedBlockIdsRef.current.delete(id);
          return;
        }
        const body = await patchScript(effectiveScriptId, activeVersionId, patch);
        if (body) {
          serverSeqRef.current = body.serverSeq;
          syncedStateRef.current = curr;
          // Advance the synced tag baseline so the next diff starts fresh.
          syncedBlockTagMapRef.current = new Map(currTagMap);
          // Any pending inserts that were consumed above are already deleted;
          // clear whatever might remain (orphaned entries for blocks that were
          // deleted before the sync fired).
          pendingTagInsertsRef.current.clear();
          for (const id of movedIdsForPatch) pendingMovedBlockIdsRef.current.delete(id);
        }
      } catch {
        // Sync failure is non-fatal — will retry on next state change.
      } finally {
        isSyncingRef.current = false;
        const waiters = syncIdleWaitersRef.current;
        syncIdleWaitersRef.current = [];
        for (const resolve of waiters) resolve();
        if (deferredSyncRef.current) {
          deferredSyncRef.current = false;
          if (!syncUnmountedRef.current) syncDebounce.trigger();
        }
      }
    };
  }, [effectiveScriptId, activeVersionId, canEdit, loadState, syncDebounce]);

  useEffect(() => {
    setLoadState("loading");
    setLoadError("");
    const placeholderBlock = makeBlock();
    measuredHeightsRef.current.clear();
    measuredHeightTotalRef.current = 0;
    cumulativeHRef.current = [0, DEFAULT_BLOCK_H];
    markOwnershipDirty("full");
    setRehearsalLabels(buildMarkerLabelIndex([placeholderBlock]));
    setBlocks([placeholderBlock]);
    applyWindowRange({ start: 0, end: 1 }, true);
    setCharacters([]);
    setScenes([]);
    setSceneDetails([]);
    syncedStateRef.current = null;
    pendingMovedBlockIdsRef.current.clear();

    let cancelled = false;
    const load = async () => {
      try {
        const r = await loadScriptEnvelope(productionId, effectiveScriptId, activeVersionId);
        // Production route returns { state, versionId, ... }; script route returns ScriptState directly.
        type ProdResponse = { state: ScriptState; versionId: string };
        type ErrResponse = { error?: string };
        const body = r.body as ProdResponse | ScriptState | ErrResponse;
        if (cancelled) return;
        if (r.status === 404) { setLoadState("not-found"); return; }
        if (!r.ok) { setLoadError((body as ErrResponse).error ?? "加载失败"); setLoadState("error"); return; }

        const isProdResponse = productionId && "state" in body;
        const state: ScriptState = isProdResponse
          ? (body as ProdResponse).state
          : (body as ScriptState);

        if (state.blocks.length > 0) {
          const expandedBlocks = expandLegacyMarkersToBlocks(state.blocks, state.scenes);
          const normalized = normalizeScriptMarkerInvariants(expandedBlocks, state.scenes, { ...DEFAULT_SCRIPT_CONFIG, ...(state.config ?? {}) });
          const initialWindowEnd = Math.min(INITIAL_WINDOW_SIZE, normalized.blocks.length);
          measuredHeightsRef.current.clear();
          measuredHeightTotalRef.current = 0;
          cumulativeHRef.current = new Array(normalized.blocks.length + 1);
          cumulativeHRef.current[0] = 0;
          for (let i = 0; i < normalized.blocks.length; i++) {
            cumulativeHRef.current[i + 1] = cumulativeHRef.current[i] + DEFAULT_BLOCK_H;
          }
          markOwnershipDirty("full");
          setRehearsalLabels(buildMarkerLabelIndex(normalized.blocks));
          blocksRef.current = normalized.blocks;
          blockIndexByIdRef.current = new Map(normalized.blocks.map((block, index) => [block.id, index]));
          applyWindowRange({ start: 0, end: initialWindowEnd }, true);
          syncSpacerHeights({ start: 0, end: initialWindowEnd });
          setBlocks(normalized.blocks);
          setCharacters(state.characters);
          setScenes(normalized.scenes);
          setScriptConfig(normalized.config);
          setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
          syncedStateRef.current = { ...state, blocks: normalized.blocks, scenes: normalized.scenes, config: normalized.config };
        }
        if (state.config && state.blocks.length === 0) setScriptConfig({ ...DEFAULT_SCRIPT_CONFIG, ...state.config });

        // Capture version info from production route response
        if (isProdResponse) {
          const { versionId: respVid } = body as ProdResponse;
          const resolvedVid = respVid ?? activeVersionId;
          if (resolvedVid) setActiveVersionId(resolvedVid);
        }

        setLoadState("ready");

        // Load tag groups and block tags in parallel (non-blocking)
        if (productionId) {
          Promise.all([
            fetchTagGroups(productionId),
            fetchBlockTags(effectiveScriptId),
          ]).then(([tgData, btData]) => {
            if (tgData?.groups) setTagGroups(tgData.groups as TagGroup[]);
            if (btData?.tags) {
              const map = new Map<string, BlockTagValue[]>();
              for (const tag of btData.tags as BlockTagValue[]) {
                if (!map.has(tag.blockId)) map.set(tag.blockId, []);
                map.get(tag.blockId)!.push(tag);
              }
              setBlockTagMap(map);
              // Initialise the synced baseline so we don't re-send tags that
              // are already on the server after the first load.
              syncedBlockTagMapRef.current = new Map(map);
            }
          }).catch(() => {});
        }
      } catch {
        if (!cancelled) {
          setLoadError("网络错误，请稍后重试");
          setLoadState("error");
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [effectiveScriptId, productionId, activeVersionId, applyWindowRange, markOwnershipDirty, syncSpacerHeights]);

  useEffect(() => {
    if (!productionId || !activeVersionId || loadState !== "ready") return;
    let cancelled = false;
    fetchSceneDetails(productionId, activeVersionId).then((data) => {
      if (cancelled || !data) return;
      setSceneDetails(syncSceneDetailsWithScenes(data, scenesRef.current));
    });
    return () => { cancelled = true; };
  }, [productionId, activeVersionId, loadState]);

  // ── Presence 与块侧栏 hook 在上面（prepareForNavigation 之前）调用；SSE 订阅在下面接线 ──

  const eventSourceRef = useRef<EventSource | null>(null);
  const streamDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 后台标签不占同源连接名额（#467）——门控抽成了共享 hook，cue / wiki / 场景表
  // 同款接入；本组件的建连被下面的 leader 选举包着，所以只用可见性这一层。
  const streamVisible = useDocumentVisible();

  // ── Hash-based deep link + position restore ──────────────────────────────────
  useEffect(() => {
    if (loadState !== "ready") return;
    // Fallback: unlock scroll 300ms after ready; correction useLayoutEffect unlocks earlier.
    const unlockTimer = setTimeout(() => setScrollLocked(false), 300);
    const hash = window.location.hash;
    if (hash.startsWith("#block-")) {
      const [fragment, query] = hash.slice(1).split("?");
      const blockId = fragment.slice("block-".length);
      const idx = blocksRef.current.findIndex(b => b.id === blockId);
      if (idx >= 0) { scrollToBlockIdx(idx, "center"); setHighlightedBlockId(blockId); }
      if (new URLSearchParams(query).get("open_comment") === "true") {
        setActiveCommentBlockId(blockId);
        setTagEditorOnTop(false);
      }
      return () => clearTimeout(unlockTimer);
    }
    // Restore last scroll position from cookie
    if (productionId) {
      const cookieKey = `script_pos_${productionId}`;
      const raw = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith(cookieKey + "="))?.slice(cookieKey.length + 1);
      if (raw) {
        const decoded = decodeURIComponent(raw);
        const colonAt = decoded.lastIndexOf(":");
        const blockId = colonAt > 0 ? decoded.slice(0, colonAt) : decoded;
        const savedIndex = colonAt > 0 ? parseInt(decoded.slice(colonAt + 1), 10) : NaN;
        const bl = blocksRef.current;
        const idx = bl.findIndex(b => b.id === blockId);
        if (idx >= 0) {
          scrollToBlockIdx(idx, "start");
        } else if (!isNaN(savedIndex) && bl.length > 0) {
          scrollToBlockIdx(Math.min(savedIndex, bl.length - 1), "start");
        }
      }
    }
    return () => clearTimeout(unlockTimer);
  }, [loadState, productionId, scrollToBlockIdx, setActiveCommentBlockId, setTagEditorOnTop]);

  // ── Clear block highlight on scroll or click ─────────────────────────────────
  useEffect(() => {
    if (!highlightedBlockId) return;
    const clear = (event?: Event) => {
      if (navigatingAwayRef.current) return;
      const target = event?.target as HTMLElement | null;
      if (target?.closest("a[href]")) return;
      setHighlightedBlockId(null);
    };
    const timer = setTimeout(() => {
      document.addEventListener("scroll", clear, { passive: true, capture: true });
      document.addEventListener("click", clear);
    }, 400);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("scroll", clear, { capture: true });
      document.removeEventListener("click", clear);
    };
  }, [highlightedBlockId]);

  // SSE: receive seq pushes (state sync) and presence pushes from other clients.
  // Multiple open script tabs can exhaust the browser's per-origin HTTP/1.1
  // connection pool, so tabs share one EventSource through BroadcastChannel.
  useEffect(() => {
    if (loadState !== "ready" || !streamVisible) return;

    let es: EventSource | null = null;
    let leaderRenewTimer: ReturnType<typeof setInterval> | null = null;
    let electionTimer: ReturnType<typeof setInterval> | null = null;
    let isLeader = false;
    let closed = false;
    const tabId = `${clientId || "tab"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const streamKey = `${effectiveScriptId}:${activeVersionId ?? ""}`;
    const leaderKey = `script_sse_leader:${streamKey}`;
    const channelName = `script_sse:${streamKey}`;
    const leaderTtlMs = 8_000;
    const bc = typeof window !== "undefined" && "BroadcastChannel" in window
      ? new BroadcastChannel(channelName)
      : null;

    const handleSeq = (seq: number) => {
      if (seq <= serverSeqRef.current) return;

      if (streamDebounceTimerRef.current) clearTimeout(streamDebounceTimerRef.current);
      streamDebounceTimerRef.current = setTimeout(async () => {
        streamDebounceTimerRef.current = null;
        // Re-check: the PATCH response for our own edit may have arrived during
        // the 300 ms window and already advanced serverSeqRef.  If so there is
        // nothing to fetch — the server state equals what we already synced.
        if (seq <= serverSeqRef.current) return;
        try {
          const serverState = await fetchScriptState(effectiveScriptId, activeVersionId);
          if (!serverState) return;

          const oldSynced = syncedStateRef.current;
          serverSeqRef.current = seq;

          const mergedBlocks = expandLegacyMarkersToBlocks(mergeServerBlocks(blocksRef.current, serverState.blocks, oldSynced), serverState.scenes);
          const normalized = normalizeScriptMarkerInvariants(mergedBlocks, serverState.scenes, { ...scriptConfigRef.current, ...(serverState.config ?? {}) });
          markOwnershipDirty("full");
          setRehearsalLabels(buildMarkerLabelIndex(normalized.blocks));
          requestVirtualWindowRefresh();
          setBlocks(normalized.blocks);
          setCharacters(serverState.characters);
          setScenes(normalized.scenes);
          setScriptConfig(normalized.config);
          setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
          syncedStateRef.current = { ...serverState, blocks: normalized.blocks, scenes: normalized.scenes, config: normalized.config };
        } catch { /* ignore */ }
      }, 300);
    };

    const handlePresence = (list: RemotePresence[]) => {
      const next = new Map(list.map(p => [p.clientId, p]));
      const previousSize = presenceCountRef.current;
      if (next.size !== previousSize) {
        presenceCountRef.current = next.size;
        setToolbarMeasureTick(tick => tick + 1);
        if (presenceLayoutTimerRef.current !== null) {
          clearTimeout(presenceLayoutTimerRef.current);
          presenceLayoutTimerRef.current = null;
        }
        if (next.size < previousSize) {
          presenceLayoutTimerRef.current = setTimeout(() => {
            presenceLayoutTimerRef.current = null;
            resetToolbarMeasurement(false);
          }, 120);
        }
      }
      setPresenceMap(next);
    };

    const handleConfig = (cfg: ScriptConfig) => {
      setScriptConfig(prev => ({ ...DEFAULT_SCRIPT_CONFIG, ...prev, ...cfg }));
    };

    const openEventSource = (streamClientId: string, onEvent: (type: "seq" | "presence" | "config", data: unknown) => void) => {
      const streamParams = new URLSearchParams();
      streamParams.set("cid", streamClientId);
      if (activeVersionId) streamParams.set("v", activeVersionId);
      const streamQuery = streamParams.toString() ? `?${streamParams.toString()}` : "";
      const nextEs = new EventSource(`${BASE_PATH}/api/script/${effectiveScriptId}/stream${streamQuery}`);
      eventSourceRef.current = nextEs;

      nextEs.onmessage = (e: MessageEvent) => {
        const { seq } = JSON.parse(e.data as string) as { seq: number };
        handleSeq(seq);
        onEvent("seq", seq);
      };
      nextEs.addEventListener("presence", (e: MessageEvent) => {
        const list = JSON.parse(e.data as string) as RemotePresence[];
        handlePresence(list);
        onEvent("presence", list);
      });
      nextEs.addEventListener("config", (e: MessageEvent) => {
        const cfg = JSON.parse(e.data as string) as ScriptConfig;
        handleConfig(cfg);
        onEvent("config", cfg);
      });

      return nextEs;
    };

    const broadcast = (type: "seq" | "presence" | "config", data: unknown) => {
      bc?.postMessage({ source: tabId, type, data });
    };

    const readLeader = (): { tabId: string; expiresAt: number } | null => {
      try {
        const raw = localStorage.getItem(leaderKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { tabId?: unknown; expiresAt?: unknown };
        if (typeof parsed.tabId !== "string" || typeof parsed.expiresAt !== "number") return null;
        return { tabId: parsed.tabId, expiresAt: parsed.expiresAt };
      } catch {
        return null;
      }
    };

    const writeLeader = () => {
      localStorage.setItem(leaderKey, JSON.stringify({ tabId, expiresAt: Date.now() + leaderTtlMs }));
    };

    const stopLeader = (clearLock: boolean) => {
      if (leaderRenewTimer) {
        clearInterval(leaderRenewTimer);
        leaderRenewTimer = null;
      }
      es?.close();
      if (eventSourceRef.current === es) eventSourceRef.current = null;
      es = null;
      isLeader = false;
      if (clearLock) {
        try {
          const current = readLeader();
          if (current?.tabId === tabId) localStorage.removeItem(leaderKey);
        } catch { /* ignore */ }
      }
    };

    const startLeader = () => {
      if (closed || isLeader) return;
      const current = readLeader();
      if (current && current.tabId !== tabId && current.expiresAt > Date.now()) return;
      try {
        writeLeader();
        const confirmed = readLeader();
        if (confirmed?.tabId !== tabId) return;
      } catch {
        return;
      }

      isLeader = true;
      es = openEventSource(`stream:${streamKey}`, broadcast);
      leaderRenewTimer = setInterval(() => {
        try { writeLeader(); }
        catch { stopLeader(true); }
      }, 2_000);
    };

    const maybeElectLeader = () => {
      if (closed || isLeader) return;
      const current = readLeader();
      if (!current || current.expiresAt <= Date.now()) startLeader();
    };

    if (bc) {
      bc.onmessage = (event: MessageEvent) => {
        const msg = event.data as { source?: string; type?: string; data?: unknown };
        if (msg.source === tabId) return;
        if (msg.type === "seq" && typeof msg.data === "number") handleSeq(msg.data);
        else if (msg.type === "presence" && Array.isArray(msg.data)) handlePresence(msg.data as RemotePresence[]);
        else if (msg.type === "config" && msg.data && typeof msg.data === "object") handleConfig(msg.data as ScriptConfig);
      };
      electionTimer = setInterval(maybeElectLeader, 2_500);
      maybeElectLeader();
    } else {
      es = openEventSource(clientId || tabId, () => {});
    }

    return () => {
      closed = true;
      stopLeader(true);
      if (electionTimer) clearInterval(electionTimer);
      bc?.close();
      if (streamDebounceTimerRef.current) {
        clearTimeout(streamDebounceTimerRef.current);
        streamDebounceTimerRef.current = null;
      }
      if (presenceLayoutTimerRef.current !== null) {
        clearTimeout(presenceLayoutTimerRef.current);
        presenceLayoutTimerRef.current = null;
      }
    };
  }, [effectiveScriptId, loadState, clientId, activeVersionId, markOwnershipDirty, requestVirtualWindowRefresh, resetToolbarMeasurement, setToolbarMeasureTick, streamVisible, presenceCountRef, presenceLayoutTimerRef, setPresenceMap]);

  const [meUserId, setMeUserId] = useState("");
  const [meIsAdmin, setMeIsAdmin] = useState(false);
  const { workspaceWidth, productionSidebarReservedWidth, setWorkspaceMeasureRef } = useWorkspaceWidth();

  // Resolve Feishu display name and identity on mount
  useEffect(() => {
    fetch(`${BASE_PATH}/api/me`)
      .then(r => r.json())
      .then((data: { name: string | null; userId: string | null; isAdmin: boolean }) => {
        if (data.name) {
          setUserName(data.name);
          localStorage.setItem("presence_name", data.name);
        }
        if (data.userId) setMeUserId(data.userId);
        setMeIsAdmin(data.isAdmin ?? false);
      })
      .catch(() => {});
  }, [setUserName]);

  const markBlockFocused = useCallback((id: string) => {
    focusedIdRef.current = id;
    setFocusedId(id);
    sendPresence(id);
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  }, [sendPresence, updateActiveSceneFromScroll]);

  const focusBlockContent = useCallback((id: string, atEnd = true) => {
    markBlockFocused(id);
    pendingFocus.current = { id, atEnd };
  }, [markBlockFocused]);

  const glowAndFocusBlocks = useCallback((ids: string[], focusId = ids[ids.length - 1]) => {
    glowChangedBlocks(ids);
    focusBlockContent(focusId);
  }, [focusBlockContent, glowChangedBlocks]);

  // Debounced sync: SYNC_DEBOUNCE_MS after the last state change, at most
  // SYNC_MAX_WAIT_MS after the first (#520). 每次改动只 trigger，不在 cleanup 里
  // cancel——cancel 会把 maxWait 窗口起点一起清掉，等于回到纯 trailing。
  useEffect(() => {
    if (loadState !== "ready") return;
    syncDebounce.trigger();
  // blockTagMap included so tag-only changes (inherit, paste, manual edit)
  // also trigger the debounced sync and embed tags in the block op.
  }, [blocks, characters, scenes, blockTagMap, loadState, syncDebounce]);
  useEffect(() => () => { syncUnmountedRef.current = true; syncDebounce.cancel(); }, [syncDebounce]);

  const flushPendingPatch = useCallback(async () => {
    syncDebounce.cancel();
    if (isSyncingRef.current) {
      await new Promise<void>((resolve) => {
        syncIdleWaitersRef.current.push(resolve);
      });
      // 等待期间上一笔可能把撞锁的那轮重排了；这里马上就推，不用再等
      deferredSyncRef.current = false;
      syncDebounce.cancel();
    }
    const curr: ScriptState = {
      config: scriptConfigRef.current,
      blocks: normalizeScriptBlockStream(blocksRef.current),
      characters: charactersRef.current,
      scenes: scenesRef.current,
    };
    await pushPatchRef.current(curr);
    const remaining = diffState(syncedStateRef.current, curr, 0);
    const stateSynced = remaining.blockOps.length === 0 && remaining.charOps.length === 0 && remaining.sceneOps.length === 0;
    const currentTags = [...blockTagMapRef.current.entries()].sort(([a], [b]) => a.localeCompare(b));
    const syncedTags = [...syncedBlockTagMapRef.current.entries()].sort(([a], [b]) => a.localeCompare(b));
    return stateSynced &&
      pendingTagInsertsRef.current.size === 0 &&
      JSON.stringify(currentTags) === JSON.stringify(syncedTags);
  }, [syncDebounce]);

  const persistMarkerState = useCallback(async (next: ScriptState) => {
    syncDebounce.cancel();
    if (isSyncingRef.current) {
      await new Promise<void>((resolve) => syncIdleWaitersRef.current.push(resolve));
      deferredSyncRef.current = false;
      syncDebounce.cancel();
    }
    await pushPatchRef.current(next);
  }, [syncDebounce]);

  const undoStack = useRef<Block[][]>([]);
  const redoStack = useRef<Block[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const isTypingSession = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) taRefs.current.set(id, el);
    else taRefs.current.delete(id);
  }, []);

  const openCharSelector = useCallback((id: string) => {
    setCharEditTokens((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  const handleArrowUpFromTextarea = useCallback((id: string) => {
    const cur = blocksRef.current;
    const block = cur.find((b) => b.id === id);
    if (block?.type === "stage") {
      const idx = cur.findIndex((b) => b.id === id);
      if (idx > 0) {
        const prev = cur[idx - 1];
        const el = taRefs.current.get(prev.id);
        if (el) { el.focus(); setCursorAtEnd(el); }
      }
    } else {
      openCharSelector(id);
    }
  }, [openCharSelector]);

  const handleArrowDownFromTextarea = useCallback((id: string) => {
    const cur = blocksRef.current;
    const idx = cur.findIndex((b) => b.id === id);
    if (idx < cur.length - 1) {
      const next = cur[idx + 1];
      if (next.type === "stage") {
        const el = taRefs.current.get(next.id);
        if (el) { el.focus(); setCursorAtStart(el); }
      } else {
        openCharSelector(next.id);
      }
    }
  }, [openCharSelector]);

  const handleArrowUpFromChar = useCallback((id: string) => {
    const cur = blocksRef.current;
    const idx = cur.findIndex((b) => b.id === id);
    if (idx > 0) {
      const el = taRefs.current.get(cur[idx - 1].id);
      if (el) { el.focus(); setCursorAtEnd(el); }
    }
  }, []);

  const handleArrowDownFromChar = useCallback((id: string) => {
    const el = taRefs.current.get(id);
    if (el) { el.focus(); setCursorAtStart(el); }
  }, []);

  const saveSnapshot = useCallback(() => {
    undoStack.current.push(blocksRef.current);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const applyStageDelimiterChange = useCallback(async (updateExisting: boolean) => {
    const pending = pendingStageDelimiterChange;
    if (!pending) return;
    const previousOpen = scriptConfig.stageDelimOpen;
    const previousClose = scriptConfig.stageDelimClose;
    setPendingStageDelimiterChange(null);
    if (updateExisting) {
      const nextBlocks = blocksRef.current.map((block) => {
        if (block.type === "stage") return block;
        const content = replaceInlineStageDelimiters(
          block.content,
          previousOpen,
          previousClose,
          pending.open,
          pending.close
        );
        return content === block.content ? block : { ...block, content };
      });
      if (nextBlocks.some((block, index) => block !== blocksRef.current[index])) {
        saveSnapshot();
        markPageMapDirty("full");
        setBlocks(nextBlocks);
      }
    }
    await saveScriptConfig({ stageDelimOpen: pending.open, stageDelimClose: pending.close });
  }, [
    markPageMapDirty,
    pendingStageDelimiterChange,
    saveScriptConfig,
    saveSnapshot,
    scriptConfig.stageDelimOpen,
    scriptConfig.stageDelimClose,
  ]);

  // Apply inline format (bold/underline) to the current window selection.
  // Called from toolbar buttons via onMouseDown+preventDefault, which keeps
  // the selection alive even after the contenteditable loses focus.
  const applyFormatToFocused = useCallback((tag: "b" | "u") => {
    if (isLockedMode) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const editableEl = getEditableElementForRange(range);
    if (!editableEl) return;
    // End typing session so startTypingSession (called by updateBlock via input event)
    // saves a fresh pre-format snapshot rather than lumping with active typing.
    isTypingSession.current = false;
    toggleInlineTag(range, tag);
    // Re-focus then fire input so ScriptBlock's handleInput → syncContent runs
    editableEl.focus();
    editableEl.dispatchEvent(new Event("input", { bubbles: true }));
  }, [isLockedMode]);

  const startTypingSession = useCallback(() => {
    if (!isTypingSession.current) {
      saveSnapshot();
      isTypingSession.current = true;
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      isTypingSession.current = false;
      typingTimer.current = null;
    }, 800);
  }, [saveSnapshot]);

  const undo = useCallback(() => {
    if (isLockedMode) return;
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = undoStack.current.pop();
    if (!snapshot) return;
    redoStack.current.push(blocksRef.current);
    applyBlockStructureEdit(blocksRef.current, snapshot, "full");
    requestVirtualWindowRefresh();
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, [applyBlockStructureEdit, isLockedMode, requestVirtualWindowRefresh]);

  const redo = useCallback(() => {
    if (isLockedMode) return;
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = redoStack.current.pop();
    if (!snapshot) return;
    undoStack.current.push(blocksRef.current);
    applyBlockStructureEdit(blocksRef.current, snapshot, "full");
    requestVirtualWindowRefresh();
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, [applyBlockStructureEdit, isLockedMode, requestVirtualWindowRefresh]);

  // ── Tag handlers ─────────────────────────────────────────────────────────────
  // Tag mutations are no longer sent via a dedicated block-tags PATCH.
  // Instead they are embedded in the block op and synced atomically via the
  // debounced PATCH to /api/script/[id].  The block-tags route is still
  // available for server-side / admin use but is not called from here.

  const handleTagChange = useCallback((blockId: string, groupId: string, optionId: string | null, value: number | null, del: boolean) => {
    if (isLockedMode) return;
    setBlockTagMap(prev => {
      const map = new Map(prev);
      const existing = map.get(blockId) ?? [];
      if (del) {
        map.set(blockId, existing.filter(t => t.groupId !== groupId));
      } else {
        map.set(blockId, [...existing.filter(t => t.groupId !== groupId), { blockId, groupId, optionId, value }]);
      }
      return map;
    });
    // Tag change is synced as part of the block op via the debounced PATCH —
    // no separate block-tags PATCH needed.
    // Auto-sync block.lyric when any group has a lyric split configured (OR logic)
    const changedGroup = tagGroups.find(g => g.id === groupId);
    if (changedGroup?.lyricSplitAfterOptionId) {
      const splitOpt = changedGroup.options.find(o => o.id === changedGroup.lyricSplitAfterOptionId);
      if (splitOpt) {
        const groupIsLyric = !del && !!optionId &&
          (changedGroup.options.find(o => o.id === optionId)?.sortOrder ?? Infinity) <= splitOpt.sortOrder;
        const currentTags = blockTagMapRef.current.get(blockId) ?? [];
        const otherGroupsLyric = tagGroups.some(g => {
          if (g.id === groupId || !g.lyricSplitAfterOptionId) return false;
          const sp = g.options.find(o => o.id === g.lyricSplitAfterOptionId);
          if (!sp) return false;
          const tag = currentTags.find(t => t.groupId === g.id);
          return !!tag?.optionId &&
            (g.options.find(o => o.id === tag.optionId)?.sortOrder ?? Infinity) <= sp.sortOrder;
        });
        const newLyric = groupIsLyric || otherGroupsLyric;
        markBlockPageMapDirty(blockId);
        setBlocks(bs => bs.map(b => b.id === blockId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
      }
    }
  }, [blockTagMapRef, markBlockPageMapDirty, tagGroups, isLockedMode]);

  const handleTagCopy = useCallback((blockId: string) => {
    tagClipboardRef.current = blockTagMapRef.current.get(blockId) ?? [];
  }, []);

  const handleTagPaste = useCallback((blockId: string) => {
    if (isLockedMode) return;
    const clipboard = tagClipboardRef.current;
    if (!clipboard?.length) return;
    const inherited = clipboard.map(t => ({ ...t, blockId }));
    setBlockTagMap(prev => { const m = new Map(prev); m.set(blockId, inherited); return m; });
    // Tag change is synced as part of the block op via the debounced PATCH.
  }, [isLockedMode]);

  const inheritTags = useCallback((fromId: string, toId: string) => {
    // Use blockTagMap from the closure (latest committed state) rather than
    // blockTagMapRef so we're never stale when Enter is pressed right after
    // a tag change (useEffect syncing the ref fires asynchronously).
    const sourceTags = blockTagMap.get(fromId) ?? [];
    if (!sourceTags.length) return;
    const inherited = sourceTags.map(t => ({ ...t, blockId: toId }));
    setBlockTagMap(prev => { const m = new Map(prev); m.set(toId, inherited); return m; });
    // Register the tags directly in a ref so pushPatchRef can embed them in the
    // insert op synchronously, without any dependency on useEffect timing.
    pendingTagInsertsRef.current.set(toId, inherited.map(t => ({
      groupId: t.groupId, optionId: t.optionId, value: t.value,
    })));
    // Apply the lyric mapping rule immediately so the new block's display is correct.
    const newLyric = computeLyricFromTags(inherited, tagGroups);
    if (newLyric !== null) {
      markBlockPageMapDirty(toId);
      setBlocks(bs => bs.map(b => b.id === toId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
    }
    // Tags (and the corrected lyric) are synced atomically via the debounced block op PATCH.
  }, [blockTagMap, markBlockPageMapDirty, tagGroups]);

  const {
    searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchExact, setSearchExact,
    searchCurrentPage, setSearchCurrentPage, searchIdx, setSearchIdx, searchMatches,
    jumpTarget, setJumpTarget, jumpValue, setJumpValue, jumpToLine, jumpToPage,
  } = useScriptSearch({ blocks, pageMap, focusedId, loadState, initialSearchQuery, scrollToBlockIdx });

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) {
        if (isFormEditingTarget(e.target)) return;
        e.preventDefault();
        undo();
      }
      else if (e.key === "z" && e.shiftKey) {
        if (isFormEditingTarget(e.target)) return;
        e.preventDefault();
        redo();
      }
      else if (e.key === "f" && !e.shiftKey) { e.preventDefault(); setSearchOpen(true); }
      // Tag clipboard: ⌘/Ctrl+Shift+C copies tags from focused block, ⌘/Ctrl+Shift+V pastes
      else if (e.key === "c" && e.shiftKey) {
        const id = focusedIdRef.current;
        if (id) { e.preventDefault(); tagClipboardRef.current = blockTagMapRef.current.get(id) ?? []; }
      }
      else if (e.key === "v" && e.shiftKey) {
        const id = focusedIdRef.current;
        if (id && tagClipboardRef.current?.length) { e.preventDefault(); handleTagPaste(id); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [undo, redo, handleTagPaste, setSearchOpen]);

  const toggleBlockType = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    const previousBlocks = blocksRef.current;
    const changes: BlockChange[] = [];
    const nextBlocks: Block[] = previousBlocks.map((b, position) => {
      if (b.id !== id) return b;
      const next = { ...b, type: b.type === "dialogue" ? "stage" as const : "dialogue" as const, characterIds: [] };
      if (b.type !== next.type) changes.push({
        kind: "convert", position, blockId: b.id, beforeType: b.type, afterType: next.type,
      });
      return next;
    });
    applyBlockStructureEdit(previousBlocks, nextBlocks, markerChangeFromOperations(changes));
    glowAndFocusBlocks([id]);
  }, [applyBlockStructureEdit, glowAndFocusBlocks, saveSnapshot, isLockedMode]);

  const toggleStageCueToFocused = useCallback(() => {
    const id = focusedIdRef.current;
    if (!id) return;

    const block = blocksRef.current.find((b) => b.id === id);
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const editableEl = range ? getEditableElementForRange(range) : null;

    if (
      block?.type !== "stage" &&
      range &&
      !sel?.isCollapsed &&
      editableEl &&
      editableEl === taRefs.current.get(id)
    ) {
      wrapSelectionAsInlineStageCue(range, scriptConfigRef.current.stageDelimOpen, scriptConfigRef.current.stageDelimClose);
      editableEl.focus();
      editableEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    toggleBlockType(id);
  }, [toggleBlockType]);

  const toggleBlockLyric = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    markBlockPageMapDirty(id);
    setBlocks((prev) => prev.map((b) =>
      b.id === id ? { ...b, lyric: !b.lyric } : b
    ));
    glowAndFocusBlocks([id]);
  }, [glowAndFocusBlocks, markBlockPageMapDirty, saveSnapshot, isLockedMode]);

  const setBlocksType = useCallback((ids: string[], type: BlockType) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    const previousBlocks = blocksRef.current;
    const changes: BlockChange[] = [];
    const nextBlocks = previousBlocks.map((b, position) => {
      if (!targetIds.has(b.id)) return b;
      const next = { ...b, type, characterIds: type === "stage" ? [] : b.characterIds };
      if (b.type !== type) changes.push({
        kind: "convert", position, blockId: b.id, beforeType: b.type, afterType: type,
      });
      return next;
    });
    applyBlockStructureEdit(previousBlocks, nextBlocks, markerChangeFromOperations(changes));
    glowAndFocusBlocks(ids);
  }, [applyBlockStructureEdit, glowAndFocusBlocks, saveSnapshot, isLockedMode]);

  const setBlocksLyric = useCallback((ids: string[], lyric: boolean) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    markBlockIdsPageMapDirty(targetIds);
    setBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id) && b.type !== "stage"
        ? { ...b, lyric }
        : b
    ));
    glowAndFocusBlocks(ids);
  }, [glowAndFocusBlocks, markBlockIdsPageMapDirty, saveSnapshot, isLockedMode]);

  // Apply pending focus on every render until resolved
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pf = pendingFocus.current;
    if (pf) {
      const el = taRefs.current.get(pf.id);
      if (el) {
        el.focus();
        if (el.isContentEditable) {
          if (pf.atEnd) setCursorAtEnd(el);
          else if (pf.textOffset !== undefined) setCursorAtTextOffset(el, pf.textOffset);
        } else {
          window.getSelection()?.removeAllRanges();
        }
        pendingFocus.current = null;
      }
    }
    const pco = pendingCharOpen.current;
    if (pco) {
      pendingCharOpen.current = null;
      setCharEditTokens((prev) => ({ ...prev, [pco]: (prev[pco] ?? 0) + 1 }));
    }
  });

  const updateBlock = useCallback(
    (id: string, changes: Partial<Block>) => {
      if (isLockedMode) return;
      startTypingSession();
      markBlockPageMapDirty(id);
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
    },
    [markBlockPageMapDirty, startTypingSession, isLockedMode]
  );

  const findChapterIdForBlock = useCallback((blockId: string): string | null => {
    const currentBlocks = ownedBlocksRef.current;
    const currentScenes = scenesRef.current;
    const sceneMap = new Map(currentScenes.map((scene) => [scene.id, scene]));
    const idx = currentBlocks.findIndex((block) => block.id === blockId);
    if (idx !== -1) {
      for (let i = idx; i >= 0; i--) {
        const sceneId = currentBlocks[i].sceneId;
        if (!sceneId) continue;
        const scene = sceneMap.get(sceneId);
        if (!scene) continue;
        return scene.parentId ?? scene.id;
      }
    }
    return currentScenes.find((scene) => scene.parentId === null)?.id ?? null;
  }, []);

  const addChapterBeforeBlock = useCallback((blockId: string) => {
    if (isLockedMode || !canEditMetadata) return;
    const previousBlocks = blocksRef.current;
    const next = insertMarker({
      blocks: previousBlocks,
      scenes: scenesRef.current,
      characters: charactersRef.current,
      config: scriptConfigRef.current,
    }, { kind: "chapter", name: "", beforeBlockId: blockId }, uid);
    saveSnapshot();
    markBlockStructureDirty(previousBlocks, next.blocks);
    setBlocks(next.blocks);
    setScenes(next.scenes);
    setScriptConfig(next.config);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, next.scenes));
    void persistMarkerState(next);
  }, [canEditMetadata, isLockedMode, markBlockStructureDirty, persistMarkerState, saveSnapshot]);

  const addSceneBeforeBlock = useCallback((blockId: string) => {
    if (isLockedMode || !canEditMetadata) return;
    const chapterId = findChapterIdForBlock(blockId);
    const previousBlocks = blocksRef.current;
    const next = insertMarker({
      blocks: previousBlocks,
      scenes: scenesRef.current,
      characters: charactersRef.current,
      config: scriptConfigRef.current,
    }, {
      kind: chapterId ? "scene" : "chapter",
      name: "",
      parentId: chapterId,
      beforeBlockId: blockId,
    }, uid);
    saveSnapshot();
    markBlockStructureDirty(previousBlocks, next.blocks);
    setBlocks(next.blocks);
    setScenes(next.scenes);
    setScriptConfig(next.config);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, next.scenes));
    void persistMarkerState(next);
  }, [canEditMetadata, findChapterIdForBlock, isLockedMode, markBlockStructureDirty, persistMarkerState, saveSnapshot]);

  const addRehearsalBeforeBlock = useCallback((blockId: string) => {
    if (isLockedMode || !effectiveCanEditRehearsalMark || !scriptConfigRef.current.useRehearsalMarks) return;
    const marker = makeMarkerBlock("rehearsal_marker");
    const previousBlocks = blocksRef.current;
    const index = previousBlocks.findIndex((block) => block.id === blockId);
    const insertIndex = index === -1 ? previousBlocks.length : index;
    const nextBlocks = insertMarkerWithEmptyBlockIfNeeded(
      previousBlocks,
      marker,
      insertIndex,
      scriptConfigRef.current.openingChapterMarkerId,
    );
    saveSnapshot();
    markBlockStructureDirty(previousBlocks, nextBlocks);
    setBlocks(nextBlocks);
  }, [effectiveCanEditRehearsalMark, isLockedMode, markBlockStructureDirty, saveSnapshot]);

  const convertMarkerBlockType = useCallback((blockId: string, nextType: Extract<BlockType, "chapter_marker" | "scene_marker">) => {
    if (isLockedMode || !canEditMetadata) return;
    const currentIdx = blockIndexByIdRef.current.get(blockId);
    if (currentIdx === undefined) return;
    const currentBlock = blocksRef.current[currentIdx];
    if (!currentBlock) return;
    if (!isMarkerBlock(currentBlock)) return;
    if (currentBlock.type === nextType) return;
    const previousBlocks = blocksRef.current;
    const next = convertMarker({
      blocks: previousBlocks,
      scenes: scenesRef.current,
      characters,
      config: scriptConfigRef.current,
    }, blockId, nextType === "chapter_marker" ? "chapter" : "scene", uid);

    saveSnapshot();
    markBlockStructureDirty(previousBlocks, next.blocks);
    setBlocks(next.blocks);
    setScenes(next.scenes);
    setScriptConfig(next.config);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, next.scenes));
    void persistMarkerState(next);
    selectionAnchorBlockIdRef.current = blockId;
    selectionDetachedRef.current = false;
    markerEndedScopeIdsRef.current = new Set([blockId]);
    setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
    setSelectedBlockIds(new Set([blockId]));
  }, [canEditMetadata, characters, isLockedMode, markBlockStructureDirty, persistMarkerState, saveSnapshot]);

  const splitBlock = useCallback((id: string, before: string, after: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate the new block ID **outside** the setBlocks updater so the ID
    // is stable across React Strict Mode's double-invocation of the updater.
    // If makeBlock() were called inside the updater, each invocation would
    // produce a different uid(), causing nextId (from the 2nd call) to diverge
    // from the block actually committed to state (from the 1st call).
    const nextBlockId = uid();
    const previousBlocks = blocksRef.current;
    const currentIdx = previousBlocks.findIndex((block) => block.id === id);
    if (currentIdx !== -1) {
      const cur = previousBlocks[currentIdx];
      // New block inherits scene, rehearsal mark, and character from the block being split
      const next: Block = {
        ...makeBlock(after, cur.characterIds),
        id: nextBlockId,   // use the pre-generated stable ID
        sceneId: null,
        rehearsalMark: null,
        characterAnnotations: { ...cur.characterAnnotations },
      };
      const updated = [...previousBlocks];
      updated[currentIdx] = { ...cur, content: before };
      updated.splice(currentIdx + 1, 0, next);
      pendingFocus.current = { id: next.id, textOffset: 0 };
      markOwnershipDirty({ start: currentIdx, end: currentIdx + 1, throughNextMarker: false });
      applyBlockStructureEdit(previousBlocks, updated, markerChangeFromOperations([{
        kind: "insert",
        position: currentIdx + 1,
        blockId: next.id,
        beforeType: null,
        afterType: next.type,
      }]));
    }
    inheritTags(id, nextBlockId);
  }, [applyBlockStructureEdit, markOwnershipDirty, saveSnapshot, inheritTags, isLockedMode]);

  const mergeBlock = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    const previousBlocks = blocksRef.current;
    const currentIdx = previousBlocks.findIndex((block) => block.id === id);
    if (currentIdx === 0) {
      // Delete empty first block if there are more blocks after it
      if (previousBlocks.length > 1 && !previousBlocks[0].content.trim()) {
        pendingFocus.current = { id: previousBlocks[1].id, atEnd: false };
        applyBlockStructureEdit(previousBlocks, previousBlocks.slice(1), markerChangeFromOperations([{
          kind: "delete",
          position: 0,
          blockId: previousBlocks[0].id,
          beforeType: previousBlocks[0].type,
          afterType: null,
        }]));
      }
      return;
    }
    if (currentIdx > 0) {
      const p = previousBlocks[currentIdx - 1];
      const c = previousBlocks[currentIdx];
      const mergedContent =
        p.content && c.content ? `${p.content}\n${c.content}` : p.content + c.content;
      const merged = { ...p, content: mergedContent };
      const updated = [...previousBlocks];
      updated[currentIdx - 1] = merged;
      updated.splice(currentIdx, 1);
      // Place cursor right after the \n separator (= start of the merged-in content).
      // When only one side is non-empty there's no \n, so offset = end of p.content.
      const pLen = getTextLength(mdToHtml(p.content));
      pendingFocus.current = {
        id: p.id,
        textOffset: p.content && c.content ? pLen + 1 : pLen,
      };
      markOwnershipDirty({ start: currentIdx - 1, end: currentIdx, throughNextMarker: false });
      applyBlockStructureEdit(previousBlocks, updated, markerChangeFromOperations([{
        kind: "delete",
        position: Math.min(currentIdx, updated.length),
        blockId: c.id,
        beforeType: c.type,
        afterType: null,
      }]));
    }
  }, [applyBlockStructureEdit, markOwnershipDirty, saveSnapshot, isLockedMode]);

  const nonEmptyDramaturgyMarkersForBlockIds = useCallback((ids: Iterable<string>): NonEmptyDramaturgyMarker[] => {
    const currentBlocks = blocksRef.current;
    const currentIndexById = blockIndexByIdRef.current;
    const markers: NonEmptyDramaturgyMarker[] = [];
    for (const id of ids) {
      const index = currentIndexById.get(id);
      const block = index === undefined ? undefined : currentBlocks[index];
      if (!block) continue;
      const detail = block.sceneId ? sceneDetailById.get(block.sceneId) ?? null : null;
      const kind = markerBlockDramaturgyDeleteBlockedKind(block, detail);
      if (kind) markers.push({ id, kind });
    }
    return markers;
  }, [sceneDetailById]);

  const deleteBlocks = useCallback((ids: string[], options?: { forceDeleteNonEmptyMarkerDetails?: boolean }) => {
    if (isLockedMode) return;
    const deleteIds = new Set<string>(ids);
    if (deleteIds.size === 0) return;
    const blockedMarkers = nonEmptyDramaturgyMarkersForBlockIds(deleteIds);
    if (blockedMarkers.length > 0 && !options?.forceDeleteNonEmptyMarkerDetails) {
      if (deleteIds.size === 1) {
        setMarkerDetailDeleteBlockedKind(blockedMarkers[0].kind);
      } else {
        setSelectedNonEmptyMarkerDeleteIds(new Set());
        setExpandedNonEmptyMarkerDetailIds(new Set());
        setPendingNonEmptyMarkerSelectionDeleteIds(Array.from(deleteIds));
      }
      return;
    }
    saveSnapshot();
    const emptyBlockId2 = uid(); // pre-generated for the case where all blocks are deleted
    const currentBlocks = blocksRef.current;
    const firstDeletedIdx = currentBlocks.findIndex((block) => deleteIds.has(block.id));
    if (firstDeletedIdx === -1) return;
    const remaining = currentBlocks.filter((block) => !deleteIds.has(block.id));
    const editedBlocks = remaining.length > 0 ? remaining : [{ ...makeBlock(), id: emptyBlockId2 }];
    let retainedBefore = 0;
    const changes: BlockChange[] = [];
    for (const block of currentBlocks) {
      if (deleteIds.has(block.id)) {
        changes.push({
          kind: "delete",
          position: retainedBefore,
          blockId: block.id,
          beforeType: block.type,
          afterType: null,
        });
      } else retainedBefore++;
    }
    if (remaining.length === 0) changes.push({
      kind: "insert",
      position: 0,
      blockId: editedBlocks[0].id,
      beforeType: null,
      afterType: editedBlocks[0].type,
    });
    const normalized = normalizeScriptMarkerInvariants(
      editedBlocks,
      scenesRef.current,
      scriptConfigRef.current,
      markerChangeFromOperations(changes),
    );
    const focusIdx = Math.min(firstDeletedIdx, editedBlocks.length - 1);
    pendingFocus.current = { id: editedBlocks[focusIdx].id, atEnd: false };
    markBlockStructureDirty(currentBlocks, normalized.blocks);
    setBlocks(normalized.blocks);
    if (!sameSceneRows(normalized.scenes, scenesRef.current)) {
      setScenes(normalized.scenes);
      setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
    }
    if (normalized.config.openingChapterMarkerId !== scriptConfigRef.current.openingChapterMarkerId) {
      syncOpeningChapterMarkerId(normalized.blocks);
    }
    setSelectedBlockIds((current) => {
      const next = new Set(current);
      for (const id of deleteIds) next.delete(id);
      return next;
    });
    markerEndedScopeIdsRef.current = new Set();
    selectionDetachedRef.current = false;
    setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
    if (selectionAnchorBlockIdRef.current && deleteIds.has(selectionAnchorBlockIdRef.current)) {
      selectionAnchorBlockIdRef.current = null;
    }
  }, [markBlockStructureDirty, nonEmptyDramaturgyMarkersForBlockIds, saveSnapshot, syncOpeningChapterMarkerId, isLockedMode]);

  const emptyScriptCleanupDescendantKeys = useMemo(() => {
    const childKeysByParent = new Map<string, string[]>();
    for (const target of pendingEmptyScriptCleanup ?? []) {
      if (!target.parentKey) continue;
      const childKeys = childKeysByParent.get(target.parentKey);
      if (childKeys) childKeys.push(target.key);
      else childKeysByParent.set(target.parentKey, [target.key]);
    }
    const descendantKeys = new Map<string, Set<string>>();
    const collect = (key: string): Set<string> => {
      const cached = descendantKeys.get(key);
      if (cached) return cached;
      const collected = new Set<string>();
      for (const childKey of childKeysByParent.get(key) ?? []) {
        collected.add(childKey);
        for (const descendantKey of collect(childKey)) collected.add(descendantKey);
      }
      descendantKeys.set(key, collected);
      return collected;
    };
    for (const target of pendingEmptyScriptCleanup ?? []) {
      collect(target.key);
    }
    return descendantKeys;
  }, [pendingEmptyScriptCleanup]);

  const setEmptyScriptCleanupDialog = useCallback((targets: EmptyScriptCleanupTarget[] | null) => {
    setPendingEmptyScriptCleanup(targets);
    setSelectedEmptyScriptCleanupKeys(new Set());
  }, []);

  const toggleEmptyScriptCleanupTarget = useCallback((target: EmptyScriptCleanupTarget) => {
    if (target.disabledReason) return;
    setSelectedEmptyScriptCleanupKeys((current) => {
      const next = new Set(current);
      const relatedKeys = emptyScriptCleanupDescendantKeys.get(target.key) ?? new Set<string>();
      if (next.has(target.key)) {
        next.delete(target.key);
        for (const key of relatedKeys) next.delete(key);
      } else {
        next.add(target.key);
        for (const key of relatedKeys) next.add(key);
      }
      return next;
    });
  }, [emptyScriptCleanupDescendantKeys]);

  const requestEmptyScriptCleanup = useCallback(() => {
    if (isLockedMode || !canEditText) return;
    const cleanupAnalysis = analyzeEmptyScriptCleanup(
      blocksRef.current,
      scenesRef.current,
      sceneDetailById,
      scriptConfigRef.current.openingChapterMarkerId
    );
    if (!cleanupAnalysis.hasEmptyTextBlock && cleanupAnalysis.targets.length === 0) {
      showReorderNotice("没有可清除的空白内容。");
      closeToolbarMenu();
      return;
    }
    setEmptyScriptCleanupDialog(cleanupAnalysis.targets);
    closeToolbarMenu();
  }, [canEditText, closeToolbarMenu, isLockedMode, sceneDetailById, setEmptyScriptCleanupDialog, showReorderNotice]);

  const applyEmptyScriptCleanup = useCallback((selectedTargetKeys: Set<string>) => {
    if (isLockedMode || !canEditText) return;
    const currentBlocks = blocksRef.current;
    const emptyTextBlockIds = currentBlocks
      .filter(isEmptyTextBlock)
      .map((block) => block.id);
    if (emptyTextBlockIds.length === 0 && selectedTargetKeys.size === 0) {
      setEmptyScriptCleanupDialog(null);
      return;
    }

    if (selectedTargetKeys.size === 0) {
      setEmptyScriptCleanupDialog(null);
      deleteBlocks(emptyTextBlockIds);
      showReorderNotice("已清除空白剧本块。");
      return;
    }

    if (!pendingEmptyScriptCleanup) return;
    const selectedTargets = pendingEmptyScriptCleanup
      .filter((target) => !target.disabledReason && selectedTargetKeys.has(target.key));
    if (selectedTargets.length === 0) {
      setEmptyScriptCleanupDialog(null);
      if (emptyTextBlockIds.length > 0) {
        deleteBlocks(emptyTextBlockIds);
        showReorderNotice("已清除空白剧本块。");
      }
      return;
    }
    const { deleteBlockIds, selectedSceneIds } = buildEmptyScriptCleanupRemovalPlan(
      currentBlocks,
      selectedTargets
    );

    const remainingBlocks = currentBlocks.filter((block) => !deleteBlockIds.has(block.id));
    const remainingScenes = scenesRef.current.filter((scene) => !selectedSceneIds.has(scene.id));
    const editedBlocks = remainingBlocks.length > 0 ? remainingBlocks : [makeBlock()];
    let retainedBefore = 0;
    const changes: BlockChange[] = [];
    for (const block of currentBlocks) {
      if (deleteBlockIds.has(block.id)) {
        changes.push({
          kind: "delete",
          position: retainedBefore,
          blockId: block.id,
          beforeType: block.type,
          afterType: null,
        });
      } else retainedBefore++;
    }
    if (remainingBlocks.length === 0) changes.push({
      kind: "insert",
      position: 0,
      blockId: editedBlocks[0].id,
      beforeType: null,
      afterType: editedBlocks[0].type,
    });
    const normalized = normalizeScriptMarkerInvariants(
      editedBlocks,
      remainingScenes,
      scriptConfigRef.current,
      markerChangeFromOperations(changes),
    );

    saveSnapshot();
    markBlockStructureDirty(currentBlocks, normalized.blocks);
    resetScriptInteractions();
    setEmptyScriptCleanupDialog(null);
    setBlocks(normalized.blocks);
    setScenes(normalized.scenes);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(
      prev.filter((scene) => !selectedSceneIds.has(scene.id)),
      normalized.scenes
    ));
    showReorderNotice("已清除选中空白内容。");
  }, [canEditText, deleteBlocks, isLockedMode, markBlockStructureDirty, pendingEmptyScriptCleanup, resetScriptInteractions, saveSnapshot, setEmptyScriptCleanupDialog, showReorderNotice]);

  const applyMarkerDeleteOperation = useCallback((operation: MarkerDeleteOperation) => {
    const previousBlocks = blocksRef.current;
    const next = executeMarkerDeletion({
      blocks: previousBlocks,
      scenes: scenesRef.current,
      characters: charactersRef.current,
      config: scriptConfigRef.current,
    }, operation, uid);
    saveSnapshot();
    markBlockStructureDirty(previousBlocks, next.blocks);
    resetScriptInteractions();
    setBlocks(next.blocks);
    setScenes(next.scenes);
    setScriptConfig(next.config);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, next.scenes));
    setMarkerDeleteDialog(null);
    void persistMarkerState(next);
  }, [markBlockStructureDirty, persistMarkerState, resetScriptInteractions, saveSnapshot]);

  const deleteMarker = useCallback((markerBlockId: string) => {
    if (isLockedMode) return;
    const plan = planMarkerDeletion({
      blocks: blocksRef.current,
      scenes: scenesRef.current,
      characters: charactersRef.current,
      config: scriptConfigRef.current,
    }, markerBlockId, sceneDetails);
    if (plan.status === "blocked" || plan.status === "choice") {
      setMarkerDeleteDialog({ plan, source: "local" });
      return;
    }
    if (plan.operation.type === "whole" && !canEditText) {
      setMarkerDeleteDialog({ plan: null, message: "删除整段空白剧本需要剧本编辑权限。", source: "local" });
      return;
    }
    applyMarkerDeleteOperation(plan.operation);
  }, [applyMarkerDeleteOperation, canEditText, isLockedMode, sceneDetails]);

  const blockIdsRequireNonEmptySceneConfirm = useCallback((ids: string[]) => ids.some((id) => {
    const index = blockIndexByIdRef.current.get(id);
    if (index === undefined) return false;
    const block = blocks[index];
    return !!block && isBlockEmptyForDelete(block) && isOnlyTextBlockInMarkerSegment(ownedBlocks, index, scriptConfigRef.current.openingChapterMarkerId);
  }), [blocks, ownedBlocks]);

  const blockIdsAreEmptyForDelete = useCallback((ids: string[]) => ids.every((id) => {
    const index = blockIndexByIdRef.current.get(id);
    const block = index === undefined ? undefined : blocks[index];
    return block ? isBlockEmptyForDelete(block) : false;
  }), [blocks]);

  const selectedBlockIdsArray = useMemo(() => Array.from(selectedBlockIds), [selectedBlockIds]);
  const selectedBlocksRequireNonEmptySceneConfirm = useMemo(
    () => selectedBlockIdsArray.length === 1 && blockIdsRequireNonEmptySceneConfirm(selectedBlockIdsArray),
    [blockIdsRequireNonEmptySceneConfirm, selectedBlockIdsArray]
  );
  const selectedBlocksAreEmptyForDelete = useMemo(
    () => blockIdsAreEmptyForDelete(selectedBlockIdsArray),
    [blockIdsAreEmptyForDelete, selectedBlockIdsArray]
  );

  const requestSelectedBlocksDelete = useCallback(() => {
    if (isLockedMode) return false;
    const selectedIds = selectedBlockIdsArray;
    if (selectedIds.length === 0) return false;
    if (!canPerformSelectedBlockAction(selectedIds)) return true;
    const selectedBlocks = selectedIds
      .map((id) => {
        const index = blockIndexByIdRef.current.get(id);
        return index === undefined ? null : blocks[index] ?? null;
      })
      .filter((block): block is Block => block !== null);
    if (selectedBlocks.length === 0) return false;
    if (selectedBlocksAreEmptyForDelete && !selectedBlocksRequireNonEmptySceneConfirm) {
      requestLargeSelectionOperation("delete", selectedIds.length, () => deleteBlocks(selectedIds));
      return true;
    }
    const visibleAnchor = blocks
      .slice(windowRange.start, windowRange.end)
      .find((b) => selectedBlockIds.has(b.id));
    const anchorId = visibleAnchor?.id ?? selectedBlocks[0].id;
    setDeleteConfirmationRequest((current) => ({
      anchorId,
      token: (current?.token ?? 0) + 1,
    }));
    setDeleteConfirmingBlockIds(new Set(selectedIds));
    return true;
  }, [blocks, canPerformSelectedBlockAction, deleteBlocks, requestLargeSelectionOperation, selectedBlockIds, selectedBlockIdsArray, selectedBlocksAreEmptyForDelete, selectedBlocksRequireNonEmptySceneConfirm, windowRange.end, windowRange.start, isLockedMode]);

  const requestMarkerDelete = useCallback((id: string) => {
    if (isLockedMode) return false;
    const ids = selectedBlockIds.has(id) ? selectedBlockIdsArray : [id];
    if (!selectedBlockIds.has(id) && selectedBlockIds.size > 0) {
      clearBlockSelection();
    }
    if (ids.length === 1) {
      const plan = planMarkerDeletion({
        blocks: blocksRef.current,
        scenes: scenesRef.current,
        characters: charactersRef.current,
        config: scriptConfigRef.current,
      }, id, sceneDetails);
      setDeleteConfirmingBlockIds(new Set(plan.status === "blocked" ? [id] : plan.previewBlockIds));
      return true;
    }
    if (!canPerformSelectedBlockAction(ids)) return false;
    setDeleteConfirmingBlockIds(new Set(ids));
    return true;
  }, [canPerformSelectedBlockAction, clearBlockSelection, isLockedMode, sceneDetails, selectedBlockIds, selectedBlockIdsArray]);

  const requestMobileDelete = useCallback((id: string) => {
    const index = blockIndexByIdRef.current.get(id);
    const block = index === undefined ? null : blocksRef.current[index] ?? null;
    if (!block) return;

    if (isMarkerBlock(block)) {
      if (!requestMarkerDelete(id)) return;
      setMobileDeleteConfirmation({
        kind: "marker",
        markerId: id,
        message: block.type === "chapter_marker"
          ? "确认删除此章节标记？"
          : block.type === "scene_marker"
            ? "确认删除此段落标记？"
            : "确认删除此排练记号？",
      });
      return;
    }

    const ids = selectedBlockIds.has(id) ? selectedBlockIdsArray : [id];
    if (!canPerformSelectedBlockAction(ids)) return;
    const blocked = ids.length === 1 && blockIdsRequireNonEmptySceneConfirm(ids);
    const canDeleteWithoutConfirmation = blockIdsAreEmptyForDelete(ids) && !blocked;
    if (canDeleteWithoutConfirmation) {
      requestLargeSelectionOperation("delete", ids.length, () => deleteBlocks(ids));
      return;
    }
    setDeleteConfirmingBlockIds(new Set(ids));
    setMobileDeleteConfirmation({
      kind: "blocks",
      blockIds: ids,
      message: blocked
        ? "章节/段落/排练记号内容不可为空，至少需包含一个剧本块"
        : ids.length > 1
          ? `确认删除所选 ${ids.length} 行？`
          : "确认删除此行？",
      blocked,
    });
  }, [
    blockIdsAreEmptyForDelete,
    blockIdsRequireNonEmptySceneConfirm,
    canPerformSelectedBlockAction,
    deleteBlocks,
    requestLargeSelectionOperation,
    requestMarkerDelete,
    selectedBlockIds,
    selectedBlockIdsArray,
  ]);

  const dismissBlockConfirmations = useCallback(() => {
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setMarkerDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const hasDeleteConfirmationOpen = deleteConfirmingBlockIds.size > 0 || markerDeleteConfirmBlockId !== null;
    const handler = (e: PointerEvent) => {
      if (draggingBlockId.current || isReorderLockedRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (mobileBlockMenuBlockId !== null && !target.closest("[data-script-selection-action='true']")) return;
      if (target.closest("a[href]")) return;
      const docEl = document.documentElement;
      const isViewportScrollbar = e.clientX >= docEl.clientWidth || e.clientY >= docEl.clientHeight;
      if (isViewportScrollbar) return;
      if (target.closest("[data-script-scene-detail='true']")) return;
      if (target.closest("[data-script-confirmation='true']")) return;
      const isSelectionBarClick = !!target.closest("[data-script-block-bar='true'], [data-script-marker-bar='true']");
      const isMarkerViewClick = !!target.closest("[data-script-marker-selectable='true']") &&
        !target.closest("[data-script-marker-title='true'], button, input, textarea, [contenteditable='true']");
      if (isSelectionBarClick || isMarkerViewClick || target.closest("[data-script-selection-action='true']")) {
        if (isSelectionBarClick && hasDeleteConfirmationOpen) {
          clearBlockSelection();
        }
        dismissBlockConfirmations();
        return;
      }
      if (selectedBlockIds.size > 0) {
        clearBlockSelection();
      }
      dismissBlockConfirmations();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [clearBlockSelection, deleteConfirmingBlockIds.size, dismissBlockConfirmations, markerDeleteConfirmBlockId, mobileBlockMenuBlockId, selectedBlockIds.size, isReorderLockedRef]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTextEditingTarget(e.target)) return;
      if (!requestSelectedBlocksDelete()) return;
      e.preventDefault();
      e.stopPropagation();
      clearEditorFocusForDrag();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [clearEditorFocusForDrag, requestSelectedBlocksDelete]);

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Shift") setShiftKeyDown(true);
      if (e.key === "Shift" || e.key === "Control" || e.key === "Meta") {
        selectionDetachedRef.current = true;
      }
    };
    const handleKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Shift") setShiftKeyDown(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const moveDraggedBlocks = useCallback((fromIds: string[], target: DragTarget): boolean => {
    if (isLockedMode) return false;
    const movingIds = new Set(fromIds);
    if (movingIds.size === 0) {
      showReorderNotice("移动失败：未找到被拖拽内容。");
      return false;
    }
    const prev = blocksRef.current;
    const resolvedTarget = resolveDragTarget(target, prev, windowRangeRef.current);
    if (!resolvedTarget) {
      showReorderNotice("移动失败：目标位置已失效，请重新拖拽。");
      return false;
    }
    const rawInsertIdx = getDragInsertIndex(resolvedTarget, prev);
    if (rawInsertIdx === -1) {
      showReorderNotice("移动失败：目标位置已失效，请重新拖拽。");
      return false;
    }

    const moving = prev.filter((b) => movingIds.has(b.id));
    if (moving.length === 0) {
      showReorderNotice("移动失败：未找到被拖拽内容。");
      return false;
    }

    const remaining = prev.filter((b) => !movingIds.has(b.id));
    const removedBeforeInsert = prev
      .slice(0, rawInsertIdx)
      .filter((b) => movingIds.has(b.id)).length;
    const insertIdx = Math.max(0, Math.min(remaining.length, rawInsertIdx - removedBeforeInsert));
    const next = [...remaining];
    next.splice(insertIdx, 0, ...moving);
    if (next.every((b, i) => b.id === prev[i]?.id)) {
      showReorderNotice("移动未执行：目标位置与当前位置相同。");
      return false;
    }
    const normalized = normalizeScriptMarkerInvariants(
      next,
      scenesRef.current,
      scriptConfigRef.current,
      getMarkerChange(prev, next, movingIds),
    );
    const normalizedNext = normalized.blocks;
    const movedStartIndex = normalizedNext.findIndex((block) => movingIds.has(block.id));
    const movingHasMarker = moving.some(isMarkerBlock);
    const firstMovedOwnerMarkerId = normalizedNext[movedStartIndex].ownerMarkerId ?? null;
    const movedTextOwnershipChanged = !movingHasMarker && moving.some((block, offset) => {
      const beforeIdx = blockIndexByIdRef.current.get(block.id);
      const before = beforeIdx === undefined ? null : ownedBlocksRef.current[beforeIdx];
      return (before?.ownerMarkerId ?? null) !== (normalizedNext[movedStartIndex + offset]?.ownerMarkerId ?? null);
    });

    requestLargeSelectionOperation("move", moving.length, () => {
      saveSnapshot();
      for (const id of movingIds) pendingMovedBlockIdsRef.current.add(id);
      markBlockStructureDirty(prev, normalizedNext, movingIds);
      pendingVirtualScrollAnchorRef.current = null;
      pendingNavigateRef.current = null;
      postNavCorrectionRef.current = null;
      requestVirtualWindowRefresh();
      pendingMoveCenterRef.current = moving[0].id;
      if (movingHasMarker) {
        if (!sameSceneRows(normalized.scenes, scenesRef.current)) {
          setScenes(normalized.scenes);
          setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
        }
        syncOpeningChapterMarkerId(normalizedNext);
      }
      setBlocks(normalizedNext);
      const movedBlockIds: string[] = [];
      const movedRehearsalMarkerIds: string[] = [];
      const movedNonRehearsalIds: string[] = [];
      for (const block of moving) {
        movedBlockIds.push(block.id);
        if (block.type === "rehearsal_marker") movedRehearsalMarkerIds.push(block.id);
        else movedNonRehearsalIds.push(block.id);
      }
      glowChangedBlocks(movedNonRehearsalIds);
      movedRehearsalMarkerIds.forEach(glowTocMarker);
      const movedEndBlockId = movedBlockIds[movedBlockIds.length - 1];
      const movedEndBlock = normalizedNext.find((block) => block.id === movedEndBlockId);
      selectionAnchorBlockIdRef.current = moving[0]?.id ?? null;
      selectionDetachedRef.current = false;
      markerEndedScopeIdsRef.current = movedEndBlock && isMarkerBlock(movedEndBlock)
        ? new Set([movedEndBlock.id])
        : new Set();
      setInvalidSelectionEndIds((current) => current.size === 0 ? current : new Set());
      setSelectedBlockIds(new Set(movedBlockIds));
      if (movingHasMarker) {
        showSelectionChangeNotice("章节标记/段落标记/排练记号已更新。");
      } else if (movedTextOwnershipChanged) {
        const context = firstMovedOwnerMarkerId
          ? markerContextById.get(firstMovedOwnerMarkerId) ?? null
          : null;
        const scene = context?.sceneId ? sceneById.get(context.sceneId) : null;
        const sceneLabel = scene
          ? [scene.number.trim(), scene.name.trim()].filter(Boolean).join("-") || "（未命名）"
          : "（无章节）";
        const markLabel = context?.rehearsalId
          ? rehearsalLabels.rehearsalLabelByMarkerId.get(context.rehearsalId) ?? "(空)"
          : "(空)";
        showSelectionChangeNotice(`当前 ${moving.length} 行的章节与排练记号已更改为：${sceneLabel}-${markLabel}`);
      }
      unlockReorderAfterCommit();
    }, unlockReorder);
    return true;
  }, [glowChangedBlocks, glowTocMarker, markBlockStructureDirty, markerContextById, rehearsalLabels.rehearsalLabelByMarkerId, requestLargeSelectionOperation, requestVirtualWindowRefresh, saveSnapshot, sceneById, showReorderNotice, showSelectionChangeNotice, syncOpeningChapterMarkerId, unlockReorder, unlockReorderAfterCommit, isLockedMode]);

  const isNoopDragTarget = useCallback((fromIds: string[], target: DragTarget): boolean => {
    const movingIds = new Set(fromIds);
    if (movingIds.size === 0) return true;
    const currentBlocks = blocksRef.current;
    const resolvedTarget = resolveDragTarget(target, currentBlocks, windowRangeRef.current);
    if (!resolvedTarget) return true;
    const rawInsertIdx = getDragInsertIndex(resolvedTarget, currentBlocks);
    if (rawInsertIdx < 0) return true;
    const remaining = currentBlocks.filter((b) => !movingIds.has(b.id));
    const removedBeforeInsert = currentBlocks
      .slice(0, rawInsertIdx)
      .filter((b) => movingIds.has(b.id)).length;
    const insertIdx = Math.max(0, Math.min(remaining.length, rawInsertIdx - removedBeforeInsert));
    const next = [...remaining];
    next.splice(insertIdx, 0, ...currentBlocks.filter((b) => movingIds.has(b.id)));
    return next.every((b, i) => b.id === currentBlocks[i]?.id);
  }, []);

  const getDragTargetFromClientY = useCallback((clientY: number): DragTarget | null => {
    const container = blocksContainerRef.current;
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-bwrap]"));
    if (rows.length === 0) return null;

    const firstRect = rows[0].getBoundingClientRect();
    const lastRect = rows[rows.length - 1].getBoundingClientRect();
    if (clientY < firstRect.top) return { kind: "edge", edge: "top" };
    if (clientY > lastRect.bottom) return { kind: "edge", edge: "bottom" };

    const currentBlocks = blocksRef.current;
    let insertIdx = currentBlocks.length;
    const blockIndexById = blockIndexByIdRef.current;
    for (const row of rows) {
      const id = row.dataset.bwrap;
      if (!id) continue;
      const idx = blockIndexById.get(id);
      if (idx === undefined) continue;
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertIdx = idx;
        break;
      }
      insertIdx = idx + 1;
    }

    if (currentBlocks.length === 0) return null;
    const target = insertIdx >= currentBlocks.length
      ? { kind: "block" as const, id: currentBlocks[currentBlocks.length - 1].id, position: "after" as const }
      : { kind: "block" as const, id: currentBlocks[insertIdx].id, position: "before" as const };
    if (isNoopDragTarget(draggingBlockIds.current, target)) {
      dragInvalidReasonRef.current = "移动未执行：目标位置与当前位置相同。";
      return null;
    }
    dragInvalidReasonRef.current = null;
    return target;
  }, [isNoopDragTarget]);

  const updateDragTargetFromClientY = useCallback((clientY: number): DragTarget | null => {
    const nextTarget = getDragTargetFromClientY(clientY);
    dragTargetRef.current = nextTarget;
    setDragTarget((current) => (sameDragTarget(current, nextTarget) ? current : nextTarget));
    return nextTarget;
  }, [getDragTargetFromClientY]);

  const setEdgeDragTarget = useCallback((edge: "top" | "bottom") => {
    const nextTarget: DragTarget = { kind: "edge", edge };
    dragTargetRef.current = nextTarget;
    setDragTarget((current) => (sameDragTarget(current, nextTarget) ? current : nextTarget));
    dragInvalidReasonRef.current = null;
  }, []);

  const clearDragTarget = useCallback(() => {
    dragTargetRef.current = null;
    setDragTarget(null);
  }, []);

  const handleEdgeSpacerDragOver = useCallback((e: DragEvent<HTMLDivElement>, edge: "top" | "bottom") => {
    if (isLockedMode) return;
    if (isReorderLockedRef.current) return;
    if (!draggingBlockId.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setEdgeDragTarget(edge);
  }, [setEdgeDragTarget, isLockedMode, isReorderLockedRef]);

  const handleEdgeSpacerDrop = useCallback((e: DragEvent<HTMLDivElement>, edge: "top" | "bottom") => {
    if (isLockedMode) return;
    if (isReorderLockedRef.current) return;
    if (!draggingBlockId.current && draggingBlockIds.current.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    lockReorder();
    dropHandledRef.current = true;
    const draggedIds = draggingBlockIds.current.length
      ? draggingBlockIds.current
      : e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
    const target: DragTarget = { kind: "edge", edge };
    draggingBlockId.current = null;
    draggingBlockIds.current = [];
    clearDragTarget();
    clearDragCountBadge();
    setScriptDragging(false);
    dragInvalidReasonRef.current = null;
    const moved = moveDraggedBlocks(draggedIds, target);
    if (!moved) unlockReorder();
  }, [clearDragCountBadge, clearDragTarget, lockReorder, moveDraggedBlocks, setScriptDragging, unlockReorder, isLockedMode, isReorderLockedRef]);

  const insertBlockAt = useCallback((index: number) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate the new block ID outside the updater (Strict Mode double-invocation fix).
    const newBlockId = uid();
    // refId must also be determined outside the updater; read it from blocksRef.
    const previousBlocks = blocksRef.current;
    const insertIndex = Math.max(0, Math.min(index, previousBlocks.length));
    const refId = insertIndex > 0 ? (previousBlocks[insertIndex - 1]?.id ?? null) : null;
    const newBlock: Block = {
      ...makeBlock(),
      id: newBlockId,  // use the pre-generated stable ID
      sceneId: null,
      rehearsalMark: null,
    };
    const updated = [...previousBlocks];
    updated.splice(insertIndex, 0, newBlock);
    pendingCharOpen.current = newBlock.id;
    applyBlockStructureEdit(previousBlocks, updated, markerChangeFromOperations([{
      kind: "insert",
      position: insertIndex,
      blockId: newBlock.id,
      beforeType: null,
      afterType: newBlock.type,
    }]));
    if (refId) inheritTags(refId, newBlockId);
  }, [applyBlockStructureEdit, saveSnapshot, inheritTags, isLockedMode]);

  const addChar = (name: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => [...prev, { id: uid(), name, isAggregate: false }]);
  };

  const removeChar = (charId: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    markPageMapDirty("full");
    setBlocks((prev) =>
      prev.map((b) => {
        const restAnnotations = { ...b.characterAnnotations };
        delete restAnnotations[charId];
        return { ...b, characterIds: b.characterIds.filter((id) => id !== charId), characterAnnotations: restAnnotations };
      })
    );
  };

  const renameChar = (charId: string, name: string) =>
    !isLockedMode && setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? { ...c, name } : c))
    );

  const runSceneMenuMutation = async (request: () => Promise<Response>, failureMessage: string) => {
    try {
      if (!await flushPendingPatch()) throw new Error("剧本尚未保存，请稍后重试。");
      const response = await request();
      if (!response.ok) throw new Error(failureMessage);
      await reloadScriptState();
    } catch (error) {
      showReorderNotice(error instanceof Error ? error.message : failureMessage);
    }
  };

  const addScene = async (
    parentId?: string,
    target?: { insertAfterSceneId?: string; insertBeforeSceneId?: string }
  ) => {
    if (isLockedMode || !productionId || !canEditMetadata) return;
    const payload = activeVersionId
      ? { name: "", parentId: parentId ?? null, versionId: activeVersionId, ...target }
      : { name: "", parentId: parentId ?? null, ...target };
    await runSceneMenuMutation(
      () => createScene(productionId, payload),
      "添加章节失败，请稍后重试。"
    );
  };

  const updateScene = async (id: string, name: string) => {
    if (isLockedMode || !productionId || !canEditMetadata) return;
    await runSceneMenuMutation(
      () => renameScene(productionId, id, activeVersionId ? { name, versionId: activeVersionId } : { name }),
      "更新章节失败，请稍后重试。"
    );
  };

  const removeScene = async (id: string) => {
    if (isLockedMode || !productionId || !canEditMetadata) return;
    try {
      if (!await flushPendingPatch()) throw new Error("剧本尚未保存，请稍后重试。");
      const request = (operation?: MarkerDeleteOperation["type"]) => deleteScene(productionId, id, { ...(activeVersionId ? { versionId: activeVersionId } : {}), ...(operation ? { operation } : {}) });
      const response = await request();
      const data = response.data as { plan?: MarkerDeleteDialogState["plan"]; error?: string };
      if ((response.status === 300 && data.plan?.status === "choice") || (response.status === 409 && data.plan?.status === "blocked")) {
        setMarkerDeleteDialog({ plan: data.plan, source: "server" });
        return;
      }
      if (!response.ok) {
        setMarkerDeleteDialog({ plan: null, message: data.error ?? "删除章节失败，请稍后重试。", source: "server" });
        return;
      }
      await reloadScriptState();
    } catch (error) {
      setMarkerDeleteDialog({
        plan: null,
        message: error instanceof Error ? error.message : "删除章节失败，请稍后重试。",
        source: "server",
      });
    }
  };

  const applyServerMarkerDeleteOperation = async (operation: MarkerDeleteOperation) => {
    if (!productionId) return;
    setMarkerDeleteDialogBusy(true);
    try {
      const response = await deleteScene(productionId, operation.markerId, { ...(activeVersionId ? { versionId: activeVersionId } : {}), operation: operation.type });
      const data = response.data as { plan?: MarkerDeleteDialogState["plan"]; error?: string };
      if (!response.ok) {
        setMarkerDeleteDialog({ plan: null, message: data.error ?? "删除章节失败，请稍后重试。", source: "server" });
        return;
      }
      await reloadScriptState();
      setMarkerDeleteDialog(null);
    } finally {
      setMarkerDeleteDialogBusy(false);
    }
  };

  const patchSceneMeta = async (id: string, fields: Partial<SceneMetaFields>) => {
    if (!productionId || !canEditMetadata) return;
    const ok = await patchSceneMetadata(productionId, id, activeVersionId ? { ...fields, versionId: activeVersionId } : fields);
    if (!ok) throw new Error("Failed to update scene metadata");
    setSceneDetails((prev) => prev.map((scene) => (scene.id === id ? { ...scene, ...fields } : scene)));
  };

  const commentPanelNavigationTargets = useMemo(
    () => findSideBlockPanelNavigationTargets(
      blocks,
      activeCommentBlockId,
      blockId => (commentsByBlockId.get(blockId)?.length ?? 0) > 0,
    ),
    [activeCommentBlockId, blocks, commentsByBlockId],
  );
  const assetPanelNavigationTargets = useMemo(
    () => findSideBlockPanelNavigationTargets(
      blocks,
      activeAssetBlockId,
      blockId => (blockAssetsByBlockId.get(blockId)?.length ?? 0) > 0,
    ),
    [activeAssetBlockId, blocks, blockAssetsByBlockId],
  );
  const navigateSidePanelBlock = useCallback((kind: "comment" | "asset", direction: -1 | 1) => {
    const targets = kind === "comment" ? commentPanelNavigationTargets : assetPanelNavigationTargets;
    const nextBlockId = direction === -1 ? targets.previousBlockId : targets.nextBlockId;
    if (!nextBlockId) return;

    openBlockSidePanel(kind, nextBlockId);

    const blockIndex = blocksRef.current.findIndex(block => block.id === nextBlockId);
    if (blockIndex >= 0) scrollToBlockIdx(blockIndex, "center");
  }, [
    assetPanelNavigationTargets,
    commentPanelNavigationTargets,
    openBlockSidePanel,
    scrollToBlockIdx,
  ]);

  if (loadState === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center bg-[var(--paper)]">
        <span className="text-sm text-zinc-400">加载中...</span>
      </div>
    );
  }

  if (loadState === "not-found") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-[var(--paper)]">
        <p className="text-sm font-medium text-zinc-500">找不到文档</p>
        <p className="text-xs text-zinc-400">ID：{scriptId}</p>
        <Link href={productionId ? `/production/${productionId}` : "/"} className="mt-2 text-xs text-zinc-400 underline hover:text-zinc-600">
          返回
        </Link>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-[var(--paper)]">
        <p className="text-sm font-medium text-zinc-500">加载失败</p>
        {loadError && (
          <p className="max-w-sm whitespace-pre-wrap text-center text-xs text-zinc-400">
            {loadError}
          </p>
        )}
        <Link href={productionId ? `/production/${productionId}` : "/"} className="mt-2 text-xs text-zinc-400 underline hover:text-zinc-600">
          返回
        </Link>
      </div>
    );
  }

  const selectionNotice = selectedBlockIds.size > 1
    ? `已选中 ${selectedBlockIds.size} 行`
    : "";
  const safeWindowStart = blocks.length === 0
    ? 0
    : Math.min(windowRange.start, Math.max(0, blocks.length - 1));
  const safeWindowEnd = blocks.length === 0
    ? 0
    : Math.min(Math.max(windowRange.end, safeWindowStart + 1), blocks.length);
  const largeSelectionNotice = selectedBlockIds.size > LARGE_SELECTION_BLOCK_THRESHOLD
    ? "当前选中行数已超过 500 行，继续操作可能导致页面卡顿。"
    : "";
  const shiftSelectionNotice = shiftKeyDown && selectedBlockIds.size > 0
    ? "连续多选模式"
    : "";
  const edgeDragNotice = dragTarget?.kind === "edge"
    ? (dragTarget.edge === "top"
      ? "拖拽至此释放以移动至更上方区域"
      : "拖拽至此释放以移动至更下方区域")
    : "";
  const rootFontSizePx = typeof window === "undefined"
    ? 16
    : parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const scriptTocNumberWidths = measureScriptTocNumberWidths(tocScenes, rootFontSizePx);
  const scriptTocRailFullWidthPx = SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM * rootFontSizePx;
  const scriptTocRailCompactWidthPx = Math.max(
    scriptTocNumberWidths.chapterNumberSlotWidthPx,
    scriptTocNumberWidths.sceneNumberSlotWidthPx,
  ) + (SCRIPT_TOC_RAIL_COMPACT_NUMBER_PADDING_REM + SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM) * rootFontSizePx;
  const scriptSceneDetailRailMinWidthPx = SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM * rootFontSizePx;
  const canShowSceneDetail = productionSidebarReservedWidth > 0
    && workspaceWidth >= (
      SCRIPT_EDITOR_MAX_WIDTH_PX + scriptTocRailCompactWidthPx + scriptSceneDetailRailMinWidthPx
    );
  const isSceneDetailRequested = !!productionId && display.sceneDetail;
  const isSceneDetailVisible = isSceneDetailRequested && canShowSceneDetail;
  const centeredScriptWidthPx = Math.min(workspaceWidth, SCRIPT_EDITOR_MAX_WIDTH_PX);
  const centeredLeftPanelWidthPx = Math.max(
    0,
    (workspaceWidth - centeredScriptWidthPx) / 2,
  );
  const detailReservedContentsWidthPx = Math.max(
    0,
    workspaceWidth - centeredScriptWidthPx - scriptSceneDetailRailMinWidthPx,
  );
  const fullContentsPanelAvailableWidthPx = isSceneDetailRequested
    ? detailReservedContentsWidthPx
    : centeredLeftPanelWidthPx;
  const compactContentsPanelAvailableWidthPx = isSceneDetailVisible
    ? detailReservedContentsWidthPx
    : centeredLeftPanelWidthPx;
  const scriptTocRailMode: "full" | "compact" | null =
    productionSidebarReservedWidth >= SCRIPT_PRODUCTION_SIDEBAR_FULL_WIDTH_PX
      || workspaceWidth === 0
      || fullContentsPanelAvailableWidthPx >= scriptTocRailFullWidthPx
      ? "full"
      : compactContentsPanelAvailableWidthPx + SCRIPT_BODY_HORIZONTAL_PADDING_REM * rootFontSizePx
          >= scriptTocRailCompactWidthPx
        ? "compact"
        : null;
  const tocAsideWidthPx = scriptTocRailMode === "compact"
    ? scriptTocRailCompactWidthPx
    : scriptTocRailFullWidthPx;
  const renderedLeftPanelWidthPx = isSceneDetailVisible
    ? scriptTocRailMode ? tocAsideWidthPx : 0
    : centeredLeftPanelWidthPx;
  const availableRightGutterWidthPx = Math.max(
    0,
    workspaceWidth - renderedLeftPanelWidthPx - centeredScriptWidthPx,
  );
  const rightGutterWidthPx = isSceneDetailVisible
    ? Math.min(
        availableRightGutterWidthPx,
        SCRIPT_SCENE_DETAIL_RAIL_MAX_WIDTH_PX + SCRIPT_SCENE_DETAIL_RAIL_RIGHT_INSET_PX,
      )
    : availableRightGutterWidthPx;
  const scriptBodyWidthPx = Math.max(
    0,
    workspaceWidth - renderedLeftPanelWidthPx - rightGutterWidthPx,
  );
  const tocAsideStyle: React.CSSProperties = {
    width: `${tocAsideWidthPx}px`,
    marginLeft: `${Math.max(
      0,
      renderedLeftPanelWidthPx - tocAsideWidthPx + SCRIPT_BODY_HORIZONTAL_PADDING_REM * rootFontSizePx,
    )}px`,
  };
  const sceneDetailAsideWidthPx = Math.min(
    SCRIPT_SCENE_DETAIL_RAIL_MAX_WIDTH_PX,
    Math.max(
      scriptSceneDetailRailMinWidthPx,
      rightGutterWidthPx - SCRIPT_SCENE_DETAIL_RAIL_RIGHT_INSET_PX,
    ),
  );
  const sceneDetailAsideStyle: React.CSSProperties = {
    width: `${sceneDetailAsideWidthPx}px`,
    marginRight: `${Math.max(0, rightGutterWidthPx - sceneDetailAsideWidthPx)}px`,
  };
  const sceneIdForBlockAtIndex = (block: Block, index: number): string | null => {
    const markerId = isMarkerBlock(block) ? block.id : (ownedBlocks[index] ?? block).ownerMarkerId;
    return markerId ? markerContextById.get(markerId)?.sceneId ?? null : null;
  };
  const sceneIdForBlockId = (blockId: string | null | undefined): string | null => {
    if (!blockId) return null;
    const cachedIndex = blockIndexByIdRef.current.get(blockId) ?? -1;
    const blockIndex = blocks[cachedIndex]?.id === blockId
      ? cachedIndex
      : blocks.findIndex((block) => block.id === blockId);
    return blockIndex >= 0 ? sceneIdForBlockAtIndex(blocks[blockIndex], blockIndex) : null;
  };
  const markerDeleteConfirmBlockIndex = markerDeleteConfirmBlockId
    ? blockIndexByIdRef.current.get(markerDeleteConfirmBlockId)
    : undefined;
  const markerDeleteConfirmBlock = markerDeleteConfirmBlockIndex === undefined
    ? null
    : blocks[markerDeleteConfirmBlockIndex] ?? null;
  const markerDeleteConfirmDetailSceneId = isSceneDetailVisible
    && markerDeleteConfirmBlockIndex !== undefined
    && markerDeleteConfirmBlock && (
    markerDeleteConfirmBlock.type === "chapter_marker" || markerDeleteConfirmBlock.type === "scene_marker"
  )
    ? sceneIdForBlockAtIndex(markerDeleteConfirmBlock, markerDeleteConfirmBlockIndex)
    : null;
  const detailSceneId = isSceneDetailVisible
    ? markerDeleteConfirmDetailSceneId ?? (
        selectedBlockIds.size > 1
          ? null
          : (selectedBlockIds.size === 1 && detailBlockVisibility.selected
              ? sceneIdForBlockId(selectedDetailBlockId)
              : null)
            ?? (detailBlockVisibility.focused ? sceneIdForBlockId(focusedId) : null)
            ?? activeSceneId
      )
    : null;
  const activeScene = detailSceneId ? sceneById.get(detailSceneId) ?? null : null;
  const activeSceneDetail = activeScene
    ? sceneDetailById.get(activeScene.id) ?? toSceneDetail(activeScene)
    : null;
  const commentBubbleMode = workspaceWidth === 0
    ? null
    : isSceneDetailVisible ? "full" : scriptTocRailMode;
  const blockSidePanelWidthPx = isSceneDetailVisible
    ? sceneDetailAsideWidthPx
    : SIDE_PANEL_FALLBACK_WIDTH_PX;
  const commentBubbleWidthPx = commentBubbleMode === "compact"
    ? scriptTocRailCompactWidthPx - COMMENT_BUBBLE_GAP_REM * rootFontSizePx
    : Math.max(
        COMMENT_BUBBLE_MIN_WIDTH_PX,
        rightGutterWidthPx - COMMENT_BUBBLE_GAP_REM * rootFontSizePx,
      );
  const activeCommentBlockIndex = activeCommentBlockId
    ? blocks.findIndex(block => block.id === activeCommentBlockId)
    : -1;
  const activeCommentBlockLineNumber = activeCommentBlockId
    ? scriptLineNumberByBlockId.get(activeCommentBlockId)
    : undefined;
  const activeCommentBlockCaption = activeCommentBlockIndex >= 0 && activeCommentBlockLineNumber !== undefined
    ? buildCommentBlockCaption(blocks[activeCommentBlockIndex], characters, activeCommentBlockLineNumber)
    : null;
  const activeAssetBlockIndex = activeAssetBlockId
    ? blocks.findIndex(block => block.id === activeAssetBlockId)
    : -1;
  const activeAssetBlockLineNumber = activeAssetBlockId
    ? scriptLineNumberByBlockId.get(activeAssetBlockId)
    : undefined;
  const activeAssetBlockCaption = activeAssetBlockIndex >= 0 && activeAssetBlockLineNumber !== undefined
    ? buildCommentBlockCaption(blocks[activeAssetBlockIndex], characters, activeAssetBlockLineNumber)
    : null;
  const dragInstructionNotice = !edgeDragNotice && (isScriptDragging || isReorderLocked)
      ? "拖拽当前剧本块至指定位置松开以调整位置"
      : "";
  const rightMenuClass = `${
    toolbarCompact
      ? ""
      : "absolute right-0 top-full"
  } ${toolbarCompact ? "" : "mt-2.5"} z-40 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md`;
  const selfPresence: RemotePresence | null = clientId
    ? {
        clientId,
        userName: userName || "?",
        color: presenceColor(clientId),
        blockId: null,
      }
    : null;
  const onlineUsers = [
    ...Array.from(presenceMap.values()).filter((presence) => presence.clientId !== clientId),
    ...(selfPresence ? [selfPresence] : []),
  ];
  const renderPresenceStack = (maxVisibleAvatars: number) => {
    const overflowCount = onlineUsers.length > maxVisibleAvatars
      ? onlineUsers.length - maxVisibleAvatars + 1
      : 0;
    const visibleUsers = overflowCount > 0
      ? onlineUsers.slice(0, maxVisibleAvatars - 1)
      : onlineUsers;
    return (
      <div className="flex flex-nowrap items-center">
        {visibleUsers.map((presence) => (
          <div key={presence.clientId} className={`-ml-1 first:ml-0 ${presence.clientId === clientId ? "opacity-40" : ""}`}>
            <PresenceAvatar
              name={presence.userName}
              color={presence.color}
              title={presence.clientId === clientId ? `${presence.userName}（你）` : presence.userName}
            />
          </div>
        ))}
        {overflowCount > 0 && (
          <div className="-ml-1 first:ml-0">
            <div
              title={`另有 ${overflowCount} 位在线人员`}
              className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1 text-[10px] font-bold text-zinc-500"
            >
              +{overflowCount}
            </div>
          </div>
        )}
      </div>
    );
  };
  return (
    <div ref={setWorkspaceMeasureRef} className="bg-[var(--paper)]">
      {/* Toolbar */}
      <header className={searchOpen || jumpTarget
        ? "sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--surface)] shadow-sm"
        : "contents"
      }>
        <ScriptToolbarMenuController
          toolbarCompact={toolbarCompact}
          characterCloseBlocked={pendingAggregateFocusPrompt !== null}
          openMenuRef={toolbarOpenMenuRef}
          closeMenuRef={toolbarMenuCloseRef}
        >
          {({
            openMenu,
            setOpenMenu,
            toggleMenu,
            openNestedMenu,
            handleCharacterPanelOpenChange,
            scriptMenuPosition,
            nestedMenuPosition,
          }) => {
            const toolbarOverflow = toolbarCompact ? (
              <>
                {presenceFolded && onlineUsers.length > 0 && (
                  <div className="border-b border-zinc-100">
                    <ProductionOverflowSubmenuButton
                      menuId="presence"
                      label={<span className="text-[10px] font-medium tracking-wide text-zinc-400">当前在线</span>}
                      detail={renderPresenceStack(4)}
                      expanded={openMenu === "presence"}
                      onToggle={(anchor) => openNestedMenu("presence", anchor)}
                    />
                  </div>
                )}
                {canEditMetadata && (
                  <ProductionOverflowSubmenuButton
                    menuId="scene"
                    label="章节"
                    expanded={openMenu === "scene"}
                    onToggle={(anchor) => openNestedMenu("scene", anchor)}
                  />
                )}
                {(canEditMetadata || isLockedMode) && (
                  <ProductionOverflowSubmenuButton
                    menuId="char"
                    label="角色"
                    expanded={openMenu === "char"}
                    onToggle={(anchor) => openNestedMenu("char", anchor)}
                  />
                )}
                <ProductionOverflowSubmenuButton
                  menuId="edit"
                  label={isLockedMode ? "查找" : "编辑"}
                  expanded={openMenu === "edit"}
                  onToggle={(anchor) => openNestedMenu("edit", anchor)}
                />
                <ProductionOverflowSubmenuButton
                  menuId="display"
                  label="显示"
                  expanded={openMenu === "display"}
                  onToggle={(anchor) => openNestedMenu("display", anchor)}
                />
                <ProductionOverflowSubmenuButton
                  menuId="export"
                  label="导出"
                  expanded={openMenu === "export"}
                  onToggle={(anchor) => openNestedMenu("export", anchor)}
                />
              </>
            ) : null;

            return (
        <ProductionTopMenu
          barRef={setToolbarElement}
          fallbackClassName="gap-0 px-6"
          overflow={toolbarOverflow}
        >
          {(portaled) => (
            <>
          {productionName && (
            <>
              <div className="flex shrink-0 flex-col" style={{ lineHeight: 1.2 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--script)", whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {productionName}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>剧本</span>
              </div>
              <ProductionTopMenuDivider />
            </>
          )}
          {!isLockedMode && (
            <>

              {/* 剧本菜单 — 关于 + 元数据设置 */}
              <div className="relative -ml-1 shrink-0">
                <button
                  ref={scriptMenuPosition.anchorRef}
                  data-script-toolbar-menu-trigger="script"
                  onClick={() => toggleMenu("script")}
                  className="flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
                >
                  剧本 <ChevronIcon size={12} className="opacity-50" />
                </button>
                {openMenu === "script" && (
                  <div
                    data-script-toolbar-menu-panel="script"
                    ref={scriptMenuPosition.menuRef}
                    style={scriptMenuPosition.style}
                    className="z-40 w-52 rounded-xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md"
                  >
                    <button
                      onClick={() => { setAboutOpen(true); setOpenMenu(null); }}
                      className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      关于
                    </button>
                    <div className="group/display-option relative">
                      <button
                        onClick={() => {
                          if (openingChapterMustBeVisible) return;
                          void saveScriptConfig({ showOpeningChapter: !scriptConfig.showOpeningChapter });
                        }}
                        aria-disabled={openingChapterMustBeVisible}
                        aria-describedby={openingChapterMustBeVisible ? "opening-chapter-in-use-notice" : undefined}
                        className={`peer flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                          openingChapterMustBeVisible ? DISABLED_CHECKBOX_OPTION_CLASS : "text-zinc-600 hover:bg-zinc-50"
                        }`}
                      >
                        <span>显示开场</span>
                        <span className={checkboxOptionClass(openingChapterVisible)}>✓</span>
                      </button>
                      {openingChapterMustBeVisible && (
                        <span
                          id="opening-chapter-in-use-notice"
                          role="tooltip"
                          className="pointer-events-none invisible absolute right-2 top-full z-50 mt-1 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-[11px] font-normal text-white opacity-0 shadow-md transition-opacity group-hover/display-option:visible group-hover/display-option:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100"
                        >
                          开场下已有段落或排练记号，必须显示
                        </span>
                      )}
                    </div>
                    <div className="group/display-option relative">
                      <button
                        onClick={() => {
                          if (rehearsalMarksCannotBeDisabled) return;
                          void saveScriptConfig({ useRehearsalMarks: !scriptConfig.useRehearsalMarks });
                        }}
                        aria-disabled={rehearsalMarksCannotBeDisabled}
                        aria-describedby={rehearsalMarksCannotBeDisabled
                          ? "rehearsal-marks-in-use-notice"
                          : undefined}
                        className={`peer flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                          rehearsalMarksCannotBeDisabled ? DISABLED_CHECKBOX_OPTION_CLASS : "text-zinc-600 hover:bg-zinc-50"
                        }`}
                      >
                        <span>使用排练记号</span>
                        <span className={checkboxOptionClass(scriptConfig.useRehearsalMarks)}>✓</span>
                      </button>
                      {rehearsalMarksCannotBeDisabled && (
                        <span
                          id="rehearsal-marks-in-use-notice"
                          role="tooltip"
                          className="pointer-events-none invisible absolute right-2 top-full z-50 mt-1 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-[11px] font-normal text-white opacity-0 shadow-md transition-opacity group-hover/display-option:visible group-hover/display-option:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100"
                        >
                          无法禁用，当前剧本存在排练记号 {firstRehearsalMarkerLabel}
                        </span>
                      )}
                    </div>
                    <div className="my-1 border-t border-zinc-50" />
                    <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">段内舞台提示</p>
                    {(
                      [
                        ["（", "）", "（台词内）"],
                        ["【", "】", "【台词内】"],
                      ] as [string, string, string][]
                    ).map(([open, close, label]) => (
                      <button
                        key={open}
                        onClick={() => requestStageDelimiterChange(open, close)}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${scriptConfig.stageDelimOpen === open ? "font-medium text-zinc-800" : "text-zinc-500"}`}
                      >
                        <span>{label}</span>
                        {scriptConfig.stageDelimOpen === open && <span className="text-[10px] text-zinc-400">✓</span>}
                      </button>
                    ))}
                    <div className="my-1 border-t border-zinc-50" />
                    <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">页面类型</p>
                    {(
                      [
                        ["a4",         "A4"],
                        ["letter",     "Letter"],
                        ["a3-2col",    "A3 横排双排"],
                        ["tablet-2col","Tablet 横排双排"],
                      ] as [import("@/lib/script/script-types").PageLayout, string][]
                    ).map(([layout, label]) => (
                      <button
                        key={layout}
                        onClick={() => { saveScriptConfig({ pageLayout: layout }); setOpenMenu(null); }}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${scriptConfig.pageLayout === layout ? "font-medium text-zinc-800" : "text-zinc-500"}`}
                      >
                        <span>{label}</span>
                        {scriptConfig.pageLayout === layout && <span className="text-[10px] text-zinc-400">✓</span>}
                      </button>
                    ))}
                    {productionId && (
                      <>
                        <div className="my-1 border-t border-zinc-50" />
                        <button
                          onClick={() => { setTagEditorOpen(true); setTagEditorOnTop(true); setOpenMenu(null); }}
                          className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                        >
                          标签设置…
                        </button>
                        <div className="my-1 border-t border-zinc-50" />
                        <button
                          onClick={requestEmptyScriptCleanup}
                          className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                        >
                          清除空白内容
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <span className={`${canEdit ? "ml-[3px]" : "ml-0.5"} shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-400`}>
            {canEdit ? "可编辑" : "只读"}
          </span>
          {baseCanEdit && isLockedMode && (
            <div
              className="flex flex-1 justify-center"
            >
              <button
                onClick={toggleLockedMode}
                data-production-toolbar-flex-content="true"
                aria-pressed={isLockedMode}
                style={toolbarShort || toolbarCompact ? undefined : REHEARSAL_SWITCH_OPTICAL_OFFSET_STYLE}
                title="退出排练模式"
                className="flex shrink-0 items-center gap-2 rounded px-2 py-1 text-sm font-medium transition-colors text-teal-600 hover:bg-teal-50 hover:text-teal-700 whitespace-nowrap"
              >
                <ModeSwitch active={isLockedMode} />
                <span>{(toolbarShort || toolbarCompact) ? "排练" : "排练模式"}</span>
              </button>
            </div>
          )}
          <div className={`${PRODUCTION_TOP_MENU_RIGHT_CLASS} ${presenceFolded ? "absolute right-0 flex w-0 items-center" : "ml-auto flex shrink-0 items-center gap-1"}`}>
          <div className={`${toolbarCompact ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
          {(canEditMetadata || isLockedMode) && (
            <>
              {canEditMetadata && (
                <>
                  <ScenePanel
                    scenes={scenes}
                    productionId={productionId ?? ""}
                    onAdd={(parentId, target) => addScene(parentId, target)}
                    onUpdate={updateScene}
                    onRemove={removeScene}
                    open={openMenu === "scene"}
                    onOpenChange={(v) => setOpenMenu(v ? "scene" : null)}
                    canImport={canImport}
                    onNavigate={prepareForNavigation}
                    triggerClassName={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
                    nestedFromMore={toolbarCompact}
                    nestedMenuRef={nestedMenuPosition.menuRef}
                    nestedMenuStyle={nestedMenuPosition.style}
                    label={toolbarShort ? "章" : "章节"}
                  />
                  <div className={`${toolbarCompact || portaled ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
                </>
              )}
              <CharacterPanel
                characters={characters}
                productionId={productionId ?? ""}
                focusedCharacterIds={focusedCharacterIds}
                onToggleFocus={toggleCharacterFocus}
                onClearFocus={clearCharacterFocus}
                onAdd={addChar}
                onRemove={removeChar}
                onRename={renameChar}
                open={openMenu === "char"}
                onOpenChange={handleCharacterPanelOpenChange}
                onNavigate={prepareForNavigation}
                readOnly={isLockedMode}
                triggerClassName={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm transition-colors ${
                  openMenu === "char"
                    ? "bg-zinc-100 text-zinc-800"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                }`}
                nestedFromMore={toolbarCompact}
                nestedMenuRef={nestedMenuPosition.menuRef}
                nestedMenuStyle={nestedMenuPosition.style}
                label={toolbarShort ? "角" : "角色"}
              />
              <div className={`${toolbarCompact || portaled ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
            </>
          )}

          {/* 编辑菜单 — undo/redo + 格式 + 搜索/跳转 */}
          <div className="relative shrink-0">
            <button
              data-script-toolbar-menu-trigger="edit"
              onClick={() => toggleMenu("edit")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              {toolbarShort ? (isLockedMode ? "找" : "编") : (isLockedMode ? "查找" : "编辑")} <ChevronIcon size={12} className="opacity-50" />
            </button>
            {openMenu === "edit" && (
              <div
                data-script-toolbar-menu-panel="edit"
                data-production-overflow-menu-child={toolbarCompact ? "true" : undefined}
                ref={toolbarCompact ? nestedMenuPosition.menuRef : undefined}
                style={toolbarCompact ? nestedMenuPosition.style : undefined}
                className={`${rightMenuClass} w-44`}
              >
                {canEdit && (
                  <>
                    <button
                      onClick={() => { undo(); setOpenMenu(null); }}
                      disabled={!canUndo}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${canUndo ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"}`}
                    >
                      <span>撤销</span>
                      <Kbd combo="Mod+Z" className="text-[10px] text-zinc-300" />
                    </button>
                    <button
                      onClick={() => { redo(); setOpenMenu(null); }}
                      disabled={!canRedo}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${canRedo ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"}`}
                    >
                      <span>重做</span>
                      <Kbd combo="Mod+Shift+Z" className="text-[10px] text-zinc-300" />
                    </button>
                    <div className="my-1 border-t border-zinc-50" />
                    <button
                      onMouseDown={e => { e.preventDefault(); applyFormatToFocused("b"); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="font-bold">粗体</span>
                      <Kbd combo="Mod+B" className="text-[10px] text-zinc-300" />
                    </button>
                    <button
                      onMouseDown={e => { e.preventDefault(); applyFormatToFocused("u"); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="underline">下划线</span>
                      <Kbd combo="Mod+U" className="text-[10px] text-zinc-300" />
                    </button>
                    <button
                      onMouseDown={e => { e.preventDefault(); toggleStageCueToFocused(); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="italic text-zinc-400">切换舞台提示</span>
                      <Kbd combo="Mod+I" className="text-[10px] text-zinc-300" />
                    </button>
                    <div className="my-1 border-t border-zinc-50" />
                  </>
                )}
                <button
                  onClick={() => { setSearchOpen(true); setOpenMenu(null); }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  <span>搜索</span>
                  <Kbd combo="Mod+F" className="text-[10px] text-zinc-300" />
                </button>
                <button
                  onClick={() => { setJumpTarget("line"); setJumpValue(""); setOpenMenu(null); }}
                  className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  跳转到行…
                </button>
                <button
                  onClick={() => { setJumpTarget("page"); setJumpValue(""); setOpenMenu(null); }}
                  className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  跳转到页…
                </button>
              </div>
            )}
          </div>

          {/* 显示菜单 */}
          <div className="relative shrink-0">
            <button
              data-script-toolbar-menu-trigger="display"
              onClick={() => toggleMenu("display")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              {toolbarShort ? "显" : "显示"} <ChevronIcon size={12} className="opacity-50" />
            </button>
            {openMenu === "display" && (
              <div
                data-script-toolbar-menu-panel="display"
                data-production-overflow-menu-child={toolbarCompact ? "true" : undefined}
                ref={toolbarCompact ? nestedMenuPosition.menuRef : undefined}
                style={toolbarCompact ? nestedMenuPosition.style : undefined}
                className={`${rightMenuClass} w-44`}
              >
                {(
                  [
                    ["pageBreaks",     "分页线"],
                    ["lineNumbers",    "行号"],
                    ["blockTags",      "Block 标签"],
                    ["rehearsalBlockScenes", "逐行章节"],
                    ["sceneDetail",    "构作详情"],
                  ] as [keyof Pick<DisplaySettings, "pageBreaks" | "lineNumbers" | "blockTags" | "rehearsalBlockScenes" | "sceneDetail">, string][]
                ).map(([key, label]) => {
                  if (key === "blockTags" && tagGroups.length === 0) return null;
                  if (key === "sceneDetail" && !productionId) return null;
                  const isSceneDetail = key === "sceneDetail";
                  const enabled = !isSceneDetail || canShowSceneDetail;
                  const active = enabled && display[key];
                  const disabledNotice = "当前窗口宽度过窄，无法显示构作详情";
                  const disabledNoticeId = "scene-detail-width-notice";
                  return (
                    <div key={key} className="group/display-option relative">
                      <button
                        onClick={() => { if (enabled) toggleDisplay(key); }}
                        aria-disabled={!enabled}
                        aria-describedby={!enabled ? disabledNoticeId : undefined}
                        title={key === "rehearsalBlockScenes" ? "显示每行所属章节" : undefined}
                        className={`peer flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                          enabled ? "text-zinc-600 hover:bg-zinc-50" : DISABLED_CHECKBOX_OPTION_CLASS
                        }`}
                      >
                        <span>{label}</span>
                        <span className={checkboxOptionClass(active)}>✓</span>
                      </button>
                      {!enabled && (
                        <span
                          id={disabledNoticeId}
                          role="tooltip"
                          className="pointer-events-none invisible absolute right-2 top-full z-50 mt-1 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-[11px] font-normal text-white opacity-0 shadow-md transition-opacity group-hover/display-option:visible group-hover/display-option:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100"
                        >
                          {disabledNotice}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="my-1 border-t border-zinc-50" />
                <button
                  onClick={() => {
                    if (!baseCanEditTextLayout) return;
                    pendingModeScrollAnchorRef.current = captureVirtualScrollAnchor();
                    saveScriptConfig({
                      textLayoutMode: scriptConfig.textLayoutMode === "compact" ? "center" : "compact",
                    });
                  }}
                  disabled={!baseCanEditTextLayout}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                    baseCanEditTextLayout ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"
                  }`}
                  title={baseCanEditTextLayout ? "保存为所有人共用的剧本排版模式" : "无权修改剧本排版模式"}
                >
                  <span>紧凑排版</span>
                  <span className="flex items-center">
                    <ModeSwitch
                      active={scriptConfig.textLayoutMode === "compact"}
                      activeClassName="bg-[#637ca1]" /* my signature color (darker version). ^v^ -- QPT */
                    />
                  </span>
                </button>
                {baseCanEdit && (
                  <>
                    <div className="my-1 border-t border-zinc-50" />
                    <button
                      onClick={toggleLockedMode}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span>排练模式</span>
                      <span className="flex items-center">
                        <ModeSwitch active={isLockedMode} />
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Online users: self (dimmed) + overflow menu */}
          <div className="relative shrink-0">
            {!presenceFolded && onlineUsers.length > 0 && (() => {
              const maxVisibleAvatars = toolbarShort || toolbarCompact
                ? 2
                : isLockedMode
                  ? REHEARSAL_MODE_VISIBLE_PRESENCE_AVATARS
                  : EDITABLE_MODE_VISIBLE_PRESENCE_AVATARS;
              const stack = renderPresenceStack(maxVisibleAvatars);
              if (onlineUsers.length <= maxVisibleAvatars) return stack;
              return (
                <button
                  type="button"
                  ref={toolbarCompact ? nestedMenuPosition.anchorRef : undefined}
                  data-script-toolbar-menu-trigger="presence"
                  onClick={(event) => {
                    if (toolbarCompact) openNestedMenu("presence", event.currentTarget);
                    else toggleMenu("presence");
                  }}
                  className="flex items-center rounded px-1 py-1 transition-colors hover:bg-zinc-100"
                  aria-label={`当前在线：${onlineUsers.length} 人`}
                  title={`当前在线：${onlineUsers.map((presence) => presence.clientId === clientId ? `${presence.userName}（你）` : presence.userName).join("、")}`}
                >
                  {stack}
                </button>
              );
            })()}
            {openMenu === "presence" && (
              <div
                data-script-toolbar-menu-panel="presence"
                data-production-overflow-menu-child={toolbarCompact ? "true" : undefined}
                ref={toolbarCompact ? nestedMenuPosition.menuRef : undefined}
                style={toolbarCompact ? nestedMenuPosition.style : undefined}
                className={`${rightMenuClass} w-44`}
              >
                <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">当前在线</p>
                {onlineUsers.map((presence) => (
                  <div key={presence.clientId} className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-600">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: presence.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {presence.userName}{presence.clientId === clientId ? "（你）" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 导出菜单 */}
          <div className="relative shrink-0">
            <button
              data-script-toolbar-menu-trigger="export"
              onClick={() => toggleMenu("export")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              导出 <ChevronIcon size={12} className="opacity-50" />
            </button>
            {openMenu === "export" && (
              <div
                data-script-toolbar-menu-panel="export"
                data-production-overflow-menu-child={toolbarCompact ? "true" : undefined}
                ref={toolbarCompact ? nestedMenuPosition.menuRef : undefined}
                style={toolbarCompact ? nestedMenuPosition.style : undefined}
                className={`${rightMenuClass} w-36`}
              >
                {/* 打印页现在是独立路由（#335）。新标签打开：印本子的人通常一边继续
                    改本子一边比对，同标签跳走会把编辑态一起带走。 */}
                <Link
                  href={`/production/${productionId}/script/print`}
                  target="_blank"
                  rel="noopener"
                  onClick={() => setOpenMenu(null)}
                  className="block w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  打印预览
                </Link>
              </div>
            )}
          </div>
          </div>
            </>
          )}
        </ProductionTopMenu>
            );
          }}
        </ScriptToolbarMenuController>

        {/* 搜索栏 */}
        {searchOpen && (
          <div className="border-t border-[var(--line)] bg-[var(--surface)] px-6 py-2 flex items-center gap-3">
            <input
              autoFocus
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0); }}
              onKeyDown={e => {
                if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); setSearchIdx(0); }
                if (e.key === "Enter") {
                  if (searchMatches.length === 0) return;
                  setSearchIdx(i => (i + 1) % searchMatches.length);
                }
              }}
              placeholder="搜索…"
              className="h-7 w-48 rounded border border-zinc-200 px-2 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
            />
            <span className="shrink-0 text-xs text-zinc-400">
              {searchMatches.length > 0 ? `${searchIdx + 1} / ${searchMatches.length}` : searchQuery.trim() ? "无结果" : ""}
            </span>
            <button
              onClick={() => setSearchIdx(i => i <= 0 ? searchMatches.length - 1 : i - 1)}
              disabled={searchMatches.length === 0}
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
            ><ChevronIcon direction="up" size={12} /></button>
            <button
              onClick={() => setSearchIdx(i => (i + 1) % searchMatches.length)}
              disabled={searchMatches.length === 0}
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
            ><ChevronIcon size={12} /></button>
            <div className="h-4 w-px bg-zinc-100" />
            <label className="flex items-center gap-1 cursor-pointer select-none text-xs text-zinc-400">
              <input type="checkbox" checked={searchExact} onChange={e => { setSearchExact(e.target.checked); setSearchIdx(0); }} className="h-3 w-3" />
              精确
            </label>
            <label className="flex items-center gap-1 cursor-pointer select-none text-xs text-zinc-400">
              <input type="checkbox" checked={searchCurrentPage} onChange={e => { setSearchCurrentPage(e.target.checked); setSearchIdx(0); }} className="h-3 w-3" />
              当页
            </label>
            <button
              onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
              className="ml-auto text-xs text-zinc-300 hover:text-zinc-500"
            >✕</button>
          </div>
        )}

        {/* 跳转弹窗 */}
        {jumpTarget && (
          <div className="border-t border-[var(--line)] bg-[var(--surface)] px-6 py-2 flex items-center gap-3">
            <span className="shrink-0 text-xs text-zinc-400">
              {jumpTarget === "line" ? "跳转到行" : "跳转到页"}
            </span>
            <input
              autoFocus
              type="number"
              min={1}
              max={jumpTarget === "line" ? scriptLineNumberByBlockId.size : Math.max(...Object.values(pageMap), 1)}
              value={jumpValue}
              onChange={e => setJumpValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") setJumpTarget(null);
                if (e.key === "Enter") {
                  const n = parseInt(jumpValue, 10);
                  if (!isNaN(n)) {
                    if (jumpTarget === "line") jumpToLine(n);
                    else jumpToPage(n);
                  }
                  setJumpTarget(null);
                }
              }}
              placeholder={jumpTarget === "line" ? `1–${scriptLineNumberByBlockId.size}` : `1–${Math.max(...Object.values(pageMap), 1)}`}
              className="h-7 w-28 rounded border border-zinc-200 px-2 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
            />
            <button
              onClick={() => {
                const n = parseInt(jumpValue, 10);
                if (!isNaN(n)) { if (jumpTarget === "line") jumpToLine(n); else jumpToPage(n); }
                setJumpTarget(null);
              }}
              className="rounded bg-zinc-800 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
            >
              跳转
            </button>
            <button onClick={() => setJumpTarget(null)} className="text-xs text-zinc-300 hover:text-zinc-500">取消</button>
          </div>
        )}
      </header>

      {edgeDragNotice && (
        <div
          className={`pointer-events-none fixed left-1/2 z-10 -translate-x-1/2 select-none text-center text-2xl font-semibold tracking-wide text-zinc-400/35 ${
            dragTarget?.kind === "edge" && dragTarget.edge === "top" ? "top-[5rem]" : "bottom-12"
          }`}
        >
          {edgeDragNotice}
        </div>
      )}

      {(dragInstructionNotice || reorderNotice || shiftSelectionNotice || selectionNotice || largeSelectionNotice || selectionChangeNotice) && (
        <div className="pointer-events-none fixed left-1/2 top-[4rem] z-50 flex -translate-x-1/2 flex-col items-center gap-1">
          {dragInstructionNotice ? (
            <div className="rounded bg-zinc-900/80 px-2 py-1 text-[11px] text-white shadow-sm">
              {dragInstructionNotice}
            </div>
          ) : reorderNotice ? (
            <div className="rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-800 shadow-sm">
              {reorderNotice}
            </div>
          ) : (
            <>
              {selectionNotice && (
                <div className="rounded bg-zinc-900/80 px-2 py-1 text-[11px] text-white shadow-sm">
                  {selectionNotice}
                </div>
              )}
              {largeSelectionNotice && (
                <div className="rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-800 shadow-sm">
                  {largeSelectionNotice}
                </div>
              )}
              {selectionChangeNotice && (
                <div className="rounded bg-zinc-900/80 px-2 py-1 text-[11px] text-white shadow-sm">
                  {selectionChangeNotice}
                </div>
              )}
              {shiftSelectionNotice && (
                <div className="rounded bg-zinc-900/80 px-2 py-1 text-[11px] text-white shadow-sm">
                  {shiftSelectionNotice}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div
        ref={dragCountBadgeRef}
        hidden
        className="pointer-events-none fixed z-50 rounded border bg-white/90 px-1.5 py-0.5 text-lg font-semibold leading-none tabular-nums shadow-sm"
        style={{ borderColor: "#91a8ca", color: "#91a8ca" }}
      />
      <style jsx global>{`
        @keyframes scriptBlockMovedGlow {
          0% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
          50% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0.14);
          }
          100% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
        }

        @keyframes scriptTocMarkerGlow {
          0% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
          38% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0.14);
          }
          62% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
          100% {
            background-color: var(--script-block-glow-fade-end, #ffffff);
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
        }

        .script-block-moved-glow {
          animation: scriptBlockMovedGlow 1s ease-in-out;
        }

        .script-toc-marker-glow {
          animation: scriptTocMarkerGlow 1.5s ease-out;
        }

      `}</style>

      {/* Document: 3-column flex — left gutter | script content | right gutter */}
      <div className="flex items-start">
        {/* Offset the script only while the scene detail panel is actually visible. */}
        <div
          className="hidden md:flex min-w-0 flex-col self-stretch"
          style={{ width: `${renderedLeftPanelWidthPx}px`, flexShrink: 0 }}
        >
          {scriptTocRailMode && (
            <aside
              style={tocAsideStyle}
              className="sticky top-0 h-[calc(44.444vh_-_1.778rem)] min-h-[14.667rem] max-h-[32rem]"
            >
              <TableOfContents
                scenes={tocScenes}
                blocks={legacyProjectedBlocks}
                onScrollToScene={scrollToScene}
                activeSceneId={activeSceneId}
                placement={scriptTocRailMode === "compact" ? "rail-compact" : "rail"}
                chapterNumberSlotWidthPx={scriptTocNumberWidths.chapterNumberSlotWidthPx}
                sceneNumberSlotWidthPx={scriptTocNumberWidths.sceneNumberSlotWidthPx}
              />
            </aside>
          )}
        </div>

        {/* Center column (script content) */}
        <main
          className="w-full flex-none min-w-0 px-4 py-8"
          style={{ maxWidth: scriptBodyWidthPx || SCRIPT_EDITOR_MAX_WIDTH_PX }}
        >
        <div className="relative min-h-[70vh] rounded-2xl bg-white shadow-sm flex flex-col pt-6 pb-8">
          {display.lineNumbers && (
            <>
              <span
                ref={lineIndexMeasureRef}
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 -z-10 select-none whitespace-pre tabular-nums text-[9px] leading-none opacity-0"
              >
                {maxLineIndexText}
              </span>
              <span
                ref={lineIndexMinMeasureRef}
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 -z-10 select-none whitespace-pre tabular-nums text-[9px] leading-none opacity-0"
              >
                0000
              </span>
            </>
          )}
          <TableOfContents scenes={tocScenes} blocks={legacyProjectedBlocks} onScrollToScene={scrollToScene} />
          <div
            ref={blocksContainerRef}
            onDragOver={(e) => {
              if (isReorderLockedRef.current) return;
              if (!draggingBlockId.current) return;
              if (draggingBlockIds.current.length > 1) {
                updateDragCountBadge(e.clientX, e.clientY, draggingBlockIds.current.length, e.buttons);
              }
              const nextTarget = updateDragTargetFromClientY(e.clientY);
              if (!nextTarget) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (isReorderLockedRef.current) return;
              if (!draggingBlockId.current && draggingBlockIds.current.length === 0) return;
              e.preventDefault();
              lockReorder();
              dropHandledRef.current = true;
              const draggedIds = draggingBlockIds.current.length
                ? draggingBlockIds.current
                : e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
              const target = updateDragTargetFromClientY(e.clientY) ?? dragTargetRef.current;
              draggingBlockId.current = null;
              draggingBlockIds.current = [];
              clearDragTarget();
              clearDragCountBadge();
              setScriptDragging(false);
              if (!target) {
                showReorderNotice(dragInvalidReasonRef.current ?? "移动失败：未释放到有效位置。");
                dragInvalidReasonRef.current = null;
                unlockReorder();
                return;
              }
              dragInvalidReasonRef.current = null;
              const moved = moveDraggedBlocks(draggedIds, target);
              if (!moved) unlockReorder();
            }}
          >
          {(() => {
            const hasFocusedCharacters = focusedCharacterIds.size > 0;
            let commentBubbleOffsets: Map<string, number> | null = null;
            if (commentBubbleMode === "full") {
              commentBubbleOffsets = new Map<string, number>();
              let lastBubbleBottom = -Infinity;
              for (let i = safeWindowStart; i < safeWindowEnd; i++) {
                const windowBlock = blocks[i];
                const commentCount = commentsByBlockId.get(windowBlock.id)?.length ?? 0;
                const assetCount = blockAssetsByBlockId.get(windowBlock.id)?.length ?? 0;
                const count = commentCount + assetCount;
                if (count === 0 || activeCommentBlockId === windowBlock.id || activeAssetBlockId === windowBlock.id) continue;
                const blockHeight = measuredHeightsRef.current.get(windowBlock.id) ?? DEFAULT_BLOCK_H;
                const blockTop = cumulativeHRef.current[i] - spacerH.top;
                const desiredCenter = blockTop + blockHeight / 2;
                const visibleCommentCount = assetCount > 0 ? Math.min(3, commentCount) : Math.min(4, commentCount);
                const visibleAssetCount = Math.min(assetCount, 4 - visibleCommentCount);
                const hasDivider = commentCount > 0 && assetCount > 0;
                const bubbleHeight = Math.min(160, 38 + (visibleCommentCount + visibleAssetCount) * 17 + (hasDivider ? 11 : 0));
                const desiredTop = desiredCenter - bubbleHeight / 2;
                const top = Math.max(desiredTop, lastBubbleBottom + 6);
                lastBubbleBottom = top + bubbleHeight;
                commentBubbleOffsets.set(windowBlock.id, top - desiredTop);
              }
            }

            return [
              <div
                key="__vtop"
                ref={topSpacerRef}
                style={{ height: spacerH.top }}
                aria-hidden="true"
                onDragOver={(e) => handleEdgeSpacerDragOver(e, "top")}
                onDrop={(e) => handleEdgeSpacerDrop(e, "top")}
              />,
              ...blocks.slice(safeWindowStart, safeWindowEnd).flatMap((block, wIdx) => {
            const bIdx = safeWindowStart + wIdx;
            const prev = bIdx > 0 ? blocks[bIdx - 1] : null;
            const hasInsertionGap = hasScriptInsertionGapBefore(blocks, bIdx, sceneParentIdById);
            const showSceneEndGap = isLockedMode && shouldShowSceneEndGap(prev, block);
            if (isMarkerBlock(block)) {
              if (!openingChapterVisible && block.id === scriptConfig.openingChapterMarkerId) return [];
              const markerScene = block.sceneId ? sceneById.get(block.sceneId) ?? null : null;
              const markerNode: ScriptMarkerNode | null =
                block.type === "chapter_marker" && markerScene
                  ? { kind: "chapter", id: block.id, scene: markerScene }
                  : block.type === "scene_marker" && markerScene
                    ? { kind: "scene", id: block.id, scene: markerScene }
                    : block.type === "rehearsal_marker"
                      ? { kind: "rehearsal", id: block.id, mark: rehearsalLabels.rehearsalLabelByMarkerId.get(block.id) ?? "" }
                      : null;
              const markerEl = markerNode ? (
                <div
                  key={block.id}
                  id={`block-${block.id}`}
                  data-bwrap={block.id}
                  data-scene-anchor={block.sceneId ?? undefined}
                  className={`min-w-0 scroll-mt-20 rounded-lg transition-[outline] duration-150${highlightedBlockId === block.id ? " outline outline-2 outline-amber-400" : ""}`}
                >
                  {block.sceneId && <span id={`scene-block-${block.sceneId}`} className="pointer-events-none absolute" />}
                  <ScriptMarkerRow
                    node={markerNode}
                    canEdit={block.type === "rehearsal_marker" ? effectiveCanEditRehearsalMark : canEditMetadata}
                    isSelected={selectedBlockIds.has(block.id)}
                    isDeleteConfirmHighlighted={deleteConfirmingBlockIds.has(block.id) || invalidSelectionEndIds.has(block.id)}
                    isDeleteConfirmationOpen={markerDeleteConfirmBlockId === block.id}
                    isMobileMenuOpen={mobileBlockMenuBlockId === block.id}
                    isReorderLocked={isReorderLocked}
                    isScriptDragging={isScriptDragging}
                    dragTarget={dragTarget?.kind === "block" && dragTarget.id === block.id ? dragTarget : null}
                    isRecentlyMoved={recentlyMovedBlockIds.has(block.id)}
                    isTocHighlighted={tocHighlightedMarkerIds.has(block.id)}
                    onRemove={() => deleteMarker(block.id)}
                    onRequestDelete={() => requestMarkerDelete(block.id)}
                    canAddChapterScene={canEditMetadata}
                    canAddRehearsal={canAddRehearsalMark}
                    onAddChapterBefore={() => addChapterBeforeBlock(block.id)}
                    onAddSceneBefore={() => addSceneBeforeBlock(block.id)}
                    onAddRehearsalBefore={() => addRehearsalBeforeBlock(block.id)}
                    onConvertToChapter={canEditMetadata ? () => convertMarkerBlockType(block.id, "chapter_marker") : undefined}
                    onConvertToScene={canEditMetadata ? () => convertMarkerBlockType(block.id, "scene_marker") : undefined}
                    onOpenSceneDetail={productionId && block.sceneId && (block.type === "chapter_marker" || block.type === "scene_marker")
                      ? () => openSceneDetailDialog(block.sceneId as string)
                      : undefined}
                    onDeleteConfirmChange={(confirming) => {
                      if (confirming) {
                        setMarkerDeleteConfirmBlockId(block.id);
                        return;
                      }
                      dismissBlockConfirmations();
                    }}
                    onMobileMenuOpen={() => {
                      openMobileBlockMenu(block.id, bIdx);
                    }}
                    onSelect={(e) => {
                      if (isReorderLockedRef.current) return;
                      const isAdditiveSelection = e.ctrlKey || e.metaKey;
                      if (e.shiftKey && selectedBlockIds.size > 0) {
                        clearBlockSelection();
                        return;
                      }
                      if (isAdditiveSelection) {
                        selectionDetachedRef.current = true;
                        const next = toggleSelectionItem(blocks, {
                          selectedIds: selectedBlockIds,
                          markerEndIds: markerEndedScopeIdsRef.current,
                        }, bIdx, isMarkerBlock);
                        selectionAnchorBlockIdRef.current = next.selectedIds.has(block.id)
                          ? block.id
                          : next.selectedIds.values().next().value ?? null;
                        commitBlockSelection(next);
                        return;
                      }
                      if (selectedBlockIds.has(block.id)) {
                        const next = toggleSelectionItem(blocks, {
                          selectedIds: selectedBlockIds,
                          markerEndIds: markerEndedScopeIdsRef.current,
                        }, bIdx, isMarkerBlock);
                        selectionAnchorBlockIdRef.current = next.selectedIds.values().next().value ?? null;
                        commitBlockSelection(next);
                        return;
                      }
                      selectionAnchorBlockIdRef.current = block.id;
                      if (selectionDetachedRef.current) {
                        commitBlockSelection(replaceSelectionItem(blocks, bIdx, isMarkerBlock));
                        return;
                      }
                      commitBlockSelection(toggleSelectionItem(blocks, {
                        selectedIds: selectedBlockIds,
                        markerEndIds: markerEndedScopeIdsRef.current,
                      }, bIdx, isMarkerBlock));
                      selectionDetachedRef.current = true;
                    }}
                    onSceneNameChange={updateScene}
                    onDragStart={(e) => {
                      if (isReorderLockedRef.current) {
                        e.preventDefault();
                        return;
                      }
                      const isDraggingSelection = selectedBlockIds.has(block.id);
                      const ids = isDraggingSelection ? Array.from(selectedBlockIds) : [block.id];
                      if (isDraggingSelection && !canPerformSelectedBlockAction(ids)) {
                        e.preventDefault();
                        return;
                      }
                      dismissBlockConfirmations();
                      if (!isDraggingSelection && selectedBlockIds.size > 0) {
                        clearBlockSelection();
                      }
                      clearEditorFocusForDrag();
                      setScriptDragging(true);
                      dragButtonDownSeenRef.current = false;
                      dragButtonReleasedRef.current = false;
                      updateDragCountBadge(e.clientX, e.clientY, ids.length);
                      draggingBlockId.current = block.id;
                      draggingBlockIds.current = ids;
                      dropHandledRef.current = false;
                      pendingFocus.current = null;
                      clearDragTarget();
                      dragInvalidReasonRef.current = null;
                      if (!isDraggingSelection) {
                        selectionAnchorBlockIdRef.current = block.id;
                        commitBlockSelection(replaceSelectionItem(blocks, bIdx, isMarkerBlock));
                      }
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", ids.join(","));
                    }}
                    onDragEnd={() => {
                      const draggedIds = draggingBlockIds.current;
                      const target = dragTargetRef.current;
                      if (!dropHandledRef.current && draggedIds.length > 0) {
                        if (target) {
                          lockReorder();
                          const moved = moveDraggedBlocks(draggedIds, target);
                          if (!moved) unlockReorder();
                        } else {
                          showReorderNotice(dragInvalidReasonRef.current ?? "移动失败：未释放到有效位置。");
                        }
                      }
                      dropHandledRef.current = false;
                      draggingBlockId.current = null;
                      draggingBlockIds.current = [];
                      clearDragTarget();
                      dragInvalidReasonRef.current = null;
                      clearDragCountBadge();
                      setScriptDragging(false);
                      dismissBlockConfirmations();
                    }}
                    onDragOver={(e) => {
                      if (isReorderLockedRef.current) return;
                      if (!draggingBlockId.current) return;
                      const nextTarget = updateDragTargetFromClientY(e.clientY);
                      if (!nextTarget) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(e) => {
                      if (isReorderLockedRef.current) return;
                      e.preventDefault();
                      e.stopPropagation();
                      lockReorder();
                      dropHandledRef.current = true;
                      const draggedIds = draggingBlockIds.current.length
                        ? draggingBlockIds.current
                        : e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
                      const target = updateDragTargetFromClientY(e.clientY) ?? dragTargetRef.current ?? dragTarget;
                      draggingBlockId.current = null;
                      draggingBlockIds.current = [];
                      clearDragTarget();
                      clearDragCountBadge();
                      setScriptDragging(false);
                      dismissBlockConfirmations();
                      if (!target) {
                        showReorderNotice(dragInvalidReasonRef.current ?? "移动失败：未释放到有效位置。");
                        dragInvalidReasonRef.current = null;
                        unlockReorder();
                        return;
                      }
                      dragInvalidReasonRef.current = null;
                      const moved = moveDraggedBlocks(draggedIds, target);
                      if (!moved) unlockReorder();
                    }}
                    lineIndexWidth={markerLineIndexWidthStyle}
                    reserveRehearsalGap={isLockedMode}
                  />
                </div>
              ) : null;
              if (!markerEl) return [];
              const preBlockGap = bIdx > 0
                ? canEditText && hasInsertionGap
                  ? <InsertZone lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(bIdx)} />
                  : showSceneEndGap
                    ? <BlockGap />
                    : null
                : null;
              return [
                <div
                  key={`vi-${block.id}`}
                  data-vitem={block.id}
                >
                  {preBlockGap}
                  {markerEl}
                </div>,
              ];
            }
            const projectedOwnedBlock = legacyProjectedBlocks[bIdx] ?? block;
            const projectedOwnedPrev = bIdx > 0 ? legacyProjectedBlocks[bIdx - 1] ?? null : null;
            const ownedSceneId = projectedOwnedBlock.sceneId;
            const ownedRehearsalId = projectedOwnedBlock.rehearsalMark;
            const displayRehearsalMark = ownedRehearsalId
              ? rehearsalLabels.rehearsalLabelByMarkerId.get(ownedRehearsalId) ?? null
              : null;
            const displayBlock = block.sceneId === ownedSceneId && block.rehearsalMark === displayRehearsalMark
              ? block
              : { ...block, sceneId: ownedSceneId, rehearsalMark: displayRehearsalMark };

            const sceneStart = ownedSceneId !== null && ownedSceneId !== projectedOwnedPrev?.sceneId;
            const isMarkStart = !!ownedRehearsalId && ownedRehearsalId !== (projectedOwnedPrev?.rehearsalMark ?? null);
            // 分页线改吃估算 pageMap（与服务端 page_map 同源同参、逐块同值）——
            // 全组页码单一口径（AI/搜索/@提及/分页线同数）。它与打印实测有偏差是
            // 已接受的事实；「定稿排版时刻回传实测数据覆盖 page_map」挂 issue 另批。
            const dividerPage = pageMap[block.id];
            const prevDividerPage = prev ? pageMap[prev.id] : undefined;
            const pageBreak = !!(
              display.pageBreaks &&
              bIdx > 0 &&
              dividerPage !== undefined &&
              prevDividerPage !== undefined &&
              dividerPage !== prevDividerPage
            );
            const isBlockFocused = !isLockedMode && focusedId === block.id;
            const hideCharSelector =
              isBlockFocused || pageBreak
                ? false
                : shouldHideCharacterLabel(
                    projectedOwnedPrev,
                    projectedOwnedBlock,
                  );
            const showCharacterGap = isLockedMode && shouldShowCharacterGap(projectedOwnedPrev, projectedOwnedBlock, hideCharSelector);
            const matchOrder = searchMatches.indexOf(bIdx);
            const searchHighlight: "focused" | "match" | undefined =
              matchOrder === searchIdx ? "focused" : matchOrder >= 0 ? "match" : undefined;
            const isSelected = selectedBlockIds.has(block.id);
            const isCharacterFocusHighlighted =
              hasFocusedCharacters && block.characterIds.some((id) => focusedCharacterIds.has(id));
            const selectedDeleteIds = isSelected ? selectedBlockIdsArray : [block.id];
            const selectedCount = selectedDeleteIds.length;
            const blockComments = commentsByBlockId.get(block.id) ?? EMPTY_COMMENTS;
            const blockAssets = blockAssetsByBlockId.get(block.id) ?? EMPTY_BLOCK_ASSETS;
            const blockLineNumber = scriptLineNumberByBlockId.get(block.id)!;
            const requiresNonEmptySceneConfirm = isSelected
              ? selectedBlocksRequireNonEmptySceneConfirm
              : blockIdsRequireNonEmptySceneConfirm(selectedDeleteIds);
            const canDeleteWithoutConfirmation = (
              isSelected ? selectedBlocksAreEmptyForDelete : blockIdsAreEmptyForDelete(selectedDeleteIds)
            ) && !requiresNonEmptySceneConfirm;
            const deleteConfirmNoopMessage = requiresNonEmptySceneConfirm
              ? "章节/段落/排练记号内容不可为空，至少需包含一个剧本块"
              : undefined;
            const canMergeWithPrevious = !!(
              prev &&
              prev.type === block.type &&
              prev.lyric === block.lyric &&
              sameCharacters(prev.characterIds, block.characterIds)
            );
            const contentPlaceholder = ownedSceneId === openingChapterSceneId
              ? displayBlock.type === "stage"
                ? "在此输入演出正式开始前的舞台提示…"
                : "在此输入演出正式开始前的台词…"
              : undefined;

            const blockEl = (
              <div
                key={block.id}
                id={`block-${block.id}`}
                data-bwrap={block.id}
                data-scene-anchor={sceneStart ? ownedSceneId ?? undefined : undefined}
                className={`min-w-0 scroll-mt-20 transition-[outline] duration-150${highlightedBlockId === block.id ? " outline outline-2 outline-amber-400 rounded-lg" : ""}`}
              >
                {/* Scene anchor for TableOfContents links */}
                {sceneStart && ownedSceneId && <span id={`scene-block-${ownedSceneId}`} className="pointer-events-none absolute" />}
                {pageBreak && (
                  <div className="relative my-2 flex items-center gap-2 px-6 select-none">
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                    <span className="shrink-0 rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                      第 {dividerPage} 页
                    </span>
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                  </div>
                )}
                <ScriptBlock
                  block={displayBlock}
                  lineNum={display.lineNumbers ? blockLineNumber : undefined}
                  captionLineNum={blockLineNumber}
                  lineIndexWidth={lineIndexWidthStyle}
                  isSearchHighlight={searchHighlight}
                  readOnlyRehearsalMode={isLockedMode}
                  readOnlyScene={isLockedMode && display.rehearsalBlockScenes && ownedSceneId ? sceneById.get(ownedSceneId) ?? null : null}
                  showSceneLabel={display.rehearsalBlockScenes}
                  stageDelimOpen={scriptConfig.stageDelimOpen}
                  stageDelimClose={scriptConfig.stageDelimClose}
                  textLayoutMode={scriptConfig.textLayoutMode}
                  contentPlaceholder={contentPlaceholder}
                  characters={characters}
                  scenes={scenes}
                  hideCharSelector={hideCharSelector}
                  isFocused={isBlockFocused}
                  dragTarget={
                    dragTarget?.kind === "block" &&
                    dragTarget.id === block.id
                      ? dragTarget
                      : null
                  }
                  isSelected={isSelected}
                  isDeleteConfirmHighlighted={deleteConfirmingBlockIds.has(block.id)}
                  isCharacterFocusHighlighted={isCharacterFocusHighlighted}
                  isRecentlyMoved={recentlyMovedBlockIds.has(block.id)}
                  deleteConfirmToken={deleteConfirmationRequest?.anchorId === block.id ? deleteConfirmationRequest.token : undefined}
                  selectedCount={selectedCount}
                  canDeleteWithoutConfirmation={canDeleteWithoutConfirmation}
                  deleteConfirmNoopMessage={deleteConfirmNoopMessage}
                  dismissToken={dismissActionToken}
                  isReorderLocked={isReorderLocked}
                  isScriptDragging={isScriptDragging}
                  charEditToken={charEditTokens[block.id] ?? 0}
                  presenceEditors={Array.from(presenceMap.values()).filter(
                    p => p.blockId === block.id && p.clientId !== clientId
                  )}
                  onRegisterRef={registerRef}
                  onUpdate={(changes) => updateBlock(block.id, changes)}
                  onSplit={(before, after) => splitBlock(block.id, before, after)}
                  onMerge={() => mergeBlock(block.id)}
                  onDelete={() => {
                    if (selectedDeleteIds.length > 1) deleteBlocks(selectedDeleteIds);
                    else deleteBlocks([block.id]);
                  }}
                  onFocus={() => markBlockFocused(block.id)}
                  onDeleteFocus={() => focusBlockContent(block.id, false)}
                  onRequestLargeSelectionOperation={requestLargeSelectionOperation}
                  onCanStartSelectionAction={() => canPerformSelectedBlockAction(selectedDeleteIds)}
                  onToggleType={() => {
                    if (isSelected && selectedDeleteIds.length > 1) {
                      if (!canPerformSelectedBlockAction(selectedDeleteIds)) return;
                      setBlocksType(selectedDeleteIds, block.type === "stage" ? "dialogue" : "stage");
                    } else {
                      toggleBlockType(block.id);
                    }
                  }}
                  onToggleLyric={() => {
                    if (isSelected && selectedDeleteIds.length > 1) {
                      if (!canPerformSelectedBlockAction(selectedDeleteIds)) return;
                      setBlocksLyric(selectedDeleteIds, !block.lyric);
                    } else {
                      toggleBlockLyric(block.id);
                    }
                  }}
                  onArrowUpFromChar={() => handleArrowUpFromChar(block.id)}
                  onArrowDownFromChar={() => handleArrowDownFromChar(block.id)}
                  onArrowUpFromTextarea={() => handleArrowUpFromTextarea(block.id)}
                  onArrowDownFromTextarea={() => handleArrowDownFromTextarea(block.id)}
                  onAddChapterBefore={() => addChapterBeforeBlock(block.id)}
                  onAddSceneBefore={() => addSceneBeforeBlock(block.id)}
                  onAddRehearsalBefore={() => addRehearsalBeforeBlock(block.id)}
                  onCharacterChangeFocus={() => {
                    glowAndFocusBlocks([block.id]);
                  }}
                  onToggleSelected={(e) => {
                    if (isReorderLockedRef.current) return;
                    focusBlockContent(block.id);
                    const isAdditiveSelection = e.ctrlKey || e.metaKey || (
                      window.matchMedia("(max-width: 639px)").matches && selectedBlockIds.size > 0
                    );
                    if (e.shiftKey) {
                      const anchorId = selectionAnchorBlockIdRef.current;
                      const anchorIdx = anchorId ? blockIndexByIdRef.current.get(anchorId) ?? -1 : -1;
                      const start = anchorIdx === -1 ? bIdx : Math.min(anchorIdx, bIdx);
                      const end = anchorIdx === -1 ? bIdx : Math.max(anchorIdx, bIdx);
                      if (anchorIdx === -1) selectionAnchorBlockIdRef.current = block.id;
                      selectionDetachedRef.current = true;
                      if (isAdditiveSelection) {
                        commitBlockSelection(addSelectionRange(blocks, {
                          selectedIds: selectedBlockIds,
                          markerEndIds: markerEndedScopeIdsRef.current,
                        }, start, end, isMarkerBlock));
                      } else {
                        commitBlockSelection(replaceSelectionRange(blocks, start, end, isMarkerBlock));
                      }
                      return;
                    }
                    if (isAdditiveSelection) {
                      selectionDetachedRef.current = true;
                      const next = toggleSelectionItem(blocks, {
                        selectedIds: selectedBlockIds,
                        markerEndIds: markerEndedScopeIdsRef.current,
                      }, bIdx, isMarkerBlock);
                      selectionAnchorBlockIdRef.current = next.selectedIds.has(block.id)
                        ? block.id
                        : next.selectedIds.values().next().value ?? null;
                      commitBlockSelection(next);
                      return;
                    }
                    if (!selectedBlockIds.has(block.id) && selectionDetachedRef.current) {
                      selectionAnchorBlockIdRef.current = block.id;
                      commitBlockSelection(replaceSelectionItem(blocks, bIdx, isMarkerBlock));
                      selectionDetachedRef.current = false;
                      return;
                    }
                    const next = toggleSelectionItem(blocks, {
                      selectedIds: selectedBlockIds,
                      markerEndIds: markerEndedScopeIdsRef.current,
                    }, bIdx, isMarkerBlock);
                    selectionAnchorBlockIdRef.current = next.selectedIds.has(block.id)
                      ? block.id
                      : next.selectedIds.values().next().value ?? null;
                    commitBlockSelection(next);
                  }}
                  onDeleteConfirmationChange={(active) => {
                    setDeleteConfirmingBlockIds((current) => {
                      if (active) return new Set(selectedDeleteIds);
                      return current.size === 0 ? current : new Set();
                    });
                  }}
                  onDragStartBlock={(e) => {
                    if (isReorderLockedRef.current) {
                      e.preventDefault();
                      return;
                    }
                    const isDraggingSelection = selectedBlockIds.has(block.id);
                    const ids = isDraggingSelection ? Array.from(selectedBlockIds) : [block.id];
                    if (isDraggingSelection && !canPerformSelectedBlockAction(ids)) {
                      e.preventDefault();
                      return;
                    }
                    dismissBlockConfirmations();
                    if (!isDraggingSelection && selectedBlockIds.size > 0) {
                      clearBlockSelection();
                    }
                    clearEditorFocusForDrag();
                    setScriptDragging(true);
                    dragButtonDownSeenRef.current = false;
                    dragButtonReleasedRef.current = false;
                    updateDragCountBadge(e.clientX, e.clientY, ids.length);
                    draggingBlockId.current = block.id;
                    draggingBlockIds.current = ids;
                    dropHandledRef.current = false;
                    pendingFocus.current = null;
                    clearDragTarget();
                    dragInvalidReasonRef.current = null;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", ids.join(","));
                  }}
                  onDragEndBlock={() => {
                    const draggedIds = draggingBlockIds.current;
                    const target = dragTargetRef.current;
                    if (!dropHandledRef.current && draggedIds.length > 0) {
                      if (target) {
                        lockReorder();
                        const moved = moveDraggedBlocks(draggedIds, target);
                        if (!moved) unlockReorder();
                      } else {
                        showReorderNotice(dragInvalidReasonRef.current ?? "移动失败：未释放到有效位置。");
                      }
                    }
                    dropHandledRef.current = false;
                    draggingBlockId.current = null;
                    draggingBlockIds.current = [];
                    clearDragTarget();
                    dragInvalidReasonRef.current = null;
                    clearDragCountBadge();
                    setScriptDragging(false);
                    dismissBlockConfirmations();
                  }}
                  onDragOverBlock={(e) => {
                    if (isReorderLockedRef.current) return;
                    if (!draggingBlockId.current) return;
                    const nextTarget = updateDragTargetFromClientY(e.clientY);
                    if (!nextTarget) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDropBlock={(e) => {
                    if (isReorderLockedRef.current) return;
                    e.preventDefault();
                    e.stopPropagation();
                    lockReorder();
                    dropHandledRef.current = true;
                    const draggedIds = draggingBlockIds.current.length
                      ? draggingBlockIds.current
                      : e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
                    const target = updateDragTargetFromClientY(e.clientY) ?? dragTargetRef.current ?? dragTarget;
                    draggingBlockId.current = null;
                    draggingBlockIds.current = [];
                    clearDragTarget();
                    clearDragCountBadge();
                    setScriptDragging(false);
                    dismissBlockConfirmations();
                    if (!target) {
                      showReorderNotice(dragInvalidReasonRef.current ?? "移动失败：未释放到有效位置。");
                      dragInvalidReasonRef.current = null;
                      unlockReorder();
                      return;
                    }
                    dragInvalidReasonRef.current = null;
                    const moved = moveDraggedBlocks(draggedIds, target);
                    if (!moved) unlockReorder();
                  }}
                  isMarkStart={isMarkStart}
                  commentCount={blockComments.length}
                  blockComments={blockComments}
                  blockAssets={blockAssets}
                  isCommentPanelActive={activeCommentBlockId === block.id}
                  isAssetPanelActive={activeAssetBlockId === block.id}
                  commentBubbleOffsetY={commentBubbleOffsets?.get(block.id) ?? 0}
                  commentBubbleMode={commentBubbleMode}
                  commentBubbleWidth={commentBubbleWidthPx}
                  onCommentClick={() => openBlockSidePanel("comment", block.id)}
                  onAssetClick={() => openBlockSidePanel("asset", block.id)}
                  canEditText={canEditText}
                  canEditMetadata={canEditMetadata}
                  canEditRehearsalMark={canAddRehearsalMark}
                  canMergeWithPrevious={canMergeWithPrevious}
                  tagGroups={tagGroups}
                  blockTagValues={blockTagMap.get(block.id) ?? []}
                  showBlockTags={display.blockTags && tagGroups.length > 0}
                  hasLyricConfig={tagGroups.some(g => !!g.lyricSplitAfterOptionId)}
                  onTagChange={(groupId, optionId, value, del) => handleTagChange(block.id, groupId, optionId, value, del)}
                  onTagCopyClick={() => handleTagCopy(block.id)}
                  onTagPasteClick={() => handleTagPaste(block.id)}
                  onMobileMenuOpen={() => {
                    openMobileBlockMenu(block.id, bIdx);
                  }}
                />
              </div>
            );
            const preBlockGap = bIdx > 0
              ? canEditText && hasInsertionGap ? <InsertZone lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(bIdx)} /> :
                showSceneEndGap ? <BlockGap /> :
                isLockedMode && showCharacterGap ? <BlockGap /> :
                null
              : null;
            return [
              <div
                key={`vi-${block.id}`}
                data-vitem={block.id}
              >
                {preBlockGap}
                {blockEl}
              </div>,
            ];
              }),
              <div
                key="__vbot"
                ref={botSpacerRef}
                style={{ height: spacerH.bot }}
                aria-hidden="true"
                onDragOver={(e) => handleEdgeSpacerDragOver(e, "bottom")}
                onDrop={(e) => handleEdgeSpacerDrop(e, "bottom")}
              />,
            ];
          })()}
          {canEditText ? <InsertZone lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(blocks.length)} /> : null}
          </div>
        </div>
        {canEditText && (
          <p className="mt-4 text-center text-xs text-zinc-300">
            Enter 新建块 · Shift+Enter 块内换行 · Backspace（行首）合并到上一块
          </p>
        )}
        </main>

        {/* Right column: scene detail below the top third; overlays render above it. */}
        <div className="hidden min-w-0 flex-1 self-stretch md:block">
          {isSceneDetailVisible && productionId && (
            <aside
              style={sceneDetailAsideStyle}
              className="pointer-events-none sticky top-0 z-10 flex h-[calc(100vh-4rem)] min-h-0 flex-col"
            >
              <div className="h-[calc((100vh-4rem)/3)] min-h-44 max-h-96 shrink-0" aria-hidden="true" />
              <div className="pointer-events-auto mt-3 flex min-h-0 flex-1 flex-col border-t border-zinc-300 bg-[var(--paper)] pt-3 pr-2">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ScriptSceneDetailRail
                    scene={activeSceneDetail}
                    scenes={sceneDetails}
                    productionId={productionId}
                    versionId={activeVersionId ?? null}
                    canEdit={canEditMetadata}
                    isDeleteConfirmHighlighted={!!markerDeleteConfirmDetailSceneId}
                    scrollbarOffsetPx={0}
                    onUpdateIdentity={updateScene}
                    onPatchMeta={patchSceneMeta}
                  />
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      {tagEditorOpen && productionId && (
        <>
          <div className="sm:hidden fixed inset-0 z-20" onClick={() => setTagEditorOpen(false)} />
        <div
          className={`fixed right-0 top-[4rem] bottom-0 flex w-80 flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-xl panel-mobile-full ${tagEditorOnTop ? "z-[31]" : "z-30"}`}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
            <span className="text-sm font-semibold text-zinc-700">标签设置</span>
            <button onClick={() => setTagEditorOpen(false)} className="text-lg leading-none text-zinc-300 hover:text-zinc-500">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <TagGroupEditor
              productionId={productionId}
              initialGroups={tagGroups}
              canEdit={canEditMetadata}
              onGroupsChange={setTagGroups}
            />
          </div>
        </div>
        </>
      )}

      {activeAssetBlockId && productionId && (
        <>
          <div className="sm:hidden fixed inset-0 z-20" onClick={() => setActiveAssetBlockId(null)} />
        <SideBlockPanel
          blockId={activeAssetBlockId}
          activePanel="asset"
          onPanelChange={panel => openBlockSidePanel(panel, activeAssetBlockId)}
          blockCaption={activeAssetBlockCaption}
          width={blockSidePanelWidthPx}
          navigation={{
            hasPrevious: assetPanelNavigationTargets.previousBlockId !== null,
            hasNext: assetPanelNavigationTargets.nextBlockId !== null,
            onPrevious: () => navigateSidePanelBlock("asset", -1),
            onNext: () => navigateSidePanelBlock("asset", 1),
          }}
          onClose={() => setActiveAssetBlockId(null)}
        >
          <div className="relative z-10 flex-1 overflow-y-auto bg-white px-4 py-3">
            {/* #420：挂载锚稳定 block_id，快照分辨路径退役 */}
            <MountPointAssets
              productionId={productionId}
              mountType="block"
              mountId={activeAssetBlockId}
              label="Block 附件"
              canEdit={true}
              display="panel"
              onNavigate={prepareForNavigation}
              onChange={loadBlockAssetBubbles}
            />
          </div>
        </SideBlockPanel>
        </>
      )}

      {activeCommentBlockId && productionId && (
        <>
          <div className="sm:hidden fixed inset-0 z-20" onClick={() => setActiveCommentBlockId(null)} />
        <CommentsPanel
          key={activeCommentBlockId}
          blockId={activeCommentBlockId}
          productionId={productionId}
          comments={commentsByBlockId.get(activeCommentBlockId) ?? EMPTY_COMMENTS}
          currentUserId={meUserId}
          isAdmin={meIsAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentBlockId(null)}
          onNavigate={prepareForNavigation}
          onPanelChange={panel => openBlockSidePanel(panel, activeCommentBlockId)}
          draft={commentDraftsRef.current.get(activeCommentBlockId)}
          onDraftChange={updateCommentDraft}
          width={blockSidePanelWidthPx}
          blockCaption={activeCommentBlockCaption}
          navigation={{
            hasPrevious: commentPanelNavigationTargets.previousBlockId !== null,
            hasNext: commentPanelNavigationTargets.nextBlockId !== null,
            onPrevious: () => navigateSidePanelBlock("comment", -1),
            onNext: () => navigateSidePanelBlock("comment", 1),
          }}
        />
        </>
      )}

      {pendingLockedMode !== null && (
        <ScriptDialog
          onClose={() => setPendingLockedMode(null)}
          panelClassName="w-[360px] rounded-2xl bg-white p-5 shadow-xl"
        >
            <h2 className="text-base font-semibold text-zinc-800">
              {pendingLockedMode ? "确认进入排练模式？" : "确认退出排练模式？"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              {pendingLockedMode
                ? "进入该模式后，将只能添加附件和评论，对剧本的其他编辑权限将被锁定。"
                : "退出后，将恢复到可编辑模式。"}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPendingLockedMode(null)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              >
                取消
              </button>
              <button
                onClick={confirmLockedModeChange}
                className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                确认
              </button>
            </div>
        </ScriptDialog>
      )}

      {pendingAggregateFocusPrompt && (() => {
        const currentCharacter = characters.find((char) => char.id === pendingAggregateFocusPrompt.characterId);
        const aggregateCharacters = pendingAggregateFocusPrompt.aggregateIds
          .map((id) => characters.find((char) => char.id === id))
          .filter((char): char is Character => Boolean(char));
        if (!currentCharacter || aggregateCharacters.length === 0) return null;
        return (
          <ScriptDialog
            onClose={cancelAggregateFocusPrompt}
            panelClassName="w-[420px] rounded-2xl bg-white p-5 shadow-xl"
          >
              <h2 className="text-base font-semibold text-zinc-800">
                是否同时聚焦以下包含该角色的聚合角色？
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                “{currentCharacter.name}” 也是以下聚合角色的一部分。<br />按需求添加所需要的角色后，点击确认。
              </p>
              <div className="mt-4 max-h-56 overflow-y-auto rounded-xl border border-zinc-100">
                {aggregateCharacters.map((char) => {
                  const active = pendingAggregateFocusPrompt.selectedIds.has(char.id);
                  return (
                    <button
                      key={char.id}
                      type="button"
                      onClick={() => togglePendingAggregateFocus(char.id)}
                      className="flex w-full items-center justify-between border-b border-zinc-50 px-4 py-2.5 text-left last:border-0 hover:bg-zinc-50"
                    >
                      <span className="min-w-0 truncate text-sm text-zinc-700">{char.name}</span>
                      <ModeSwitch active={active} activeClassName="bg-purple-800/60" />
                    </button>
                  );
                })}
              </div>
              <div className="mt-5 flex justify-between gap-2">
                <button
                  onClick={addAllAggregateFocusPrompt}
                  className="rounded bg-purple-900/70 px-3 py-1.5 text-sm text-white hover:bg-purple-800/80"
                >
                  全部添加
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={cancelAggregateFocusPrompt}
                    className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                  >
                    取消
                  </button>
                  <button
                    onClick={confirmAggregateFocusPrompt}
                    className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                  >
                    确认
                  </button>
                </div>
              </div>
          </ScriptDialog>
        );
      })()}

      {markerDeleteDialog && (
        <MarkerDeleteDialog
          state={markerDeleteDialog}
          busy={markerDeleteDialogBusy}
          onClose={() => setMarkerDeleteDialog(null)}
          onChoose={(operation) => {
            if (markerDeleteDialog.source === "server") {
              void applyServerMarkerDeleteOperation(operation);
              return;
            }
            if (operation.type === "whole" && !canEditText) {
              setMarkerDeleteDialog({ plan: null, message: "删除整章及空段落需要剧本编辑权限。", source: "local" });
              return;
            }
            applyMarkerDeleteOperation(operation);
          }}
        />
      )}

      {markerDetailDeleteBlockedKind && (
        <ScriptDialog
          onClose={() => setMarkerDetailDeleteBlockedKind(null)}
          panelClassName="w-[380px] rounded-2xl bg-white p-5 shadow-xl"
        >
          <h2 className="text-base font-semibold text-zinc-800">
            不可删除该{markerDetailDeleteBlockedKind === "chapter" ? "章节" : "段落"}
          </h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-500">
            {sceneDetailDeleteBlockedMessage(markerDetailDeleteBlockedKind)}
          </p>
          <div className="mt-5 flex justify-end">
            <button
              onClick={() => setMarkerDetailDeleteBlockedKind(null)}
              className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              确认
            </button>
          </div>
        </ScriptDialog>
      )}

      {pendingNonEmptyMarkerSelectionDeleteIds && (() => {
        const blockedMarkers = nonEmptyDramaturgyMarkersForBlockIds(pendingNonEmptyMarkerSelectionDeleteIds)
          .map((marker) => {
            const index = blockIndexByIdRef.current.get(marker.id);
            const block = index === undefined ? null : blocks[index] ?? null;
            if (!block) return null;
            const detail = block.sceneId ? sceneDetailById.get(block.sceneId) ?? null : null;
            const scene = block.sceneId ? sceneById.get(block.sceneId) ?? null : null;
            return {
              id: marker.id,
              captionNumber: scene?.number?.trim() || "—",
              captionName: scene?.name?.trim() || "未命名",
              captionDuration: markerExpectedDuration(block, detail, sceneDetails),
              details: markerDetailFields(block, detail),
            };
          })
          .filter((item): item is { id: string; captionNumber: string; captionName: string; captionDuration: string; details: MarkerDetailField[] } => item !== null);
        const scriptBlockDeleteIds = pendingNonEmptyMarkerSelectionDeleteIds.filter((id) => {
          const index = blockIndexByIdRef.current.get(id);
          const block = index === undefined ? undefined : blocks[index];
          return !!block && (block.type === "rehearsal_marker" || !isMarkerBlock(block));
        });
        const cancelNonEmptyMarkerSelectionDelete = () => {
          setPendingNonEmptyMarkerSelectionDeleteIds(null);
          setSelectedNonEmptyMarkerDeleteIds(new Set());
          setExpandedNonEmptyMarkerDetailIds(new Set());
          clearBlockSelection();
          dismissBlockConfirmations();
        };
        const toggleNonEmptyMarkerSelection = (markerId: string) => {
          setSelectedNonEmptyMarkerDeleteIds((current) => {
            const next = new Set(current);
            if (next.has(markerId)) next.delete(markerId);
            else next.add(markerId);
            return next;
          });
        };
        const toggleNonEmptyMarkerDetails = (markerId: string) => {
          setExpandedNonEmptyMarkerDetailIds((current) => {
            const next = new Set(current);
            if (next.has(markerId)) next.delete(markerId);
            else next.add(markerId);
            return next;
          });
        };
        return (
          <ScriptDialog
            panelClassName="w-[520px] max-w-[calc(100vw-2rem)] rounded-xl bg-white p-5 shadow-xl"
            onClose={cancelNonEmptyMarkerSelectionDelete}
          >
              <h2 className="text-base font-semibold text-zinc-800">所选标记详情不为空</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                以下章节/段落标记包含详情内容。请选择只删除剧本块，或连同这些标记一起删除。
              </p>
              <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white">
                <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                  <span className="text-xs font-semibold tracking-wide text-zinc-600 uppercase">包含详情的标记</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedNonEmptyMarkerDeleteIds(new Set(blockedMarkers.map((marker) => marker.id)))}
                      className="text-[11px] font-medium text-red-700/70 transition-colors hover:text-red-700"
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedNonEmptyMarkerDeleteIds(new Set())}
                      className="text-[11px] font-medium text-zinc-400 transition-colors hover:text-red-700"
                    >
                      清空
                    </button>
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {blockedMarkers.map((marker) => {
                    const selected = selectedNonEmptyMarkerDeleteIds.has(marker.id);
                    const expanded = expandedNonEmptyMarkerDetailIds.has(marker.id);
                    return (
                      <div key={marker.id} className="border-b border-zinc-100 last:border-0">
                        <div className={`sticky top-0 z-10 flex items-center transition-colors ${selected ? "bg-red-50" : "bg-white hover:bg-zinc-50"}`}>
                          <button
                            type="button"
                            onClick={() => toggleNonEmptyMarkerDetails(marker.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-sm text-zinc-600"
                            aria-expanded={expanded}
                          >
                            <ChevronIcon direction={expanded ? "up" : "down"} className="shrink-0 text-zinc-400 transition-transform" />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-bold">【{marker.captionNumber}】</span>
                              <span>{marker.captionName}</span>
                            </span>
                            <span className="h-4 w-px shrink-0 bg-zinc-100" />
                            <span className="shrink-0 whitespace-nowrap text-xs">
                              <span className="font-bold">预期时长：</span>
                              <span className="font-normal">{marker.captionDuration}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={selected}
                            aria-label={`${selected ? "取消选择" : "选择"}${marker.captionNumber} ${marker.captionName}`}
                            onClick={() => toggleNonEmptyMarkerSelection(marker.id)}
                            className={`mr-3 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${selected ? "bg-red-700" : "bg-zinc-200"}`}
                          >
                            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${selected ? "translate-x-4" : ""}`} />
                          </button>
                        </div>
                        {expanded && (
                          <div className="space-y-2.5 border-t border-zinc-100 bg-white px-3 py-3 text-xs text-zinc-600">
                            {marker.details.map((field) => (
                              <div key={field.label} className="space-y-1.5">
                                <p className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">{field.label}</p>
                                <p className="min-h-[1.75rem] whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-transparent px-2.5 py-2 leading-relaxed text-zinc-700">
                                  {field.value || <span className="italic text-zinc-400">—</span>}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <button
                  onClick={cancelNonEmptyMarkerSelectionDelete}
                  className={SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS}
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    const deletingMarkers = selectedNonEmptyMarkerDeleteIds.size > 0;
                    const ids = !deletingMarkers
                      ? scriptBlockDeleteIds
                      : [...scriptBlockDeleteIds, ...selectedNonEmptyMarkerDeleteIds];
                    setPendingNonEmptyMarkerSelectionDeleteIds(null);
                    setSelectedNonEmptyMarkerDeleteIds(new Set());
                    setExpandedNonEmptyMarkerDetailIds(new Set());
                    if (ids.length > 0) {
                      deleteBlocks(ids, { forceDeleteNonEmptyMarkerDetails: true });
                      if (!deletingMarkers) clearBlockSelection();
                    }
                  }}
                  className={selectedNonEmptyMarkerDeleteIds.size === 0
                    ? "rounded border border-red-700/80 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:border-red-900 hover:bg-red-800/80 hover:text-white"
                    : SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS}
                >
                  {selectedNonEmptyMarkerDeleteIds.size === 0 ? "仅删除剧本块" : "删除选中标记"}
                </button>
              </div>
          </ScriptDialog>
        );
      })()}

      {pendingLargeSelectionConfirmation && (
        <ScriptDialog
          onClose={() => {
            pendingLargeSelectionConfirmation.onCancel?.();
            setPendingLargeSelectionConfirmation(null);
          }}
          panelClassName="w-[380px] rounded-2xl bg-white p-5 shadow-xl"
        >
            <h2 className="text-base font-semibold text-zinc-800">确认继续操作？</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-500">
              {largeSelectionOperationMessage(
                pendingLargeSelectionConfirmation.operation,
                pendingLargeSelectionConfirmation.count
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  pendingLargeSelectionConfirmation.onCancel?.();
                  setPendingLargeSelectionConfirmation(null);
                }}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              >
                取消
              </button>
              <button
                onClick={(e) => {
                  (e.currentTarget as HTMLButtonElement).disabled = true;
                  const action = pendingLargeSelectionConfirmation.onConfirm;
                  setPendingLargeSelectionConfirmation(null);
                  action();
                }}
                className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                确认
              </button>
            </div>
        </ScriptDialog>
      )}

      {pendingEmptyScriptCleanup && (
        <ScriptDialog
          onClose={() => setEmptyScriptCleanupDialog(null)}
          panelClassName="w-[560px] max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-5 shadow-xl"
        >
            <h2 className="text-base font-semibold text-zinc-800">确认清除空白内容？</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              以下章节、段落和排练记号 仅包含空剧本块 或 不包含任何剧本块，可选择移除。
            </p>
            {pendingEmptyScriptCleanup.length > 0 ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-zinc-100 bg-zinc-50/60">
                <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                  <span className="text-xs font-semibold tracking-wide text-zinc-600 uppercase">
                    可清除空白章节/段落/排练记号
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedEmptyScriptCleanupKeys(new Set(
                        pendingEmptyScriptCleanup
                          .filter((target) => !target.disabledReason)
                          .map((target) => target.key)
                      ))}
                      className="text-[11px] font-medium text-[#637ca1]/75 transition-colors hover:text-[#637ca1]"
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedEmptyScriptCleanupKeys(new Set())}
                      className="text-[11px] font-medium text-zinc-400 transition-colors hover:text-[#637ca1]"
                    >
                      清空
                    </button>
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {pendingEmptyScriptCleanup.map((target, index) => {
                    const disabled = !!target.disabledReason;
                    const selected = !disabled && selectedEmptyScriptCleanupKeys.has(target.key);
                    const previousTarget = index > 0 ? pendingEmptyScriptCleanup[index - 1] : null;
                    const entersNewChapter = !!previousTarget &&
                      previousTarget.chapterKey !== target.chapterKey;
                    const nextTarget = pendingEmptyScriptCleanup[index + 1] ?? null;
                    const showSceneDivider = !!nextTarget &&
                      target.chapterKey === nextTarget.chapterKey &&
                      target.kind !== "chapter" &&
                      nextTarget.kind === "rehearsal" &&
                      target.dividerKey !== nextTarget.dividerKey;
                    const kindLabel =
                      target.kind === "chapter" ? "章节" :
                      target.kind === "scene" ? "段落" :
                      "排练记号";
                    const indentClass =
                      target.kind === "chapter" ? "" :
                      target.kind === "scene" ? "pl-6" :
                      "pl-10";
                    return (
                      <React.Fragment key={target.key}>
                        {entersNewChapter ? (
                          <div className="border-t-[3px] border-zinc-900/30" />
                        ) : null}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={selected}
                          disabled={disabled}
                          onClick={() => toggleEmptyScriptCleanupTarget(target)}
                          className={`flex w-full items-center gap-3 border-b px-3 py-2.5 text-left text-sm transition-colors last:border-0 disabled:cursor-not-allowed ${
                            showSceneDivider ? "bg-[linear-gradient(to_right,#a1a1aa_0_9px,transparent_9px_12px)] bg-[length:12px_1px] bg-bottom bg-repeat-x" : ""
                          } ${
                            showSceneDivider ? "border-transparent" : disabled ? "border-zinc-100" : selected ? "border-[#91a8ca]/20" : "border-zinc-50"
                          } ${
                            disabled ? "bg-white/60" : selected ? "bg-[#eef3fa]" : "bg-white hover:bg-zinc-50"
                          } ${indentClass}`}
                        >
                          <span className="shrink-0 rounded border border-[#91a8ca]/30 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-[#637ca1]">
                            {kindLabel}
                          </span>
                          <span className={`min-w-0 truncate ${disabled ? "text-zinc-400" : "text-zinc-700"}`}>{target.label}</span>
                          {target.disabledReason && (
                            <span className="shrink-0 rounded border border-[#91a8ca]/30 bg-[#637ca1] px-2 py-0.5 text-xs text-white">
                              {target.disabledReason}
                            </span>
                          )}
                          <span
                            className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                              disabled ? "bg-zinc-100" : selected ? "bg-[#637ca1]" : "bg-zinc-200"
                            }`}
                          >
                            <span
                              className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                                selected ? "translate-x-4" : ""
                              }`}
                            />
                          </span>
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-zinc-100 bg-zinc-50/60 px-3 py-2 text-sm text-zinc-500">
                无空章节、空段落或空排练记号可移除。
              </p>
            )}
            <p className="mt-3 text-sm leading-6 text-zinc-500">
              如未选择任何条目，点击 “仅清除空白剧本块” 按钮 将清除所有多余的空白剧本块，并保留所有既有构作。上述章节、段落、排练记号下的首个空白剧本块仍会被保留，以便后续编辑。
              <br />
              选择条目后，点击 “清除选中空白内容” 按钮 将清除所选的空白章节、段落或排练记号，以及所有的空白剧本块。
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={() => setEmptyScriptCleanupDialog(null)}
                className={SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS}
              >
                取消
              </button>
              <button
                onClick={() => applyEmptyScriptCleanup(selectedEmptyScriptCleanupKeys)}
                className={selectedEmptyScriptCleanupKeys.size === 0
                  ? "rounded bg-[#637ca1] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#536b8e]"
                  : "rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"}
              >
                {selectedEmptyScriptCleanupKeys.size === 0 ? "仅清除空白剧本块" : "清除选中空白内容"}
              </button>
            </div>
        </ScriptDialog>
      )}

      {pendingStageDelimiterChange && (
        <ScriptDialog
          onClose={() => setPendingStageDelimiterChange(null)}
          panelClassName="w-[420px] rounded-2xl bg-white p-5 shadow-xl"
        >
            <h2 className="text-base font-semibold text-zinc-800">确认切换段内舞台提示括号？</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              切换括号后，剧本中原本由 “
              {pendingStageDelimiterChange.open}
              ” 和 “
              {pendingStageDelimiterChange.close}
              ” 包含的内容也将会被视为块内舞台提示。
              <br />
              如确定需要切换，请选择是否自动更新现有剧本，将所有的块内舞台提示括号更新为 “
              {pendingStageDelimiterChange.open}
              ” 和 “
              {pendingStageDelimiterChange.close}
              ”。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPendingStageDelimiterChange(null)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              >
                取消
              </button>
              <button
                onClick={() => applyStageDelimiterChange(false)}
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
              >
                仅切换括号
              </button>
              <button
                onClick={() => applyStageDelimiterChange(true)}
                className="rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                确认更新
              </button>
            </div>
        </ScriptDialog>
      )}

      {sceneDetailDialogSceneId && productionId && (() => {
        const dialogScene = sceneById.get(sceneDetailDialogSceneId) ?? null;
        if (!dialogScene) return null;
        const dialogSceneDetail = sceneDetailById.get(dialogScene.id) ?? toSceneDetail(dialogScene);
        const chapterDurationDisplay = dialogScene.parentId === null
          ? getChapterDurationDisplay(sceneDetails.filter((scene) => scene.parentId === dialogScene.id))
          : null;
        const durationText = chapterDurationDisplay
          ? chapterDurationDisplay.hasMissingDuration ? "—" : chapterDurationDisplay.text || "—"
          : formatDuration(parseDuration(dialogSceneDetail.expectedDuration)) || "—";
        const sceneCaption = `【${dialogScene.number.trim() || "—"}】${dialogScene.name.trim() || "未命名"}`;
        return (
          <ScriptDialog
            onClose={closeSceneDetailDialog}
            overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
            panelClassName="flex h-[28rem] max-h-[calc(100vh-2rem)] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl bg-white p-5 shadow-xl"
          >
            <div className="flex h-6 shrink-0 items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-zinc-800">
                {sceneDetailDialogEditing ? (
                  <h2 className="truncate">编辑构作详情</h2>
                ) : (
                  <>
                    <p className="min-w-0 flex-1 truncate" title={sceneCaption}>{sceneCaption}</p>
                    <div className="h-4 w-px shrink-0 bg-zinc-200" />
                    <p className="shrink-0 whitespace-nowrap">预期时长：{durationText}</p>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={closeSceneDetailDialog}
                className="flex h-6 w-6 items-center justify-center rounded text-lg leading-none text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-zinc-500"
                title="关闭"
                aria-label="关闭构作详情"
              >
                ×
              </button>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-hidden">
              <ScriptSceneDetailRail
                scene={dialogSceneDetail}
                scenes={sceneDetails}
                productionId={productionId}
                versionId={activeVersionId ?? null}
                canEdit={canEditMetadata}
                controlledEditMode={sceneDetailDialogEditing}
                showHeader={false}
                scrollbarOffsetPx={0}
                onUpdateIdentity={updateScene}
                onPatchMeta={patchSceneMeta}
              />
            </div>
            {canEditMetadata && (
              <div className="mt-5 flex shrink-0 justify-end">
                <button
                  type="button"
                  onClick={() => setSceneDetailDialogEditing((editing) => !editing)}
                  className={`rounded px-3 py-1.5 text-sm font-medium text-white transition-colors ${
                    sceneDetailDialogEditing
                      ? "bg-zinc-800 hover:bg-zinc-700"
                      : "bg-[#637ca1] hover:bg-[#536b8e]"
                  }`}
                >
                  {sceneDetailDialogEditing ? SCRIPT_SCENE_DETAIL_MODE_LABEL.edit : SCRIPT_SCENE_DETAIL_MODE_LABEL.view}
                </button>
              </div>
            )}
          </ScriptDialog>
        );
      })()}

      {/* Mobile block action bottom sheet */}
      {mobileBlockMenuBlockId !== null && (() => {
        const menuBlock = blocks.find(b => b.id === mobileBlockMenuBlockId);
        if (!menuBlock) return null;
        const isMarker = isMarkerBlock(menuBlock);
        const isBatchMode = !isMarker && selectedBlockIds.size > 1;
        const actionBlock = isBatchMode
          ? blocks.find(block => selectedBlockIds.has(block.id) && !isMarkerBlock(block)) ?? menuBlock
          : menuBlock;
        const isStageBlock = actionBlock.type === "stage";
        const hasLyricBlock = !!actionBlock.lyric;
        const hasLyricCfg = tagGroups.some(g => !!g.lyricSplitAfterOptionId);
        const commentCount = commentsByBlockId.get(mobileBlockMenuBlockId)?.length ?? 0;
        const batchCount = selectedBlockIds.size;
        const insertActions: Array<[string, () => void]> = [
          ...(canEditMetadata ? [
            ["添加新章", () => addChapterBeforeBlock(menuBlock.id)] as [string, () => void],
            ["添加新段", () => addSceneBeforeBlock(menuBlock.id)] as [string, () => void],
          ] : []),
          ...(canAddRehearsalMark ? [
            ["添加新排练记号", () => addRehearsalBeforeBlock(menuBlock.id)] as [string, () => void],
          ] : []),
        ];
        const conversionActions: Array<[string, () => void]> = isMarker && canEditMetadata ? [
          ...(menuBlock.type !== "chapter_marker"
            ? [["转为章节", () => convertMarkerBlockType(menuBlock.id, "chapter_marker")] as [string, () => void]]
            : []),
          ...(menuBlock.type !== "scene_marker"
            ? [["转为段落", () => convertMarkerBlockType(menuBlock.id, "scene_marker")] as [string, () => void]]
            : []),
        ] : [];
        const detailSceneId = productionId && menuBlock.sceneId && (
          menuBlock.type === "chapter_marker" || menuBlock.type === "scene_marker"
        ) ? menuBlock.sceneId : null;
        const canDeleteMenuBlock = isMarker
          ? menuBlock.type === "rehearsal_marker" ? effectiveCanEditRehearsalMark : canEditMetadata
          : canEditText;
        const runAndClose = (action: () => void) => {
          closeMobileBlockMenu();
          action();
        };
        return (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-end sm:hidden">
            <div
              data-script-selection-action="true"
              data-script-mobile-block-menu="true"
              className="pointer-events-auto max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-[var(--surface)] border-t border-[var(--line)] shadow-2xl"
            >
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-10 h-1 rounded-full bg-zinc-200" />
              </div>
              {isBatchMode && (
                <p className="px-5 py-2 text-xs text-zinc-400">已选中 {batchCount} 行</p>
              )}
              <div className="flex flex-col">
                {mobileBatchAction && (
                  <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-3.5">
                    <span className="min-w-0 text-sm leading-5 text-zinc-500">
                      确认修改所选 {batchCount} 行{mobileBatchAction === "type" ? "类型" : "文本状态"}？
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          const action = mobileBatchAction;
                          setMobileBatchAction(null);
                          if (!canPerformSelectedBlockAction(selectedBlockIdsArray)) return;
                          closeMobileBlockMenu();
                          requestLargeSelectionOperation(action, batchCount, () => {
                            if (action === "type") {
                              setBlocksType(selectedBlockIdsArray, isStageBlock ? "dialogue" : "stage");
                            } else {
                              setBlocksLyric(selectedBlockIdsArray, !hasLyricBlock);
                            }
                          });
                        }}
                        className="text-sm text-red-500 hover:text-red-700"
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => setMobileBatchAction(null)}
                        className="text-sm text-zinc-400 hover:text-zinc-600"
                      >
                        取消
                      </button>
                    </span>
                  </div>
                )}
                {!isBatchMode && insertActions.length > 0 && (
                  <>
                    <button
                      onClick={() => setMobileInsertMenuOpen((open) => !open)}
                      className="flex w-full items-center justify-between border-t border-zinc-100 px-5 py-3.5 text-left text-[15px] text-zinc-700"
                      aria-expanded={mobileInsertMenuOpen}
                    >
                      <span>在块前添加</span>
                      <ChevronIcon size={16} className={`text-zinc-400 transition-transform ${mobileInsertMenuOpen ? "rotate-180" : ""}`} />
                    </button>
                    {mobileInsertMenuOpen && insertActions.map(([label, action]) => (
                      <button
                        key={label}
                        onClick={() => runAndClose(action)}
                        className="w-full border-t border-zinc-100 bg-zinc-50 px-8 py-3 text-left text-[14px] text-zinc-600"
                      >
                        {label}
                      </button>
                    ))}
                  </>
                )}
                {conversionActions.map(([label, action]) => (
                  <button
                    key={label}
                    onClick={() => runAndClose(action)}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                  >
                    {label}
                  </button>
                ))}
                {detailSceneId && (
                  <>
                    <p className="border-t border-zinc-100 px-5 pt-3 pb-1 text-xs font-medium text-zinc-400">详情</p>
                    <button
                      onClick={() => runAndClose(() => openSceneDetailDialog(detailSceneId))}
                      className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700"
                    >
                      查看构作详情
                    </button>
                  </>
                )}
                {!isMarker && canEditText && !isStageBlock && !hasLyricCfg && (
                  <button
                    onClick={() => {
                      if (isBatchMode) {
                        setMobileBatchAction("lyric");
                      } else {
                        toggleBlockLyric(mobileBlockMenuBlockId);
                        closeMobileBlockMenu();
                      }
                    }}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                  >
                    {hasLyricBlock ? "转为台词" : "转为歌词"}
                  </button>
                )}
                {!isMarker && canEditText && (
                  <button
                    onClick={() => {
                      if (isBatchMode) {
                        setMobileBatchAction("type");
                      } else {
                        toggleBlockType(mobileBlockMenuBlockId);
                        closeMobileBlockMenu();
                      }
                    }}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                  >
                    {isStageBlock ? "转为台词" : "转为舞台提示"}
                  </button>
                )}
                {!isMarker && !isBatchMode && (
                  <>
                    <button
                      onClick={() => { openBlockSidePanel("asset", mobileBlockMenuBlockId); closeMobileBlockMenu(); }}
                      className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                    >
                      附件
                    </button>
                    <button
                      onClick={() => { openBlockSidePanel("comment", mobileBlockMenuBlockId); closeMobileBlockMenu(); }}
                      className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                    >
                      {commentCount > 0 ? `评论（${commentCount}）` : "评论"}
                    </button>
                  </>
                )}
                {canDeleteMenuBlock && (
                  <button
                    onClick={() => {
                      closeMobileBlockMenu();
                      requestMobileDelete(actionBlock.id);
                    }}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-red-500 border-t border-zinc-100"
                  >
                    {isBatchMode ? `删除所选 ${batchCount} 行` : isMarker ? "删除此标记" : "删除此行"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeMobileBlockMenu}
                  className="w-full border-t border-zinc-100 px-5 py-3.5 text-center text-[15px] font-medium text-zinc-600"
                >
                  取消
                </button>
              </div>
              <div className="h-6" />
            </div>
          </div>
        );
      })()}

      {mobileDeleteConfirmation && (() => {
        const blocked = mobileDeleteConfirmation.kind === "blocks" && mobileDeleteConfirmation.blocked;
        const cancel = () => {
          setMobileDeleteConfirmation(null);
          dismissBlockConfirmations();
        };
        const confirm = () => {
          const request = mobileDeleteConfirmation;
          setMobileDeleteConfirmation(null);
          dismissBlockConfirmations();
          if (request.kind === "marker") {
            deleteMarker(request.markerId);
            return;
          }
          if (request.blocked) return;
          requestLargeSelectionOperation("delete", request.blockIds.length, () => {
            deleteBlocks(request.blockIds);
          });
        };
        return (
          <ScriptDialog
            onClose={cancel}
            overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
            panelClassName="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
          >
            <h2 className="text-base font-semibold text-zinc-800">
              {blocked ? "无法删除" : "确认删除？"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              {mobileDeleteConfirmation.message}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={cancel} className={SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS}>
                取消
              </button>
              <button onClick={confirm} className={SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS}>
                确认
              </button>
            </div>
          </ScriptDialog>
        );
      })()}

      {/* 关于 modal */}
      {aboutOpen && (
        <ScriptDialog
          onClose={() => setAboutOpen(false)}
          panelClassName="w-[420px] rounded-2xl bg-white p-6 shadow-xl"
        >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-zinc-800">关于 · 快捷键</h2>
              <button onClick={() => setAboutOpen(false)} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">✕</button>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-50">
                {SCRIPT_SHORTCUTS.map(([combo, desc]) => (
                  <tr key={combo}>
                    <td className="py-1.5 pr-4 font-mono text-[13px] text-zinc-400 whitespace-nowrap">{formatShortcut(combo, isMac)}</td>
                    <td className="py-1.5 whitespace-pre-line text-zinc-600">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        </ScriptDialog>
      )}
    </div>
  );
}
