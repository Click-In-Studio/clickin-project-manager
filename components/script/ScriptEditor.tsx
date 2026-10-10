"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import MountPointAssets from "@/components/assets/MountPointAssets";
import MarkerDeleteDialog, { type MarkerDeleteDialogState } from "@/components/script/MarkerDeleteDialog";
import ModeSwitch from "@/components/script/ModeSwitch";
import ScriptDialog, { SCRIPT_CONFIRM_CANCEL_BUTTON_CLASS, SCRIPT_CONFIRM_PRIMARY_BUTTON_CLASS } from "@/components/script/ScriptDialog";
import TagGroupEditor from "@/components/script/TagGroupEditor";
import ProductionTopMenu, { ProductionOverflowSubmenuButton, ProductionTopMenuContext, ProductionTopMenuDivider, PRODUCTION_TOP_MENU_RIGHT_CLASS, useProductionToolbarStage } from "@/components/shell/ProductionTopMenu";
import ChevronIcon from "@/components/ui/ChevronIcon";
import PageSkeleton from "@/components/ui/PageSkeleton";
import Kbd from "@/components/ui/Kbd";
import { formatShortcut, useIsMacLike } from "@/components/ui/shortcut-label";
import { useScriptRecovery } from "./script-editor/use-script-recovery";

import { useDocumentVisible } from "@/hooks/useVisibleEventSource";
import { useAgentMutation } from "@/lib/agent/agent-mutations";
import { BASE_PATH } from "@/lib/base-path";

import type { TagGroup, BlockTagValue } from "@/lib/script/script-block-tag-db";

import { formatDuration, parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/ops/scene-duration";
import { isTextBlock, sameCharacters, shouldHideCharacterLabel, shouldShowCharacterGap, shouldShowSceneEndGap } from "@/lib/script/script-block-layout";
import { uid, makeBlock, makeMarkerBlock, isBlockEmptyForDelete, isEmptyTextBlock, normalizeScriptMarkerInvariants, insertMarkerWithEmptyBlockIfNeeded, insertScriptBlockAt, findTocSceneBlockIndex, findSceneMarkerBlockIndex, markerChangeFromOperations } from "@/lib/script/script-block-stream";
import { resolveDragTarget, getDragInsertIndex, type DragTarget } from "@/lib/script/script-drag-target";
import { buildEmptyScriptCleanupRemovalPlan, isOnlyTextBlockInMarkerSegment, analyzeEmptyScriptCleanup, type EmptyScriptCleanupTarget } from "@/lib/script/script-empty-cleanup";
import { publishScriptFocus } from "@/lib/script/script-focus";

import { hasScriptInsertionGapBefore, sceneParentIdMap } from "@/lib/script/script-insertion-gaps";
import { LARGE_SELECTION_BLOCK_THRESHOLD, largeSelectionOperationMessage, type LargeSelectionOperation, type PendingLargeSelectionConfirmation } from "@/lib/script/script-large-selection";
import { isMarkerBlock } from "@/lib/script/script-marker-blocks";
import { convertMarker, executeMarkerDeletion, getMarkerChange, insertMarker, planMarkerDeletion, type BlockChange, type MarkerDeleteOperation } from "@/lib/script/script-marker-domain";

import { mdToHtml } from "@/lib/script/script-md";


import { sceneDetailDeleteBlockedMessage, markerBlockDramaturgyDeleteBlockedKind, markerDetailFields, markerExpectedDuration, toSceneDetail, type SceneMetaFields, type MarkerDetailDeleteBlockedKind, type NonEmptyDramaturgyMarker, type MarkerDetailField } from "@/lib/script/script-scene-details";

import { DEFAULT_SCRIPT_CONFIG, type Block, type BlockType, type Character, type ScriptState, type ScriptConfig } from "@/lib/script/script-types";
import { type ScriptWindowBootstrap, type ScriptWindowResponse } from "@/lib/script/script-window-types";
import BlockGap from "./script-editor/BlockGap";
import CharacterPanel from "./script-editor/CharacterPanel";
import CommentsPanel, { preloadCommentsPanel } from "./script-editor/CommentsPanelLazy";
import InsertZone from "./script-editor/InsertZone";
import PresenceAvatar from "./script-editor/PresenceAvatar";
import ScenePanel from "./script-editor/ScenePanel";
import ScriptBlock from "./script-editor/ScriptBlock";
import ScriptMarkerRow, { type ScriptMarkerNode } from "./script-editor/ScriptMarkerRow";
import ScriptModeMenu from "./script-editor/ScriptModeMenu";
import RehearsalModeDialog from "./script-editor/RehearsalModeDialog";
import ScriptSceneDetailRail from "./script-editor/ScriptSceneDetailRail";
import ScriptToolbarMenuController, { type ScriptToolbarOpenMenu } from "./script-editor/ScriptToolbarMenuController";
import SideBlockPanel from "./script-editor/SideBlockPanel";
import TableOfContents from "./script-editor/TableOfContents";
import { EMPTY_COMMENTS, EMPTY_BLOCK_ASSETS, buildCommentBlockCaption, findSideBlockPanelNavigationTargets, type RemotePresence } from "./script-editor/comments";
import { SCRIPT_TOC_CENTER_EVENT, SCRIPT_EDITOR_MAX_WIDTH_PX, SCRIPT_BODY_HORIZONTAL_PADDING_REM, SCRIPT_PRODUCTION_SIDEBAR_FULL_WIDTH_PX, SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM, SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM, SCRIPT_TOC_RAIL_COMPACT_NUMBER_PADDING_REM, SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM, SCRIPT_SCENE_DETAIL_RAIL_MAX_WIDTH_PX, SCRIPT_SCENE_DETAIL_RAIL_RIGHT_INSET_PX, SCRIPT_SCENE_DETAIL_MODE_LABEL, SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX, DISABLED_CHECKBOX_OPTION_CLASS, checkboxOptionClass, COMMENT_BUBBLE_MIN_WIDTH_PX, COMMENT_BUBBLE_GAP_REM, SIDE_PANEL_FALLBACK_WIDTH_PX, SCRIPT_SHORTCUTS } from "./script-editor/constants";
import { DEFAULT_DISPLAY, writeDisplayCookie, type DisplaySettings } from "./script-editor/display-settings";
import { useScriptSearch } from "./script-editor/use-script-search";
import { useDragCountBadge } from "./script-editor/use-drag-count-badge";
import { useReorderLock } from "./script-editor/use-reorder-lock";
import {
  fetchScriptState, fetchScriptWindow, fetchScriptWindowBootstrap, searchScriptWindow, fetchScriptPageMap, loadScriptEnvelope, patchScript, putScriptConfig,
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
import { useScriptWindowPrefetch } from "./script-editor/use-script-window-prefetch";
import { useWorkspaceWidth } from "./script-editor/use-workspace-width";
import { useStoredScriptPersonalMode, type ScriptPersonalMode } from "./script-editor/personal-mode";
import { useScriptPersonalModeTransition } from "./script-editor/use-script-personal-mode-transition";

import { insertLineBreakAtTextOffset, setCursorAtStart, setCursorAtEnd, setCursorAtTextOffset, getEditableElementForRange, isTextEditingTarget, isFormEditingTarget, getTextLength } from "./script-editor/dom-cursor";
import { getScrollEl, getScrollMetrics, scrollContainerBy, scrollElementIntoView, estimateVirtualScrollAnchor, measureScriptTocNumberWidths, clearTimeoutMap, markProgrammaticScroll } from "./script-editor/dom-scroll";
import { replaceInlineStageDelimiters, toggleInlineTag, wrapSelectionAsInlineStageCue } from "./script-editor/inline-stage";
import { EDITABLE_MODE_VISIBLE_PRESENCE_AVATARS, REHEARSAL_MODE_VISIBLE_PRESENCE_AVATARS, presenceColor } from "./script-editor/presence";
import { ScriptWindowRequests } from "./script-editor/script-window-requests";
import { useScriptDocument } from "./script-editor/use-script-document";
import { useScriptSync } from "./script-editor/use-script-sync";
import { useScriptSelection } from "./script-editor/use-script-selection";
import { useScriptHistory } from "./script-editor/use-script-history";
import { useScriptDrag } from "./script-editor/use-script-drag";
import { useScriptNavigation } from "./script-editor/use-script-navigation";
import { flushSync } from "react-dom";

type PendingStageDelimiterChange = {
  open: string;
  close: string;
};

// 打印相关组件已抽到 components/print/ScriptPrint.tsx（#335）

// 自动同步（#520）：trailing 1.5s，但自第一次改动起最迟 5s 必落一笔——
// 连续打字不再无界不落库（丢数据窗口 / 协作延迟 / presence 先于内容到达）。

export default function ScriptEditor({
  scriptId = "default",
  productionId,
  productionName,
  canEditText: canEditTextProp = true,
  canEditMetadata: canEditMetadataProp = true,
  canEditLayout = true,
  canEditRehearsalMark = true,
  initialDisplay = DEFAULT_DISPLAY,
  initialSearchQuery,
  initialVersionId = null,
  initialWindow = null,
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
  initialDisplay?: DisplaySettings;
  initialSearchQuery?: string;
  /** 服务端解析好的活跃版本（#641）：不给的话首帧是 null，首个请求不带 ?v=，
   *  回包的 versionId 一 set 就把加载 effect 的依赖改了——整本剧本要再拉一遍。 */
  initialVersionId?: string | null;
  initialWindow?: ScriptWindowBootstrap | null;
}) {
  const toolbarStage = useProductionToolbarStage();
  const effectiveScriptId = productionId ?? scriptId;

  // ── Version state ─────────────────────────────────────────────────────────────
  // 版本退役 Phase B：版本恒为 head（服务端解析活跃版本），无选择、无状态门。
  const [activeVersionId, setActiveVersionId] = useState<string | null>(initialVersionId);

  const baseCanEditText = canEditTextProp;
  const baseCanEditMetadata = canEditMetadataProp;
  const baseCanEditTextLayout = canEditLayout;
  const baseCanEdit = baseCanEditText || baseCanEditMetadata || baseCanEditTextLayout || canEditRehearsalMark;
  const [rehearsalMode, setRehearsalMode] = useState(initialDisplay.rehearsalMode);
  const [personalMode, setPersonalMode, personalModeReady] = useStoredScriptPersonalMode(effectiveScriptId);
  const [recoveryLocked, setRecoveryLocked] = useState(false);

  const recoveryTriggerRef = useRef<() => void>(() => {});
  const isContentLocked = recoveryLocked || !personalModeReady || !baseCanEdit || personalMode === "read" || rehearsalMode;
  const canEditTextLayout = baseCanEditTextLayout && !isContentLocked;
  const canEditText = baseCanEditText && !isContentLocked;
  const canEditMetadata = baseCanEditMetadata && !isContentLocked;
  const effectiveCanEditRehearsalMark = canEditRehearsalMark && !isContentLocked;

  const canEdit = canEditText || canEditMetadata || effectiveCanEditRehearsalMark;
  const [windowRequests] = useState(() => new ScriptWindowRequests());
  const { document: script, snapshot: scriptDocument } = useScriptDocument(initialWindow);
  const { blocks, characters, scenes, sceneDetails, tagGroups, tags: blockTagMap, config: scriptConfig,
    loadedIds: loadedBlockIds, ownedBlocks, markerContextById, legacyProjectedBlocks, rehearsalLabels, pageMap } = scriptDocument;
  const { selection, snapshot: selectionState } = useScriptSelection(script);


  const { navigation, explicitLoadTargetIndex } = useScriptNavigation(script);
  const { drag, snapshot: dragView } = useScriptDrag();



  const remoteScriptSearch = useCallback((query: string, exact: boolean, signal: AbortSignal) => (
    activeVersionId
      ? searchScriptWindow(effectiveScriptId, activeVersionId, query, exact, signal)
      : Promise.resolve(null)
  ), [activeVersionId, effectiveScriptId]);

  const {
    focusedCharacterIds, pendingAggregateFocusPrompt,
    toggleCharacterFocus, clearCharacterFocus,
    confirmAggregateFocusPrompt, addAllAggregateFocusPrompt, cancelAggregateFocusPrompt, togglePendingAggregateFocus,
  } = useCharacterFocus({ effectiveScriptId, characters });







  const applyWindowBootstrapRef = useRef<(bootstrap: ScriptWindowBootstrap) => void>(() => {});

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);
  const dragTarget = dragView.target;
  const isScriptDragging = dragView.dragging;
  const [selectionChangeNotice, setSelectionChangeNotice] = useState("");
  const selectedBlockIds = selectionState.selectedIds;
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



  const invalidSelectionEndIds = selectionState.invalidEndIds;
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



  const tagClipboardRef = useRef<BlockTagValue[] | null>(null);

  // ── Script config (page layout, stage delimiters) ─────────────────────────


  const canAddRehearsalMark = effectiveCanEditRehearsalMark && scriptConfig.useRehearsalMarks;

  const [aboutOpen, setAboutOpen] = useState(false);
  const isMac = useIsMacLike(); // 「关于 · 快捷键」表格按平台显示 ⌘ / Ctrl（#542）
  const [pendingRehearsalMode, setPendingRehearsalMode] = useState<boolean | null>(null);
  const [rehearsalModeSwitchPending, setRehearsalModeSwitchPending] = useState(false);
  const [rehearsalModeSwitchError, setRehearsalModeSwitchError] = useState("");
  const flushPendingPatchRef = useRef<() => Promise<boolean>>(async () => false);
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
    if (!baseCanEditTextLayout || isContentLocked) return;
    const previous = script.getSnapshot().config;
    const next = { ...previous, ...patch };
    script.editConfig(next);
    const ok = await putScriptConfig(effectiveScriptId, activeVersionId, next);
    if (!ok && script.getSnapshot().config === next) {
      script.editConfig(previous);
    }
  }, [activeVersionId, baseCanEditTextLayout, effectiveScriptId, isContentLocked, script]);

  // 开场章 = 排在最前的 chapter_marker，是块序列的派生值（#636）：只更新本地 config，
  // 不 PUT 回服务端——服务端读时自己从块算，落库反而多一个会漂的写点。

  const requestStageDelimiterChange = useCallback((open: string, close: string) => {
    if (scriptConfig.stageDelimOpen === open && scriptConfig.stageDelimClose === close) {
      closeToolbarMenu();
      return;
    }
    setPendingStageDelimiterChange({ open, close });
    closeToolbarMenu();
  }, [closeToolbarMenu, scriptConfig.stageDelimOpen, scriptConfig.stageDelimClose]);

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

  const reloadScriptState = useCallback(async () => {
    if (initialWindow && activeVersionId) {
      const bootstrap = await fetchScriptWindowBootstrap(effectiveScriptId, activeVersionId, windowRangeRef.current.start, INITIAL_WINDOW_SIZE);
      if (!bootstrap) throw new Error("Failed to reload script window");
      applyWindowBootstrapRef.current(bootstrap);
      return;
    }
    const state = await fetchScriptState(effectiveScriptId, activeVersionId);
    if (!state) throw new Error("Failed to reload script state");
    script.replaceServer(state);
  }, [activeVersionId, effectiveScriptId, initialWindow, script]);
  // AI 写剧本（scope "script" 的 mutation 信号）落库后整体重载——最粗但最稳的粒度：
  // reloadScriptState 会通过正文维护者重建基线，后续 diff 以新服务端状态为基准，
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

  const {
    display, setDisplay, toggleDisplay,
    lineIndexMeasureRef, lineIndexMinMeasureRef, lineIndexWidthStyle, markerLineIndexWidthStyle,
  } = useDisplaySettings({ maxLineIndexText, initialDisplay });

  const {
    isReorderLocked, reorderNotice, isReorderLockedRef, stop: stopReorder,
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
    stopReorder();
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
    navigation.stop();
  }, [stopReorder, navigation, presenceLayoutTimerRef, presenceTimerRef]);

  const taRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const mobileBlockMenuCaretRef = useRef<{ blockId: string; textOffset: number | null } | null>(null);
  const pendingFocus = useRef<{ id: string; textOffset?: number; atEnd?: boolean } | null>(null);
  const pendingCharOpen = useRef<string | null>(null);





  const windowRangeFrameRef = useRef<number | null>(null);

  const selectionChangeNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedHighlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const tocMarkerGlowTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const suppressProgrammaticScrollRef = useRef(false);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const navigatingAwayRef = useRef(false);
  const { toolbarCompact, toolbarShort, presenceFolded, setToolbarElement, setToolbarMeasureTick, resetToolbarMeasurement } = useScriptToolbarFold({
    toolbarStage, navigatingAwayRef, toolbarOpenMenuRef, closeToolbarMenu, activeVersionId, isLockedMode: isContentLocked, canEditMetadata,
  });
  const clampWindowRange = useCallback((range: { start: number; end: number }, blockCount = script.getSnapshot().blocks.length) => (
    clampWindowRangePure(range, blockCount)
  ), [script]);
  useEffect(() => () => {
    windowRequests.cancel();
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    pendingWindowRangeRef.current = null;
    if (programmaticScrollFrameRef.current !== null) cancelAnimationFrame(programmaticScrollFrameRef.current);
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    clearTimeoutMap(movedHighlightTimersRef.current);
    clearTimeoutMap(tocMarkerGlowTimersRef.current);
  }, [stopReorder, windowRequests]);

  const blocksContainerRef = useRef<HTMLDivElement>(null);
  const { dragCountBadgeRef, beginDragCountBadge, clearDragCountBadge, updateDragCountBadge } = useDragCountBadge({ blocksContainerRef });

  const resetScriptInteractions = useCallback(() => {
    selection.clear();
    drag.end();
    pendingFocus.current = null;
    pendingCharOpen.current = null;
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setDeleteConfirmationRequest(null);
    setMarkerDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
    clearDragCountBadge();
    window.getSelection()?.removeAllRanges();
  }, [clearDragCountBadge, drag, selection]);

  const toggleRehearsalMode = useCallback(() => {
    setRehearsalModeSwitchError("");
    setPendingRehearsalMode(!rehearsalMode);
    closeToolbarMenu();
  }, [closeToolbarMenu, rehearsalMode]);

  const confirmRehearsalModeChange = useCallback(async () => {
    if (pendingRehearsalMode === null) return;
    setRehearsalModeSwitchError("");
    setRehearsalModeSwitchPending(true);
    if (pendingRehearsalMode && personalMode === "edit" && !await flushPendingPatchRef.current()) {
      setRehearsalModeSwitchError("尚有内容未保存，已保留编辑模式，请稍后重试。");
      setRehearsalModeSwitchPending(false);
      return;
    }
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
    setRehearsalMode(pendingRehearsalMode);
    setDisplay(prev => {
      const next = { ...prev, rehearsalMode: pendingRehearsalMode };
      writeDisplayCookie(next);
      return next;
    });
    setPendingRehearsalMode(null);
    setRehearsalModeSwitchPending(false);
  }, [closeToolbarMenu, pendingRehearsalMode, personalMode, resetScriptInteractions, setDisplay]);

  const showSelectionChangeNotice = useCallback((message: string) => {
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    setSelectionChangeNotice(message);
    selectionChangeNoticeTimer.current = setTimeout(() => {
      selectionChangeNoticeTimer.current = null;
      setSelectionChangeNotice("");
    }, 1800);
  }, []);

  const clearBlockSelection = selection.clear;

  const canPerformSelectedBlockAction = useCallback((ids: string[]) => {
    const valid = selection.validate(ids);
    if (!valid) showSelectionChangeNotice("每个选中范围的最后一行必须是剧本行。");
    return valid;
  }, [selection, showSelectionChangeNotice]);

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
  const [windowRange, setWindowRange] = useState(() => initialWindow
    ? {
        start: initialWindow.window.start,
        end: Math.min(blocks.length, initialWindow.window.start + initialWindow.window.blocks.length),
      }
    : { start: 0, end: Math.min(INITIAL_WINDOW_SIZE, blocks.length) });
  const windowRangeRef = useRef(windowRange);
  useLayoutEffect(() => { windowRangeRef.current = windowRange; }, [windowRange]);
  const pendingWindowRangeRef = useRef<{ start: number; end: number } | null>(null);
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });


  const [windowLoadSlow, setWindowLoadSlow] = useState(false);
  const [windowLoadFailed, setWindowLoadFailed] = useState(false);
  const [windowRetryToken, setWindowRetryToken] = useState(0);


  // Pending navigation: set before windowRange update, consumed by useLayoutEffect after DOM commit

  // After the initial estimated scroll, store the target for a precise correction after measurement

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
  }, [isContentLocked, scriptConfig.textLayoutMode, restoreVirtualScrollAnchor]);

  const requestVirtualWindowRefresh = useCallback(() => {
    navigation.refreshAtAnchor(captureVirtualScrollAnchor());
  }, [captureVirtualScrollAnchor, navigation]);

  const applyWindowRange = useCallback((next: { start: number; end: number }, sync = false, preserveAnchor = false, flushCommit = false) => {
    const targetRange = clampWindowRange(next);
    const pending = pendingWindowRangeRef.current;
    const current = pending ?? windowRangeRef.current;
    if (current.start === targetRange.start && current.end === targetRange.end) return;
    if (preserveAnchor) {
      // 视口里一个已渲染块都没有（快速滚动冲进 spacer 空白区）时抓不到 DOM 锚，
      // 退回按估算累计表合成的锚——否则视口上方缓冲区的估算误差会整体位移（#508）。
      const container = blocksContainerRef.current;
      navigation.preserveAnchor(captureVirtualScrollAnchor()
        ?? (container ? estimateVirtualScrollAnchor(container, script.getSnapshot().blocks, cumulativeHRef.current) : null));
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
  }, [captureVirtualScrollAnchor, clampWindowRange, navigation, script]);

  // Rebuild cumulative heights from cache
  const rebuildCumulative = useCallback(() => {
    cumulativeHRef.current = buildCumulativeHeights(
      script.getSnapshot().ownedBlocks,
      measuredHeightsRef.current,
      measuredHeightTotalRef.current,
      openingChapterVisible ? null : script.getSnapshot().config.openingChapterMarkerId,
      DEFAULT_BLOCK_H,
    );
  }, [openingChapterVisible, script]);
  const syncSpacerHeights = useCallback((range: { start: number; end: number }, anchor: { id: string; top: number } | null = null) => {
    const { top, bot } = spacerHeightsFor(cumulativeHRef.current, range, script.getSnapshot().blocks.length, DEFAULT_BLOCK_H);
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${top}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${bot}px`;
    if (anchor) restoreVirtualScrollAnchor(anchor);
    const next = { top, bot };
    setSpacerH((prev) => prev.top === top && prev.bot === bot ? prev : next);
  }, [restoreVirtualScrollAnchor, script]);
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
    resolveActiveSceneIdForBlockIndexPure(script.getSnapshot().blocks, script.getSnapshot().ownedBlocks, script.getSnapshot().sceneIdSet, index, VSCROLL_BUFFER)
  ), [script]);

  const updateActiveSceneFromScroll = useCallback(() => {
    const container = blocksContainerRef.current;
    const bl = script.getSnapshot().blocks;
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
      const blockIdx = script.getSnapshot().blockIndexById.get(id) ?? -1;
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
  }, [blockAtOffset, resolveActiveSceneIdForBlockIndex, script]);

  const recomputeWindow = useCallback(() => {
    if (navigatingAwayRef.current) return false;
    if (drag.read()?.ids[0] || isReorderLockedRef.current) return false;
    const container = blocksContainerRef.current;
    const bl = script.getSnapshot().blocks;
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
      const idx = script.getSnapshot().blockIndexById.get(id) ?? -1;
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

    const fi = focusedIdRef.current ? script.getSnapshot().blockIndexById.get(focusedIdRef.current) ?? -1 : -1;
    const pfi = pendingFocus.current ? script.getSnapshot().blockIndexById.get(pendingFocus.current.id) ?? -1 : -1;
    const next = nextWindowRange(windowRangeRef.current, firstVisibleIdx, lastVisibleIdx, bl.length, VSCROLL_BUFFER, [fi, pfi]);
    if (!next) {
      return updateActiveSceneFromScroll();
    }

    applyWindowRange(next, true, true, true);
    return updateActiveSceneFromScroll();
  }, [drag, isReorderLockedRef, script, applyWindowRange, updateActiveSceneFromScroll, blockAtOffset]);

  type LoadState = "loading" | "ready" | "not-found" | "error";
  const [loadState, setLoadState] = useState<LoadState>(initialWindow ? "ready" : "loading");
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
        const idx = script.getSnapshot().blockIndexById.get(savedId) ?? 0;
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
      navigation.cancelJump();
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
        navigation.finishCorrection();
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
  }, [navigation, recomputeWindow, updateActiveSceneFromScroll]);

  useEffect(() => {
    updateActiveSceneFromScroll();
  }, [blocks.length, updateActiveSceneFromScroll]);

  useLayoutEffect(() => {
    const bl = script.getSnapshot().blocks;
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
    const pendingFocusIdx = pendingFocusId ? script.getSnapshot().blockIndexById.get(pendingFocusId) ?? -1 : -1;
    if (pendingFocusIdx >= 0) {
      start = Math.min(start, pendingFocusIdx);
      end = Math.max(end, pendingFocusIdx + 1);
    }
    applyWindowRange({ start, end }, true, true);
  }, [blocks.length, applyWindowRange, script]);

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
      const anchor = navigation.readCenter() === null ? captureVirtualScrollAnchor() : null;
      syncSpacerHeights(windowRangeRef.current, anchor);
      // If there's a pending navigation correction, trigger the layout effect that will re-scroll
      if (navigation.readCorrection()) {
        setCorrectionTick(t => t + 1);
      }
    }
  }, [captureVirtualScrollAnchor, navigation, rebuildCumulative, syncSpacerHeights]);

  // Measure rendered block heights after each render pass
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const container = blocksContainerRef.current;
    if (!container) return;
    measureVirtualItemElements(container.querySelectorAll<HTMLElement>('[data-vitem]'));
  }, [blocks.length, scriptConfig.textLayoutMode, windowRange.start, windowRange.end, measureVirtualItemElements]);

  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    if (!navigation.consumeRefresh()) return;
    rebuildCumulative();
    const anchor = navigation.readAnchor();
    if (anchor) {
      const anchorIdx = script.getSnapshot().blockIndexById.get(anchor.id) ?? -1;
      const currentRange = windowRangeRef.current;
      if (anchorIdx >= 0 && (anchorIdx < currentRange.start || anchorIdx >= currentRange.end)) {
        const windowSize = Math.min(INITIAL_WINDOW_SIZE, script.getSnapshot().blocks.length);
        let start = Math.max(0, anchorIdx - Math.floor(windowSize / 2));
        const end = Math.min(script.getSnapshot().blocks.length, start + windowSize);
        start = Math.max(0, end - windowSize);
        applyWindowRange({ start, end }, true, false, true);
        return;
      }
    }
    const container = blocksContainerRef.current;
    if (container) {
      measureVirtualItemElements(container.querySelectorAll<HTMLElement>("[data-vitem]"));
    }
    navigation.finishAnchor();
    syncSpacerHeights(windowRangeRef.current, anchor);
    updateActiveSceneFromScroll();
  }, [blocks, applyWindowRange, measureVirtualItemElements, rebuildCumulative, syncSpacerHeights, updateActiveSceneFromScroll, navigation, script]);

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
    const centerTarget = navigation.readCenter();
    if (centerTarget === null) return;
    if (blocks.length === 0) {
      navigation.takeCenter();
      return;
    }
    const currentTargetIndex = script.getSnapshot().blockIndexById.get(centerTarget);
    if (currentTargetIndex === undefined) {
      navigation.takeCenter();
      return;
    }
    const windowSize = Math.min(INITIAL_WINDOW_SIZE, blocks.length);
    const centerIdx = Math.max(0, Math.min(blocks.length - 1, currentTargetIndex));
    let start = Math.max(0, centerIdx - Math.floor(windowSize / 2));
    const end = Math.min(blocks.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    navigation.takeCenter();
    const nextRange = { start, end };
    const currentRange = windowRangeRef.current;
    const rangeChanged = currentRange.start !== nextRange.start || currentRange.end !== nextRange.end;
    navigation.jump({ kind: "block", id: centerTarget, align: "center" });
    applyWindowRange(nextRange, true, false, true);
    if (!rangeChanged) {
      const el = document.getElementById(`block-${centerTarget}`);
      const scrollEl = getBlockScrollElement(centerTarget);
      if (scrollEl || el) {
        navigation.completeJump(false);
        rebuildCumulative();
        syncSpacerHeights(windowRangeRef.current);
        markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
        (scrollEl ?? el)?.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
  }, [blocks, applyWindowRange, getBlockScrollElement, rebuildCumulative, syncSpacerHeights, navigation, script]);

  // 窗口 commit 后：先把 spacer 对齐新窗口，再把 commit 前抓的锚点块拉回原位。
  // 顺序不能反——spacer 一变，锚点块就跟着位移；先恢复锚点再改 spacer 等于白恢复。
  // 测量 effect 只在窗口里有没量过的块时才顺手同步 spacer（带锚）；窗口里全是量过的块
  // （窗口触底后每滚一格平移一块、或来回滚过的区段）就只靠这里——之前这一步在锚点恢复
  // 之后无锚执行，表现为每格回弹一块高、快速上滚回弹一两幕（#508）。
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    syncSpacerHeights(windowRange);
    const anchor = navigation.readAnchor();
    if (!anchor) return;
    navigation.finishAnchor();
    restoreVirtualScrollAnchor(anchor);
  }, [windowRange, blocks.length, spacerH.top, spacerH.bot, syncSpacerHeights, restoreVirtualScrollAnchor, navigation]);

  // Precise correction pass: fires after newly-rendered blocks are measured (before next paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    if (correctionTick === 0) return;
    const nav = navigation.readCorrection();
    if (!nav) return;
    navigation.finishCorrection();
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
  // 定位维护者完成首次校正后清理校正意图，避免重复滚动。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange, getBlockScrollElement, syncSpacerHeights, updateActiveSceneFromScroll]);

  // After each window-changing render, execute any pending navigation (fires before paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const nav = navigation.readPending();
    if (!nav) return;
    const el = nav.kind === 'block'
      ? getBlockScrollElement(nav.id)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    navigation.completeJump(true);

    rebuildCumulative();
    syncSpacerHeights(windowRange);

    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    scrollElementIntoView(el, nav.kind === 'block' ? nav.align : 'center', nav.kind === 'block' ? nav.viewportTopRatio : undefined);

    // Newly-rendered blocks haven't been measured yet so the cumulative heights are estimated.
    // Store the target so the measurement effect can trigger a precise correction pass.
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  }, [windowRange, rebuildCumulative, getBlockScrollElement, syncSpacerHeights, updateActiveSceneFromScroll, navigation]);

  // Teleport to a block: load target window, then instant-jump in the layout effect.
  const scrollToBlockIdx = useCallback((
    idx: number,
    align: ScrollLogicalPosition = 'center',
    viewportTopRatio?: number,
  ) => {
    if (idx < 0 || idx >= script.getSnapshot().blocks.length) return;
    const block = script.getSnapshot().blocks[idx];
    const targetAreaReady = !initialWindow || script.getSnapshot().blocks
      .slice(idx, Math.min(script.getSnapshot().blocks.length, idx + 20))
      .every((candidate) => (
        isMarkerBlock(candidate)
        || !script.getSnapshot().manifestIds.has(candidate.id)
        || script.getSnapshot().loadedIds.has(candidate.id)
      ));
    if (!targetAreaReady) {
      // 显式跳转不先把用户扔进空白窗口：保留当前画面，目标段到齐后再一次定位。
      navigation.waitForBlock(block.id, idx, align, viewportTopRatio);
      return;
    }
    navigation.jump({ kind: 'block', id: block.id, align, viewportTopRatio });
    const windowSize = Math.min(INITIAL_WINDOW_SIZE, script.getSnapshot().blocks.length);
    let start = Math.max(0, idx - Math.floor(windowSize / 2));
    const end = Math.min(script.getSnapshot().blocks.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    const nextRange = { start, end };
    const currentRange = windowRangeRef.current;
    const rangeChanged = currentRange.start !== nextRange.start || currentRange.end !== nextRange.end;
    applyWindowRange(nextRange, true, false, true);
    if (!rangeChanged) {
      const el = getBlockScrollElement(block.id);
      if (!el) return;
      navigation.completeJump(false);
      markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
      scrollElementIntoView(el, align, viewportTopRatio);
      requestAnimationFrame(() => {
        updateActiveSceneFromScroll();
        window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
      });
    }
  }, [applyWindowRange, getBlockScrollElement, initialWindow, navigation, script, updateActiveSceneFromScroll]);

  useLayoutEffect(() => {
    const deferred = navigation.takeLoadedTarget(loadedBlockIds);
    if (!deferred) return;
    const index = script.getSnapshot().blockIndexById.get(deferred.id);
    if (index !== undefined) scrollToBlockIdx(index, deferred.align, deferred.viewportTopRatio);
  }, [loadedBlockIds, navigation, script, scrollToBlockIdx]);

  const openMobileBlockMenu = useCallback((blockId: string, blockIndex: number, textOffset: number | null = null) => {
    setMobileBatchAction(null);
    setMobileInsertMenuOpen(false);
    mobileBlockMenuCaretRef.current = { blockId, textOffset };
    scrollToBlockIdx(blockIndex, "start", 0.2);
    setMobileBlockMenuBlockId(blockId);
  }, [scrollToBlockIdx, setMobileBatchAction, setMobileBlockMenuBlockId, setMobileInsertMenuOpen]);

  const scrollToScene = useCallback((sceneId: string) => {
    const markerIdx = findSceneMarkerBlockIndex(sceneId, script.getSnapshot().blocks);
    if (markerIdx >= 0) glowTocMarker(script.getSnapshot().blocks[markerIdx].id);
    activeSceneIdRef.current = sceneId;
    setActiveSceneId(sceneId);
    const idx = markerIdx >= 0
      ? markerIdx
      : findTocSceneBlockIndex(sceneId, script.getSnapshot().scenes, script.getSnapshot().ownedBlocks);
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
  }, [glowTocMarker, script, scrollToBlockIdx, showReorderNotice]);
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

  const { sync, snapshot: syncState } = useScriptSync(script, {
    canWrite: () => canEdit,
    ready: () => loadState === "ready",
    send: async (batch) => {
      windowRequests.cancelBackground();
      const body = await patchScript(effectiveScriptId, activeVersionId, { ...batch.patch, basis: batch.basis });
      if (!body) throw new Error("script patch failed");
      return body.serverSeq;
    },
    afterSave: async (batch) => {
      if (!initialWindow || !activeVersionId || sync.isSuspended()) return;
      const generation = windowRequests.readGeneration();
      if (batch.structureChanged) {
        const bootstrap = await fetchScriptWindowBootstrap(effectiveScriptId, activeVersionId, windowRangeRef.current.start, INITIAL_WINDOW_SIZE);
        if (bootstrap && !sync.isStopped() && !sync.isSuspended() && generation === windowRequests.readGeneration()) applyWindowBootstrap(bootstrap);
      } else if (batch.patch.blockOps.length) {
        const map = await fetchScriptPageMap(effectiveScriptId, activeVersionId);
        if (map && !sync.isStopped() && !sync.isSuspended() && generation === windowRequests.readGeneration()) script.setPageMap(map);
      }
    },
    onConflict: () => recoveryTriggerRef.current(),
  });
  const syncWaitingForNetwork = syncState.waitingForNetwork;
  const syncConflict = syncState.conflict;

  const applyWindowBootstrap = useCallback((bootstrap: ScriptWindowBootstrap, replace = false) => {
    requestVirtualWindowRefresh();
    script.applyBootstrap(bootstrap, replace);
    const count = script.getSnapshot().blocks.length;
    const end = Math.min(count, bootstrap.window.start + Math.max(1, bootstrap.window.blocks.length));
    applyWindowRange({ start: bootstrap.window.start, end }, true, true, true);
  }, [applyWindowRange, script, requestVirtualWindowRefresh]);
  useLayoutEffect(() => { applyWindowBootstrapRef.current = applyWindowBootstrap; }, [applyWindowBootstrap]);

  const recoveryNeedsReloadRef = useRef(false);
  const { status: recoveryStatus, suspendedRef: recoverySuspendedRef, suspend: suspendRecovery, recover: recoverScript } = useScriptRecovery({
    pause: () => {
      setRecoveryLocked(true);
      sync.pause();
      windowRequests.cancel();

      if (streamDebounceTimerRef.current) clearTimeout(streamDebounceTimerRef.current);
      streamDebounceTimerRef.current = null;
    },
    reconcile: async () => {
      await sync.waitForIdle();
      if (sync.isStopped()) return;
      if (!sync.needsConflictReload() && !await sync.flush(true)) throw new Error("剧本修改尚未同步");
      if (sync.isStopped()) return;
      recoveryNeedsReloadRef.current = false;
      if (initialWindow && activeVersionId) {
        const bootstrap = await fetchScriptWindowBootstrap(effectiveScriptId, activeVersionId, windowRangeRef.current.start, INITIAL_WINDOW_SIZE);
        if (!bootstrap) throw new Error("剧本重连加载失败");
        if (sync.isStopped()) return;
        applyWindowBootstrap(bootstrap, true);
      } else {
        const state = await fetchScriptState(effectiveScriptId, activeVersionId);
        if (!state) throw new Error("剧本重连加载失败");
        if (sync.isStopped()) return;
        script.replaceServer(state);
        requestVirtualWindowRefresh();
      }
      history.reset();
      sync.resetAfterRecovery();
      if (recoveryNeedsReloadRef.current) void recoverScript();
    },
  });
  useLayoutEffect(() => {
    recoveryTriggerRef.current = () => { void recoverScript(); };
    setRecoveryLocked(recoveryStatus !== "ready");
    if (recoveryStatus === "ready") sync.resume();
  }, [recoverScript, recoveryStatus, sync]);

  useEffect(() => {
    if (initialWindow && initialWindow.versionId === activeVersionId) {
      return;
    }
    setLoadState("loading");
    setLoadError("");
    measuredHeightsRef.current.clear();
    measuredHeightTotalRef.current = 0;
    cumulativeHRef.current = [0, DEFAULT_BLOCK_H];
    script.beginLoading();
    applyWindowRange({ start: 0, end: 1 }, true);

    let cancelled = false;
    const load = async () => {
      try {
        // #650 标签与整本并发发起，不排在整本回包之后。tag_group 一落地每个非 stage 块都多出
        // 一行胶囊，晚到就是全窗口重排，所以标签到齐才 ready；单条失败按空处理，不拖垮整本。
        const tagsPromise = productionId
          ? Promise.allSettled([fetchTagGroups(productionId), fetchBlockTags(effectiveScriptId)])
          : null;
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

        script.replaceServer(state);
        const count = script.getSnapshot().blocks.length;
        measuredHeightsRef.current.clear();
        measuredHeightTotalRef.current = 0;
        cumulativeHRef.current = Array.from({ length: count + 1 }, (_, i) => i * DEFAULT_BLOCK_H);
        applyWindowRange({ start: 0, end: Math.min(INITIAL_WINDOW_SIZE, count) }, true);
        syncSpacerHeights({ start: 0, end: Math.min(INITIAL_WINDOW_SIZE, count) });

        // Capture version info from production route response
        if (isProdResponse) {
          const { versionId: respVid } = body as ProdResponse;
          const resolvedVid = respVid ?? activeVersionId;
          // 同值不写：服务端预置了 initialVersionId 时这里恒为同值，写了只是白渲染一帧。
          if (resolvedVid && resolvedVid !== activeVersionId) setActiveVersionId(resolvedVid);
        }

        if (tagsPromise) {
          const [tgRes, btRes] = await tagsPromise;
          if (cancelled) return;
          // 失败按空处理要落到实处：这个 effect 在切版本时重跑，条件写入会让上一版的
          // 标签留在屏上、同步基线也跟着错位。无论成败都整体覆盖。
          const tgData = tgRes.status === "fulfilled" ? tgRes.value : null;
          const btData = btRes.status === "fulfilled" ? btRes.value : null;
          script.loadTags((tgData?.groups ?? []) as TagGroup[], (btData?.tags ?? []) as BlockTagValue[]);
        }

        setLoadState("ready");
      } catch {
        if (!cancelled) {
          setLoadError("网络错误，请稍后重试");
          setLoadState("error");
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [effectiveScriptId, productionId, activeVersionId, initialWindow, applyWindowRange, syncSpacerHeights, script]);

  const mergeScriptWindow = useCallback((body: ScriptWindowResponse): boolean => {
    const range = windowRangeRef.current;
    if (body.window.start < range.end && body.window.start + body.window.blocks.length > range.start) requestVirtualWindowRefresh();
    return script.mergeWindow(body);
  }, [script, requestVirtualWindowRefresh]);

  // 分窗正文：当前视口优先，前后各留一段缓冲。请求切换时取消旧网络工作；即使浏览器
  // 来不及真正取消，generation 也保证旧响应不能夺回视口或覆盖新结构。
  useEffect(() => {
    if (!initialWindow || loadState !== "ready" || !activeVersionId || recoverySuspendedRef.current) return;
    const desiredStart = explicitLoadTargetIndex === null
      ? Math.max(0, windowRange.start - 80)
      : Math.max(0, explicitLoadTargetIndex - Math.floor(INITIAL_WINDOW_SIZE / 2));
    const desiredEnd = explicitLoadTargetIndex === null
      ? Math.min(script.getSnapshot().blocks.length, windowRange.end + 80)
      : Math.min(script.getSnapshot().blocks.length, desiredStart + INITIAL_WINDOW_SIZE);
    let missingIndex = -1;
    let visibleMissing = false;
    for (let index = desiredStart; index < desiredEnd; index++) {
      const id = script.getSnapshot().blocks[index]?.id;
      if (!id || !script.getSnapshot().manifestIds.has(id) || script.getSnapshot().loadedIds.has(id) || isMarkerBlock(script.getSnapshot().blocks[index])) continue;
      if (missingIndex < 0) missingIndex = index;
      if (explicitLoadTargetIndex !== null || (index >= windowRange.start && index < windowRange.end)) visibleMissing = true;
    }
    if (missingIndex < 0) {
      setWindowLoadSlow(false);
      return;
    }

    const request = windowRequests.begin("foreground");
    const { controller, generation } = request;
    setWindowLoadSlow(false);
    setWindowLoadFailed(false);
    const requestStart = Math.max(0, missingIndex - 40);
    const requestLimit = Math.min(480, Math.max(240, desiredEnd - requestStart));
    const slowTimer = visibleMissing
      ? window.setTimeout(() => setWindowLoadSlow(true), 700)
      : null;

    void fetchScriptWindow(
      effectiveScriptId,
      activeVersionId,
      requestStart,
      requestLimit,
      script.getSnapshot().orderRevision,
      controller.signal,
    ).then(async ({ status, body }) => {
      if (controller.signal.aborted || generation !== windowRequests.readGeneration()) return;
      if (status === 409) {
        // 结构变更会让绝对索引失效，但弱网下整页刷新会把已有画面也清空；原地重取轻量骨架。
        const bootstrap = await fetchScriptWindowBootstrap(
          effectiveScriptId,
          activeVersionId,
          windowRangeRef.current.start,
          INITIAL_WINDOW_SIZE,
          controller.signal,
        );
        if (!controller.signal.aborted && generation === windowRequests.readGeneration() && bootstrap) {
          applyWindowBootstrapRef.current(bootstrap);
        } else if (!controller.signal.aborted && visibleMissing) {
          setWindowLoadFailed(true);
        }
        return;
      }
      if (!body) {
        if (visibleMissing) setWindowLoadFailed(true);
        return;
      }
      if (body.orderRevision !== script.getSnapshot().orderRevision) return;

      if (!mergeScriptWindow(body)) {
        const bootstrap = await fetchScriptWindowBootstrap(
          effectiveScriptId,
          activeVersionId,
          windowRangeRef.current.start,
          INITIAL_WINDOW_SIZE,
          controller.signal,
        );
        if (!controller.signal.aborted && generation === windowRequests.readGeneration() && bootstrap) {
          applyWindowBootstrapRef.current(bootstrap);
        } else if (!controller.signal.aborted && visibleMissing) {
          setWindowLoadFailed(true);
        }
        return;
      }
      setWindowLoadSlow(false);
      setWindowLoadFailed(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (generation === windowRequests.readGeneration() && visibleMissing) {
        setWindowLoadSlow(false);
        setWindowLoadFailed(true);
      }
    }).finally(() => {
      if (slowTimer !== null) window.clearTimeout(slowTimer);
      windowRequests.finish(request);
    });

    return () => {
      controller.abort();
      if (slowTimer !== null) window.clearTimeout(slowTimer);
    };
  }, [activeVersionId, effectiveScriptId, explicitLoadTargetIndex, initialWindow, loadState, mergeScriptWindow, windowRange, windowRetryToken, recoveryStatus, recoverySuspendedRef, script, windowRequests]);

  // 用户停留后从当前视窗向外补齐；与前台缺块共用请求槽，滚动、跳转和保存可随时插队。
  useScriptWindowPrefetch({
    enabled: Boolean(initialWindow) && loadState === "ready" && recoveryStatus === "ready",
    scriptId: effectiveScriptId,
    versionId: activeVersionId,
    syncWaitingForNetwork,
    initialWindowSize: INITIAL_WINDOW_SIZE,
    script,
    isSaving: sync.isSaving,
    viewportRange: windowRange,
    windowRangeRef,
    requests: windowRequests,
    mergeWindow: mergeScriptWindow,
    applyBootstrap: applyWindowBootstrap,
  });

  useEffect(() => {
    if (!productionId || !activeVersionId || loadState !== "ready") return;
    let cancelled = false;
    fetchSceneDetails(productionId, activeVersionId).then((data) => {
      if (cancelled || !data) return;
      script.editSceneDetails(data);
    });
    return () => { cancelled = true; };
  }, [productionId, activeVersionId, loadState, script]);

  // 评论面板 chunk 在首屏画完后空闲预热（#647）：拆包省下的是首屏字节，不该把
  // 这笔成本原样转嫁成每次点开评论的等待。Safari 到近版才有 requestIdleCallback，
  // 没有就退回一次延时。
  useEffect(() => {
    if (loadState !== "ready") return;
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => preloadCommentsPanel(), { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => preloadCommentsPanel(), 1500);
    return () => window.clearTimeout(timer);
  }, [loadState]);

  // ── Presence 与块侧栏 hook 在上面（prepareForNavigation 之前）调用；SSE 订阅在下面接线 ──

  const eventSourceRef = useRef<EventSource | null>(null);
  const streamDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 后台标签不占同源连接名额（#467）——门控抽成了共享 hook，cue / wiki / 场景表
  // 同款接入；本组件的建连被下面的 leader 选举包着，所以只用可见性这一层。
  const streamVisible = useDocumentVisible();
  const streamStartedRef = useRef(false);
  const streamConnectedRef = useRef(false);
  const [streamRetryToken, setStreamRetryToken] = useState(0);
  useEffect(() => {
    if (!streamVisible && streamStartedRef.current) suspendRecovery();
  }, [streamVisible, suspendRecovery]);

  // ── Hash-based deep link + position restore ──────────────────────────────────
  useEffect(() => {
    if (loadState !== "ready") return;
    // Fallback: unlock scroll 300ms after ready; correction useLayoutEffect unlocks earlier.
    const unlockTimer = setTimeout(() => setScrollLocked(false), 300);
    const hash = window.location.hash;
    if (hash.startsWith("#block-")) {
      const [fragment, query] = hash.slice(1).split("?");
      const blockId = fragment.slice("block-".length);
      const idx = script.getSnapshot().blocks.findIndex(b => b.id === blockId);
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
        const bl = script.getSnapshot().blocks;
        const idx = bl.findIndex(b => b.id === blockId);
        if (idx >= 0) {
          scrollToBlockIdx(idx, "start");
        } else if (!isNaN(savedIndex) && bl.length > 0) {
          scrollToBlockIdx(Math.min(savedIndex, bl.length - 1), "start");
        }
      }
    }
    return () => clearTimeout(unlockTimer);
  }, [loadState, productionId, script, scrollToBlockIdx, setActiveCommentBlockId, setTagEditorOnTop]);

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

    if (streamStartedRef.current) suspendRecovery();
    streamStartedRef.current = true;
    let es: EventSource | null = null;
    let leaderRenewTimer: ReturnType<typeof setInterval> | null = null;
    let electionTimer: ReturnType<typeof setInterval> | null = null;
    let isLeader = false;
    let electionStarted = false;
    let receivedConnection = false;
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
      if (recoverySuspendedRef.current) {
        recoveryNeedsReloadRef.current = true;
        return;
      }
      if (seq <= sync.getServerSeq()) return;

      if (streamDebounceTimerRef.current) clearTimeout(streamDebounceTimerRef.current);
      streamDebounceTimerRef.current = setTimeout(async () => {
        streamDebounceTimerRef.current = null;
        // Re-check: the PATCH response for our own edit may have arrived during
        // the 300 ms window and already advanced serverSeqRef.  If so there is
        // nothing to fetch — the server state equals what we already synced.
        if (seq <= sync.getServerSeq()) return;
        const generation = windowRequests.readGeneration();
        try {
          if (initialWindow && activeVersionId) {
            const bootstrap = await fetchScriptWindowBootstrap(
              effectiveScriptId,
              activeVersionId,
              windowRangeRef.current.start,
              INITIAL_WINDOW_SIZE,
            );
            if (!bootstrap || generation !== windowRequests.readGeneration() || recoverySuspendedRef.current || seq <= sync.getServerSeq()) return;
            sync.observeServerSeq(seq);
            applyWindowBootstrap(bootstrap);
            return;
          }
          const serverState = await fetchScriptState(effectiveScriptId, activeVersionId);
          if (!serverState || generation !== windowRequests.readGeneration() || recoverySuspendedRef.current) return;

          sync.observeServerSeq(seq);
          requestVirtualWindowRefresh();
          script.mergeServer(serverState);
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
      if (recoverySuspendedRef.current) { recoveryNeedsReloadRef.current = true; return; }
      script.editConfig(prev => ({ ...DEFAULT_SCRIPT_CONFIG, ...prev, ...cfg }));
    };

    const openEventSource = (streamClientId: string, onEvent: (type: "seq" | "presence" | "config", data: unknown) => void) => {
      const streamParams = new URLSearchParams();
      streamParams.set("cid", streamClientId);
      if (activeVersionId) streamParams.set("v", activeVersionId);
      const streamQuery = streamParams.toString() ? `?${streamParams.toString()}` : "";
      const nextEs = new EventSource(`${BASE_PATH}/api/script/${effectiveScriptId}/stream${streamQuery}`);
      eventSourceRef.current = nextEs;
      let opened = false;
      nextEs.onopen = () => {
        streamConnectedRef.current = true;
        if (opened || recoverySuspendedRef.current) {
          void recoverScript();
        }
        opened = true;
        bc?.postMessage({ source: tabId, type: "connected" });
      };
      nextEs.onerror = () => {
        streamConnectedRef.current = false;
        suspendRecovery();
        bc?.postMessage({ source: tabId, type: "disconnect" });
      };

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
      if (es) bc?.postMessage({ source: tabId, type: "disconnect" });
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
      if (!current || current.expiresAt <= Date.now()) {
        if (electionStarted) suspendRecovery();
        startLeader();
      }
      electionStarted = true;
    };

    if (bc) {
      bc.onmessage = (event: MessageEvent) => {
        const msg = event.data as { source?: string; target?: string; type?: string; data?: unknown };
        if (msg.source === tabId || (msg.target && msg.target !== tabId)) return;
        if (msg.type === "join" && isLeader) {
          bc?.postMessage({ source: tabId, target: msg.source, type: es?.readyState === EventSource.OPEN ? "connected" : "disconnect" });
          return;
        }
        if (msg.type === "connected") {
          streamConnectedRef.current = true;
          if (!receivedConnection && recoverySuspendedRef.current) void recoverScript();
          receivedConnection = true;
          return;
        }
        if (msg.type === "disconnect") {
          streamConnectedRef.current = false;
          if (receivedConnection || recoverySuspendedRef.current) suspendRecovery();
          receivedConnection = false;
          return;
        }
        if (msg.type === "seq" && typeof msg.data === "number") handleSeq(msg.data);
        else if (msg.type === "presence" && Array.isArray(msg.data)) handlePresence(msg.data as RemotePresence[]);
        else if (msg.type === "config" && msg.data && typeof msg.data === "object") handleConfig(msg.data as ScriptConfig);
      };
      electionTimer = setInterval(maybeElectLeader, 2_500);
      maybeElectLeader();
      bc.postMessage({ source: tabId, type: "join" });
    } else {
      es = openEventSource(clientId || tabId, () => {});
    }

    return () => {
      closed = true;
      streamConnectedRef.current = false;
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
  }, [effectiveScriptId, loadState, clientId, activeVersionId, applyWindowBootstrap, initialWindow, requestVirtualWindowRefresh, resetToolbarMeasurement, setToolbarMeasureTick, streamVisible, presenceCountRef, presenceLayoutTimerRef, setPresenceMap, recoverScript, suspendRecovery, recoverySuspendedRef, streamRetryToken, sync, windowRequests, script]);

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

  const flushPendingPatch = sync.flush;
  useLayoutEffect(() => { flushPendingPatchRef.current = flushPendingPatch; }, [flushPendingPatch]);

  const {
    error: modeSwitchError,
    pending: modeSwitchPending,
    clearError: clearModeSwitchError,
    selectMode: selectPersonalMode,
  } = useScriptPersonalModeTransition({
    scriptId: effectiveScriptId,
    baseCanEdit,
    personalMode,
    rehearsalMode,
    setPersonalMode,
    setRehearsalMode,
    setDisplay,
    flushPendingPatch,
    captureScrollAnchor: captureVirtualScrollAnchor,
    preserveScrollAnchor: (anchor) => { pendingModeScrollAnchorRef.current = anchor; },
    resetInteractions: resetScriptInteractions,
    closeMenu: closeToolbarMenu,
  });

  const persistMarkerState = sync.flush;

  const history = useScriptHistory(() => script.getSnapshot().blocks, (snapshot) => {
    script.editBlockStructure(snapshot);
    requestVirtualWindowRefresh();
  });
  const { canUndo, canRedo, record: saveSnapshot, startTyping: startTypingSession } = history;

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) taRefs.current.set(id, el);
    else taRefs.current.delete(id);
  }, []);

  const insertMobileBlockLineBreak = useCallback((blockId: string) => {
    if (isContentLocked) return;
    const el = taRefs.current.get(blockId);
    if (!el) return;
    const savedCaret = mobileBlockMenuCaretRef.current;
    const textOffset = savedCaret?.blockId === blockId ? savedCaret.textOffset : null;
    closeMobileBlockMenu();
    el.focus();
    if (!insertLineBreakAtTextOffset(el, textOffset)) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    mobileBlockMenuCaretRef.current = null;
  }, [closeMobileBlockMenu, isContentLocked]);

  const openCharSelector = useCallback((id: string) => {
    setCharEditTokens((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  const handleArrowUpFromTextarea = useCallback((id: string) => {
    const cur = script.getSnapshot().blocks;
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
  }, [openCharSelector, script]);

  const handleArrowDownFromTextarea = useCallback((id: string) => {
    const cur = script.getSnapshot().blocks;
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
  }, [openCharSelector, script]);

  const handleArrowUpFromChar = useCallback((id: string) => {
    const cur = script.getSnapshot().blocks;
    const idx = cur.findIndex((b) => b.id === id);
    if (idx > 0) {
      const el = taRefs.current.get(cur[idx - 1].id);
      if (el) { el.focus(); setCursorAtEnd(el); }
    }
  }, [script]);

  const handleArrowDownFromChar = useCallback((id: string) => {
    const el = taRefs.current.get(id);
    if (el) { el.focus(); setCursorAtStart(el); }
  }, []);

  const applyStageDelimiterChange = useCallback(async (updateExisting: boolean) => {
    const pending = pendingStageDelimiterChange;
    if (!pending) return;
    const previousOpen = scriptConfig.stageDelimOpen;
    const previousClose = scriptConfig.stageDelimClose;
    setPendingStageDelimiterChange(null);
    if (updateExisting) {
      const nextBlocks = script.getSnapshot().blocks.map((block) => {
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
      if (nextBlocks.some((block, index) => block !== script.getSnapshot().blocks[index])) {
        saveSnapshot();

        script.editBlocks(nextBlocks);
      }
    }
    await saveScriptConfig({ stageDelimOpen: pending.open, stageDelimClose: pending.close });
  }, [pendingStageDelimiterChange, scriptConfig.stageDelimOpen, scriptConfig.stageDelimClose, saveScriptConfig, script, saveSnapshot]);

  // Apply inline format (bold/underline) to the current window selection.
  // Called from toolbar buttons via onMouseDown+preventDefault, which keeps
  // the selection alive even after the contenteditable loses focus.
  const applyFormatToFocused = useCallback((tag: "b" | "u") => {
    if (isContentLocked) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const editableEl = getEditableElementForRange(range);
    if (!editableEl) return;
    // End typing session so startTypingSession (called by updateBlock via input event)
    // saves a fresh pre-format snapshot rather than lumping with active typing.
    history.endTyping();
    toggleInlineTag(range, tag);
    // Re-focus then fire input so ScriptBlock's handleInput → syncContent runs
    editableEl.focus();
    editableEl.dispatchEvent(new Event("input", { bubbles: true }));
  }, [history, isContentLocked]);

  const undo = useCallback(() => { if (!isContentLocked) history.undo(); }, [history, isContentLocked]);

  const redo = useCallback(() => { if (!isContentLocked) history.redo(); }, [history, isContentLocked]);

  // ── Tag handlers ─────────────────────────────────────────────────────────────
  // Tag mutations are no longer sent via a dedicated block-tags PATCH.
  // Instead they are embedded in the block op and synced atomically via the
  // debounced PATCH to /api/script/[id].  The block-tags route is still
  // available for server-side / admin use but is not called from here.

  const handleTagChange = useCallback((blockId: string, groupId: string, optionId: string | null, value: number | null, del: boolean) => {
    if (!isContentLocked) script.editTag(blockId, groupId, optionId, value, del);
  }, [script, isContentLocked]);

  const handleTagCopy = useCallback((blockId: string) => {
    tagClipboardRef.current = script.getSnapshot().tags.get(blockId) ?? [];
  }, [script]);

  const handleTagPaste = useCallback((blockId: string) => {
    const tags = tagClipboardRef.current;
    if (!isContentLocked && tags?.length) script.pasteTags(blockId, tags);
  }, [script, isContentLocked]);

  const inheritTags = script.inheritTags;

  const {
    searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchExact, setSearchExact,
    searchCurrentPage, setSearchCurrentPage, searchIdx, setSearchIdx, searchMatches, searchPending,
    jumpTarget, setJumpTarget, jumpValue, setJumpValue, jumpToLine, jumpToPage,
  } = useScriptSearch({
    blocks,
    pageMap,
    focusedId,
    loadState,
    initialSearchQuery,
    scrollToBlockIdx,
    remoteSearch: initialWindow && activeVersionId ? remoteScriptSearch : undefined,
  });

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
        if (id) { e.preventDefault(); tagClipboardRef.current = script.getSnapshot().tags.get(id) ?? []; }
      }
      else if (e.key === "v" && e.shiftKey) {
        const id = focusedIdRef.current;
        if (id && tagClipboardRef.current?.length) { e.preventDefault(); handleTagPaste(id); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [undo, redo, handleTagPaste, setSearchOpen, script]);

  const toggleBlockType = useCallback((id: string) => {
    if (isContentLocked) return;
    saveSnapshot();
    const previousBlocks = script.getSnapshot().blocks;
    const changes: BlockChange[] = [];
    const nextBlocks: Block[] = previousBlocks.map((b, position) => {
      if (b.id !== id) return b;
      const next = { ...b, type: b.type === "dialogue" ? "stage" as const : "dialogue" as const, characterIds: [] };
      if (b.type !== next.type) changes.push({
        kind: "convert", position, blockId: b.id, beforeType: b.type, afterType: next.type,
      });
      return next;
    });
    script.editBlockStructure(nextBlocks, markerChangeFromOperations(changes));
    glowAndFocusBlocks([id]);
  }, [isContentLocked, saveSnapshot, script, glowAndFocusBlocks]);

  const toggleStageCueToFocused = useCallback(() => {
    const id = focusedIdRef.current;
    if (!id) return;

    const block = script.getSnapshot().blocks.find((b) => b.id === id);
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
      wrapSelectionAsInlineStageCue(range, script.getSnapshot().config.stageDelimOpen, script.getSnapshot().config.stageDelimClose);
      editableEl.focus();
      editableEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    toggleBlockType(id);
  }, [script, toggleBlockType]);

  const toggleBlockLyric = useCallback((id: string) => {
    if (isContentLocked) return;
    saveSnapshot();

    script.editBlocks((prev) => prev.map((b) =>
      b.id === id ? { ...b, lyric: !b.lyric } : b
    ));
    glowAndFocusBlocks([id]);
  }, [isContentLocked, saveSnapshot, script, glowAndFocusBlocks]);

  const setBlocksType = useCallback((ids: string[], type: BlockType) => {
    if (isContentLocked) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    const previousBlocks = script.getSnapshot().blocks;
    const changes: BlockChange[] = [];
    const nextBlocks = previousBlocks.map((b, position) => {
      if (!targetIds.has(b.id)) return b;
      const next = { ...b, type, characterIds: type === "stage" ? [] : b.characterIds };
      if (b.type !== type) changes.push({
        kind: "convert", position, blockId: b.id, beforeType: b.type, afterType: type,
      });
      return next;
    });
    script.editBlockStructure(nextBlocks, markerChangeFromOperations(changes));
    glowAndFocusBlocks(ids);
  }, [isContentLocked, saveSnapshot, script, glowAndFocusBlocks]);

  const setBlocksLyric = useCallback((ids: string[], lyric: boolean) => {
    if (isContentLocked) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();

    script.editBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id) && b.type !== "stage"
        ? { ...b, lyric }
        : b
    ));
    glowAndFocusBlocks(ids);
  }, [isContentLocked, saveSnapshot, script, glowAndFocusBlocks]);

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
      if (isContentLocked) return;
      startTypingSession();

      script.editBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
    },
    [isContentLocked, startTypingSession, script]
  );

  const findChapterIdForBlock = useCallback((blockId: string): string | null => {
    const currentBlocks = script.getSnapshot().ownedBlocks;
    const currentScenes = script.getSnapshot().scenes;
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
  }, [script]);

  const addChapterBeforeBlock = useCallback((blockId: string) => {
    if (isContentLocked || !canEditMetadata) return;
    const previousBlocks = script.getSnapshot().blocks;
    const next = insertMarker({
      blocks: previousBlocks,
      scenes: script.getSnapshot().scenes,
      characters: script.getSnapshot().characters,
      config: script.getSnapshot().config,
    }, { kind: "chapter", name: "", beforeBlockId: blockId }, uid);
    saveSnapshot();

    script.editStructure(next);
    void persistMarkerState();
  }, [canEditMetadata, isContentLocked, persistMarkerState, saveSnapshot, script]);

  const addSceneBeforeBlock = useCallback((blockId: string) => {
    if (isContentLocked || !canEditMetadata) return;
    const chapterId = findChapterIdForBlock(blockId);
    const previousBlocks = script.getSnapshot().blocks;
    const next = insertMarker({
      blocks: previousBlocks,
      scenes: script.getSnapshot().scenes,
      characters: script.getSnapshot().characters,
      config: script.getSnapshot().config,
    }, {
      kind: chapterId ? "scene" : "chapter",
      name: "",
      parentId: chapterId,
      beforeBlockId: blockId,
    }, uid);
    saveSnapshot();

    script.editStructure(next);
    void persistMarkerState();
  }, [canEditMetadata, findChapterIdForBlock, isContentLocked, persistMarkerState, saveSnapshot, script]);

  const addRehearsalBeforeBlock = useCallback((blockId: string) => {
    if (isContentLocked || !effectiveCanEditRehearsalMark || !script.getSnapshot().config.useRehearsalMarks) return;
    const marker = makeMarkerBlock("rehearsal_marker");
    const previousBlocks = script.getSnapshot().blocks;
    const index = previousBlocks.findIndex((block) => block.id === blockId);
    const insertIndex = index === -1 ? previousBlocks.length : index;
    const nextBlocks = insertMarkerWithEmptyBlockIfNeeded(
      previousBlocks,
      marker,
      insertIndex,
      script.getSnapshot().config.openingChapterMarkerId,
    );
    saveSnapshot();

    script.editBlocks(nextBlocks);
  }, [effectiveCanEditRehearsalMark, isContentLocked, saveSnapshot, script]);

  const convertMarkerBlockType = useCallback((blockId: string, nextType: Extract<BlockType, "chapter_marker" | "scene_marker">) => {
    if (isContentLocked || !canEditMetadata) return;
    const currentIdx = script.getSnapshot().blockIndexById.get(blockId);
    if (currentIdx === undefined) return;
    const currentBlock = script.getSnapshot().blocks[currentIdx];
    if (!currentBlock) return;
    if (!isMarkerBlock(currentBlock)) return;
    if (currentBlock.type === nextType) return;
    const previousBlocks = script.getSnapshot().blocks;
    const next = convertMarker({
      blocks: previousBlocks,
      scenes: script.getSnapshot().scenes,
      characters,
      config: script.getSnapshot().config,
    }, blockId, nextType === "chapter_marker" ? "chapter" : "scene", uid);

    saveSnapshot();

    script.editStructure(next);
    void persistMarkerState();
    selection.selectOne(blockId);
  }, [canEditMetadata, characters, isContentLocked, persistMarkerState, saveSnapshot, script, selection]);

  const splitBlock = useCallback((id: string, before: string, after: string) => {
    if (isContentLocked) return;
    saveSnapshot();
    // Pre-generate the new block ID **outside** the script.editBlocks updater so the ID
    // is stable across React Strict Mode's double-invocation of the updater.
    // If makeBlock() were called inside the updater, each invocation would
    // produce a different uid(), causing nextId (from the 2nd call) to diverge
    // from the block actually committed to state (from the 1st call).
    const nextBlockId = uid();
    const previousBlocks = script.getSnapshot().blocks;
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

      script.editBlockStructure(updated, markerChangeFromOperations([{
        kind: "insert",
        position: currentIdx + 1,
        blockId: next.id,
        beforeType: null,
        afterType: next.type,
      }]));
    }
    inheritTags(id, nextBlockId);
  }, [isContentLocked, saveSnapshot, script, inheritTags]);

  const mergeBlock = useCallback((id: string) => {
    if (isContentLocked) return;
    saveSnapshot();
    const previousBlocks = script.getSnapshot().blocks;
    const currentIdx = previousBlocks.findIndex((block) => block.id === id);
    if (currentIdx === 0) {
      // Delete empty first block if there are more blocks after it
      if (previousBlocks.length > 1 && !previousBlocks[0].content.trim()) {
        pendingFocus.current = { id: previousBlocks[1].id, atEnd: false };
        script.editBlockStructure(previousBlocks.slice(1), markerChangeFromOperations([{
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

      script.editBlockStructure(updated, markerChangeFromOperations([{
        kind: "delete",
        position: Math.min(currentIdx, updated.length),
        blockId: c.id,
        beforeType: c.type,
        afterType: null,
      }]));
    }
  }, [isContentLocked, saveSnapshot, script]);

  const nonEmptyDramaturgyMarkersForBlockIds = useCallback((ids: Iterable<string>): NonEmptyDramaturgyMarker[] => {
    const currentBlocks = script.getSnapshot().blocks;
    const currentIndexById = script.getSnapshot().blockIndexById;
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
  }, [sceneDetailById, script]);

  const deleteBlocks = useCallback((ids: string[], options?: { forceDeleteNonEmptyMarkerDetails?: boolean }) => {
    if (isContentLocked) return;
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
    const currentBlocks = script.getSnapshot().blocks;
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
      script.getSnapshot().scenes,
      script.getSnapshot().config,
      markerChangeFromOperations(changes),
    );
    const focusIdx = Math.min(firstDeletedIdx, editedBlocks.length - 1);
    pendingFocus.current = { id: editedBlocks[focusIdx].id, atEnd: false };

    script.editStructure({ ...script.read(), ...normalized });
    selection.remove(deleteIds);
  }, [isContentLocked, nonEmptyDramaturgyMarkersForBlockIds, saveSnapshot, script, selection]);

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
    if (isContentLocked || !canEditText) return;
    const cleanupAnalysis = analyzeEmptyScriptCleanup(
      script.getSnapshot().blocks,
      script.getSnapshot().scenes,
      sceneDetailById,
      script.getSnapshot().config.openingChapterMarkerId
    );
    if (!cleanupAnalysis.hasEmptyTextBlock && cleanupAnalysis.targets.length === 0) {
      showReorderNotice("没有可清除的空白内容。");
      closeToolbarMenu();
      return;
    }
    setEmptyScriptCleanupDialog(cleanupAnalysis.targets);
    closeToolbarMenu();
  }, [canEditText, closeToolbarMenu, isContentLocked, sceneDetailById, script, setEmptyScriptCleanupDialog, showReorderNotice]);

  const applyEmptyScriptCleanup = useCallback((selectedTargetKeys: Set<string>) => {
    if (isContentLocked || !canEditText) return;
    const currentBlocks = script.getSnapshot().blocks;
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
    const remainingScenes = script.getSnapshot().scenes.filter((scene) => !selectedSceneIds.has(scene.id));
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
      script.getSnapshot().config,
      markerChangeFromOperations(changes),
    );

    saveSnapshot();

    resetScriptInteractions();
    setEmptyScriptCleanupDialog(null);
    script.editStructure({ ...script.read(), ...normalized });
    showReorderNotice("已清除选中空白内容。");
  }, [canEditText, deleteBlocks, isContentLocked, pendingEmptyScriptCleanup, resetScriptInteractions, saveSnapshot, script, setEmptyScriptCleanupDialog, showReorderNotice]);

  const applyMarkerDeleteOperation = useCallback((operation: MarkerDeleteOperation) => {
    const previousBlocks = script.getSnapshot().blocks;
    const next = executeMarkerDeletion({
      blocks: previousBlocks,
      scenes: script.getSnapshot().scenes,
      characters: script.getSnapshot().characters,
      config: script.getSnapshot().config,
    }, operation, uid);
    saveSnapshot();

    resetScriptInteractions();
    script.editStructure(next);
    setMarkerDeleteDialog(null);
    void persistMarkerState();
  }, [persistMarkerState, resetScriptInteractions, saveSnapshot, script]);

  const deleteMarker = useCallback((markerBlockId: string) => {
    if (isContentLocked) return;
    const plan = planMarkerDeletion({
      blocks: script.getSnapshot().blocks,
      scenes: script.getSnapshot().scenes,
      characters: script.getSnapshot().characters,
      config: script.getSnapshot().config,
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
  }, [applyMarkerDeleteOperation, canEditText, isContentLocked, sceneDetails, script]);

  const blockIdsRequireNonEmptySceneConfirm = useCallback((ids: string[]) => ids.some((id) => {
    const index = script.getSnapshot().blockIndexById.get(id);
    if (index === undefined) return false;
    const block = blocks[index];
    return !!block && isBlockEmptyForDelete(block) && isOnlyTextBlockInMarkerSegment(ownedBlocks, index, script.getSnapshot().config.openingChapterMarkerId);
  }), [blocks, ownedBlocks, script]);

  const blockIdsAreEmptyForDelete = useCallback((ids: string[]) => ids.every((id) => {
    const index = script.getSnapshot().blockIndexById.get(id);
    const block = index === undefined ? undefined : blocks[index];
    return block ? isBlockEmptyForDelete(block) : false;
  }), [blocks, script]);

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
    if (isContentLocked) return false;
    const selectedIds = selectedBlockIdsArray;
    if (selectedIds.length === 0) return false;
    if (!canPerformSelectedBlockAction(selectedIds)) return true;
    const selectedBlocks = selectedIds
      .map((id) => {
        const index = script.getSnapshot().blockIndexById.get(id);
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
  }, [isContentLocked, selectedBlockIdsArray, canPerformSelectedBlockAction, selectedBlocksAreEmptyForDelete, selectedBlocksRequireNonEmptySceneConfirm, blocks, windowRange.start, windowRange.end, script, requestLargeSelectionOperation, deleteBlocks, selectedBlockIds]);

  const requestMarkerDelete = useCallback((id: string) => {
    if (isContentLocked) return false;
    const ids = selectedBlockIds.has(id) ? selectedBlockIdsArray : [id];
    if (!selectedBlockIds.has(id) && selectedBlockIds.size > 0) {
      clearBlockSelection();
    }
    if (ids.length === 1) {
      const plan = planMarkerDeletion({
        blocks: script.getSnapshot().blocks,
        scenes: script.getSnapshot().scenes,
        characters: script.getSnapshot().characters,
        config: script.getSnapshot().config,
      }, id, sceneDetails);
      setDeleteConfirmingBlockIds(new Set(plan.status === "blocked" ? [id] : plan.previewBlockIds));
      return true;
    }
    if (!canPerformSelectedBlockAction(ids)) return false;
    setDeleteConfirmingBlockIds(new Set(ids));
    return true;
  }, [canPerformSelectedBlockAction, clearBlockSelection, isContentLocked, sceneDetails, script, selectedBlockIds, selectedBlockIdsArray]);

  const requestMobileDelete = useCallback((id: string) => {
    const index = script.getSnapshot().blockIndexById.get(id);
    const block = index === undefined ? null : script.getSnapshot().blocks[index] ?? null;
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
  }, [blockIdsAreEmptyForDelete, blockIdsRequireNonEmptySceneConfirm, canPerformSelectedBlockAction, deleteBlocks, requestLargeSelectionOperation, requestMarkerDelete, script, selectedBlockIds, selectedBlockIdsArray]);

  const dismissBlockConfirmations = useCallback(() => {
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setMarkerDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const hasDeleteConfirmationOpen = deleteConfirmingBlockIds.size > 0 || markerDeleteConfirmBlockId !== null;
    const handler = (e: PointerEvent) => {
      if (drag.read()?.ids[0] || isReorderLockedRef.current) return;
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
  }, [clearBlockSelection, deleteConfirmingBlockIds.size, dismissBlockConfirmations, markerDeleteConfirmBlockId, mobileBlockMenuBlockId, selectedBlockIds.size, isReorderLockedRef, drag]);

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
        selection.detach();
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
  }, [selection]);

  const moveDraggedBlocks = useCallback((fromIds: string[], target: DragTarget): boolean => {
    if (isContentLocked) return false;
    const movingIds = new Set(fromIds);
    if (movingIds.size === 0) {
      showReorderNotice("移动失败：未找到被拖拽内容。");
      return false;
    }
    const prev = script.getSnapshot().blocks;
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
      script.getSnapshot().scenes,
      script.getSnapshot().config,
      getMarkerChange(prev, next, movingIds),
    );
    const normalizedNext = normalized.blocks;
    const movedStartIndex = normalizedNext.findIndex((block) => movingIds.has(block.id));
    const movingHasMarker = moving.some(isMarkerBlock);
    const firstMovedOwnerMarkerId = normalizedNext[movedStartIndex].ownerMarkerId ?? null;
    const movedTextOwnershipChanged = !movingHasMarker && moving.some((block, offset) => {
      const beforeIdx = script.getSnapshot().blockIndexById.get(block.id);
      const before = beforeIdx === undefined ? null : script.getSnapshot().ownedBlocks[beforeIdx];
      return (before?.ownerMarkerId ?? null) !== (normalizedNext[movedStartIndex + offset]?.ownerMarkerId ?? null);
    });

    requestLargeSelectionOperation("move", moving.length, () => {
      saveSnapshot();
      navigation.centerAfterMove(moving[0].id);
      requestVirtualWindowRefresh();
      script.editStructure({ ...script.read(), ...normalized }, movingIds);
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
      selection.selectMoved(movedBlockIds);
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
  }, [isContentLocked, script, requestLargeSelectionOperation, unlockReorder, showReorderNotice, saveSnapshot, navigation, requestVirtualWindowRefresh, glowChangedBlocks, glowTocMarker, selection, unlockReorderAfterCommit, showSelectionChangeNotice, markerContextById, sceneById, rehearsalLabels.rehearsalLabelByMarkerId]);

  const isNoopDragTarget = useCallback((fromIds: string[], target: DragTarget): boolean => {
    const movingIds = new Set(fromIds);
    if (movingIds.size === 0) return true;
    const currentBlocks = script.getSnapshot().blocks;
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
  }, [script]);

  const getDragTargetFromClientY = useCallback((clientY: number): DragTarget | null => {
    const container = blocksContainerRef.current;
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-bwrap]"));
    if (rows.length === 0) return null;

    const firstRect = rows[0].getBoundingClientRect();
    const lastRect = rows[rows.length - 1].getBoundingClientRect();
    if (clientY < firstRect.top) return { kind: "edge", edge: "top" };
    if (clientY > lastRect.bottom) return { kind: "edge", edge: "bottom" };

    const currentBlocks = script.getSnapshot().blocks;
    let insertIdx = currentBlocks.length;
    const blockIndexById = script.getSnapshot().blockIndexById;
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
    if (isNoopDragTarget((drag.read()?.ids ?? []), target)) {
      drag.reject("移动未执行：目标位置与当前位置相同。");
      return null;
    }
    drag.reject(null);
    return target;
  }, [drag, isNoopDragTarget, script]);

  const updateDragTargetFromClientY = useCallback((clientY: number): DragTarget | null => {
    const nextTarget = getDragTargetFromClientY(clientY);
    drag.setTarget(nextTarget);
    return nextTarget;
  }, [drag, getDragTargetFromClientY]);

  const setEdgeDragTarget = useCallback((edge: "top" | "bottom") => {
    drag.setTarget({ kind: "edge", edge });
    drag.reject(null);
  }, [drag]);

  const handleEdgeSpacerDragOver = useCallback((e: DragEvent<HTMLDivElement>, edge: "top" | "bottom") => {
    if (isContentLocked) return;
    if (isReorderLockedRef.current) return;
    if (!drag.read()?.ids[0]) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setEdgeDragTarget(edge);
  }, [isContentLocked, isReorderLockedRef, drag, setEdgeDragTarget]);

  const beginBlockDrag = useCallback((e: DragEvent<HTMLElement>, id: string, marker: boolean) => {
    if (isReorderLockedRef.current) { e.preventDefault(); return; }
    const selected = selection.getSnapshot().selectedIds;
    const isSelection = selected.has(id);
    const ids = isSelection ? [...selected] : [id];
    if (isSelection && !canPerformSelectedBlockAction(ids)) { e.preventDefault(); return; }
    dismissBlockConfirmations();
    if (!isSelection && selected.size) selection.clear();
    clearEditorFocusForDrag();
    pendingFocus.current = null;
    drag.begin(ids);
    beginDragCountBadge(e.clientX, e.clientY, ids.length);
    if (marker && !isSelection) selection.selectOne(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ids.join(","));
  }, [isReorderLockedRef, selection, canPerformSelectedBlockAction, dismissBlockConfirmations, clearEditorFocusForDrag, drag, beginDragCountBadge]);

  const handleScriptDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    const session = drag.read();
    if (isReorderLockedRef.current || !session) return;
    if (session.ids.length > 1) updateDragCountBadge(e.clientX, e.clientY, session.ids.length, e.buttons);
    if (!updateDragTargetFromClientY(e.clientY)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, [drag, isReorderLockedRef, updateDragCountBadge, updateDragTargetFromClientY]);

  const handleScriptDrop = useCallback((e: DragEvent<HTMLElement>, edgeTarget?: DragTarget) => {
    const session = drag.read();
    if (isReorderLockedRef.current || !session) return;
    e.preventDefault();
    e.stopPropagation();
    lockReorder();
    const target = edgeTarget ?? updateDragTargetFromClientY(e.clientY) ?? drag.read()?.target;
    const reason = drag.read()?.invalidReason;
    drag.end();
    clearDragCountBadge();
    dismissBlockConfirmations();
    if (!target) {
      showReorderNotice(reason ?? "移动失败：未释放到有效位置。");
      unlockReorder();
    } else if (!moveDraggedBlocks(session.ids, target)) unlockReorder();
  }, [drag, isReorderLockedRef, lockReorder, updateDragTargetFromClientY, clearDragCountBadge, dismissBlockConfirmations, showReorderNotice, unlockReorder, moveDraggedBlocks]);

  const endBlockDrag = useCallback(() => {
    const session = drag.end();
    if (session && session.ids.length) {
      if (session.target) {
        lockReorder();
        if (!moveDraggedBlocks(session.ids, session.target)) unlockReorder();
      } else showReorderNotice(session.invalidReason ?? "移动失败：未释放到有效位置。");
    }
    clearDragCountBadge();
    dismissBlockConfirmations();
  }, [drag, lockReorder, moveDraggedBlocks, unlockReorder, showReorderNotice, clearDragCountBadge, dismissBlockConfirmations]);

  const handleEdgeSpacerDrop = useCallback((e: DragEvent<HTMLDivElement>, edge: "top" | "bottom") => {
    if (isContentLocked || isReorderLockedRef.current || !drag.read()) return;
    handleScriptDrop(e, { kind: "edge", edge });
  }, [drag, isContentLocked, isReorderLockedRef, handleScriptDrop]);

  const insertBlockAt = useCallback((index: number) => {
    if (!canEditText) return;
    saveSnapshot();
    // Pre-generate the new block ID outside the updater (Strict Mode double-invocation fix).
    const newBlockId = uid();
    // 插入位置从正文维护者读取，避免依赖渲染快照。
    const previousBlocks = script.getSnapshot().blocks;
    const newBlock: Block = {
      ...makeBlock(),
      id: newBlockId,  // use the pre-generated stable ID
      sceneId: null,
      rehearsalMark: null,
    };
    const { blocks: updated, insertIndex, refId } = insertScriptBlockAt(previousBlocks, index, newBlock);
    pendingCharOpen.current = newBlock.id;
    script.editBlockStructure(updated, markerChangeFromOperations([{
      kind: "insert",
      position: insertIndex,
      blockId: newBlock.id,
      beforeType: null,
      afterType: newBlock.type,
    }]));
    if (refId) inheritTags(refId, newBlockId);
  }, [canEditText, saveSnapshot, script, inheritTags]);

  const addChar = (name: string) => {
    if (isContentLocked) return;
    script.editCharacters((prev) => [...prev, { id: uid(), name, isAggregate: false }]);
  };

  const removeChar = (charId: string) => {
    if (!isContentLocked) script.removeCharacter(charId);
  };

  const renameChar = (charId: string, name: string) =>
    !isContentLocked && script.editCharacters((prev) =>
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
    if (isContentLocked || !productionId || !canEditMetadata) return;
    const payload = activeVersionId
      ? { name: "", parentId: parentId ?? null, versionId: activeVersionId, ...target }
      : { name: "", parentId: parentId ?? null, ...target };
    await runSceneMenuMutation(
      () => createScene(productionId, payload),
      "添加章节失败，请稍后重试。"
    );
  };

  const updateScene = async (id: string, name: string) => {
    if (isContentLocked || !productionId || !canEditMetadata) return;
    await runSceneMenuMutation(
      () => renameScene(productionId, id, activeVersionId ? { name, versionId: activeVersionId } : { name }),
      "更新章节失败，请稍后重试。"
    );
  };

  const removeScene = async (id: string) => {
    if (isContentLocked || !productionId || !canEditMetadata) return;
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
    script.patchSceneDetails(id, fields);
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

    const blockIndex = script.getSnapshot().blocks.findIndex(block => block.id === nextBlockId);
    if (blockIndex >= 0) scrollToBlockIdx(blockIndex, "center");
  }, [assetPanelNavigationTargets, commentPanelNavigationTargets, openBlockSidePanel, script, scrollToBlockIdx]);

  // 与路由骨架（app/production/[id]/loading.tsx）同一个组件：RSC 换页与首窗到齐之间
  // 画面不变，不再「灰条列表 → 居中小字」闪两下（#652）。
  if (loadState === "loading") return <PageSkeleton instant />;

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
    const cachedIndex = script.getSnapshot().blockIndexById.get(blockId) ?? -1;
    const blockIndex = blocks[cachedIndex]?.id === blockId
      ? cachedIndex
      : blocks.findIndex((block) => block.id === blockId);
    return blockIndex >= 0 ? sceneIdForBlockAtIndex(blocks[blockIndex], blockIndex) : null;
  };
  const markerDeleteConfirmBlockIndex = markerDeleteConfirmBlockId
    ? script.getSnapshot().blockIndexById.get(markerDeleteConfirmBlockId)
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
  const effectivePersonalMode: ScriptPersonalMode = personalModeReady && baseCanEdit ? personalMode : "read";
  const personalModeLabel = effectivePersonalMode === "edit" ? "编辑" : "只读";
  const currentModeLabel = rehearsalMode ? "排练" : personalModeLabel;
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
                <ProductionOverflowSubmenuButton
                  menuId="mode"
                  label={`模式 · ${currentModeLabel}`}
                  expanded={openMenu === "mode"}
                  onToggle={(anchor) => openNestedMenu("mode", anchor)}
                />
                {canEditMetadata && (
                  <ProductionOverflowSubmenuButton
                    menuId="scene"
                    label="章节"
                    expanded={openMenu === "scene"}
                    onToggle={(anchor) => openNestedMenu("scene", anchor)}
                  />
                )}
                {(canEditMetadata || isContentLocked) && (
                  <ProductionOverflowSubmenuButton
                    menuId="char"
                    label="角色"
                    expanded={openMenu === "char"}
                    onToggle={(anchor) => openNestedMenu("char", anchor)}
                  />
                )}
                <ProductionOverflowSubmenuButton
                  menuId="edit"
                  label={isContentLocked ? "查找" : "编辑"}
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
              <ProductionTopMenuContext label="剧本" side="script" />
              <ProductionTopMenuDivider />
            </>
          )}
          {!isContentLocked && (
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
          <ScriptModeMenu
            compact={toolbarCompact}
            open={openMenu === "mode"}
            currentLabel={currentModeLabel}
            selectedMode={rehearsalMode ? null : effectivePersonalMode}
            canSelectEdit={baseCanEdit}
            pending={modeSwitchPending}
            error={modeSwitchError}
            menuClassName={rightMenuClass}
            nestedMenuRef={nestedMenuPosition.menuRef}
            nestedMenuStyle={nestedMenuPosition.style}
            onToggle={() => { clearModeSwitchError(); toggleMenu("mode"); }}
            onSelect={(mode) => { void selectPersonalMode(mode); }}
          />
          <div className={`${PRODUCTION_TOP_MENU_RIGHT_CLASS} ${presenceFolded ? "absolute right-0 flex w-0 items-center" : "ml-auto flex shrink-0 items-center gap-1"}`}>
          <div className={`${toolbarCompact ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
          {(canEditMetadata || isContentLocked) && (
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
                readOnly={isContentLocked}
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
              {toolbarShort ? (isContentLocked ? "找" : "编") : (isContentLocked ? "查找" : "编辑")} <ChevronIcon size={12} className="opacity-50" />
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
                    if (!canEditTextLayout) return;
                    pendingModeScrollAnchorRef.current = captureVirtualScrollAnchor();
                    saveScriptConfig({
                      textLayoutMode: scriptConfig.textLayoutMode === "compact" ? "center" : "compact",
                    });
                  }}
                  disabled={!canEditTextLayout}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                    canEditTextLayout ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"
                  }`}
                  title={canEditTextLayout ? "保存为所有人共用的剧本排版模式" : "只读模式或当前权限不允许修改剧本排版模式"}
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
                      onClick={toggleRehearsalMode}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span>排练模式</span>
                      <span className="flex items-center">
                        <ModeSwitch active={rehearsalMode} />
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
                : rehearsalMode
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
              {searchPending
                ? "正在搜索…"
                : searchMatches.length > 0
                  ? `${searchIdx + 1} / ${searchMatches.length}`
                  : searchQuery.trim() ? "无结果" : ""}
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

      {(explicitLoadTargetIndex !== null || windowLoadSlow || windowLoadFailed) && (
        <div
          role="status"
          className={`fixed left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-zinc-200/80 bg-white/90 px-3 py-1 text-xs text-zinc-500 shadow-sm backdrop-blur${windowLoadFailed ? "" : " pointer-events-none"}`}
        >
          {windowLoadFailed ? "此处暂时没有加载出来" : windowLoadSlow ? "网络较慢，仍在加载…" : "正在前往…"}
          {windowLoadFailed && (
            <button
              type="button"
              onClick={() => setWindowRetryToken((token) => token + 1)}
              className="font-medium text-zinc-700 underline underline-offset-2"
            >
              重试
            </button>
          )}
        </div>
      )}
      {recoveryStatus !== "ready" && (
        <div role="status" className="fixed right-4 top-16 z-30 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-xs text-amber-800 shadow-sm">
          {recoveryStatus === "failed" ? "重连失败，暂时无法编辑" : "重连中…"}
          {recoveryStatus === "failed" && <button className="ml-2 underline" onClick={() => {
            if (streamConnectedRef.current) void recoverScript();
            else setStreamRetryToken(token => token + 1);
          }}>重试</button>}
        </div>
      )}
      {syncConflict && recoveryStatus === "ready" && (
        <div role="status" className="fixed right-4 top-16 z-30 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-xs text-amber-800 shadow-sm">
          剧本已被他人修改，部分本地修改未上传，已加载最新内容
          <button className="ml-2 underline" onClick={() => sync.dismissConflict()}>知道了</button>
        </div>
      )}
      {syncWaitingForNetwork && recoveryStatus === "ready" && !syncConflict && (
        <div
          role="status"
          className="fixed right-4 top-16 z-30 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-xs text-amber-800 shadow-sm"
        >
          等待网络，修改尚未同步
        </div>
      )}

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
            onDragOver={handleScriptDragOver}
            onDrop={handleScriptDrop}
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
            if (!isMarkerBlock(block) && script.getSnapshot().manifestIds.has(block.id) && !loadedBlockIds.has(block.id)) {
              return [
                <div
                  key={block.id}
                  id={`block-${block.id}`}
                  data-vitem={block.id}
                  data-bwrap={block.id}
                  aria-label="正在加载剧本内容"
                  className="min-h-20 animate-pulse rounded-md px-4 py-3"
                >
                  <div className="mb-2 h-2 w-20 rounded bg-zinc-200/65" />
                  <div className="mb-2 h-2 w-4/5 rounded bg-zinc-200/55" />
                  <div className="h-2 w-3/5 rounded bg-zinc-200/45" />
                </div>,
              ];
            }
            const prev = bIdx > 0 ? blocks[bIdx - 1] : null;
            const hasInsertionGap = hasScriptInsertionGapBefore(blocks, bIdx, sceneParentIdById);
            const showSceneEndGap = rehearsalMode && shouldShowSceneEndGap(prev, block);
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
                      if (!isReorderLockedRef.current) selection.clickMarker(block.id, { shiftKey: e.shiftKey, additive: e.ctrlKey || e.metaKey });
                    }}
                    onSceneNameChange={updateScene}
                    onDragStart={(e) => beginBlockDrag(e, block.id, true)}
                    onDragEnd={endBlockDrag}
                    onDragOver={handleScriptDragOver}
                    onDrop={handleScriptDrop}
                    lineIndexWidth={markerLineIndexWidthStyle}
                    reserveRehearsalGap={rehearsalMode}
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
            const isBlockFocused = !isContentLocked && focusedId === block.id;
            const hideCharSelector =
              isBlockFocused || pageBreak
                ? false
                : shouldHideCharacterLabel(
                    projectedOwnedPrev,
                    projectedOwnedBlock,
                  );
            const showCharacterGap = rehearsalMode && shouldShowCharacterGap(projectedOwnedPrev, projectedOwnedBlock, hideCharSelector);
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
                  readOnlyRehearsalMode={rehearsalMode}
                  readOnlyScene={rehearsalMode && display.rehearsalBlockScenes && ownedSceneId ? sceneById.get(ownedSceneId) ?? null : null}
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
                    selection.clickText(block.id, { shiftKey: e.shiftKey, additive: e.ctrlKey || e.metaKey || (
                      window.matchMedia("(max-width: 639px)").matches && selection.getSnapshot().selectedIds.size > 0
                    ) });
                  }}
                  onDeleteConfirmationChange={(active) => {
                    setDeleteConfirmingBlockIds((current) => {
                      if (active) return new Set(selectedDeleteIds);
                      return current.size === 0 ? current : new Set();
                    });
                  }}
                  onDragStartBlock={(e) => beginBlockDrag(e, block.id, false)}
                  onDragEndBlock={endBlockDrag}
                  onDragOverBlock={handleScriptDragOver}
                  onDropBlock={handleScriptDrop}
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
                  onMobileMenuOpen={(caretOffset) => {
                    openMobileBlockMenu(block.id, bIdx, caretOffset);
                  }}
                />
              </div>
            );
            const preBlockGap = bIdx > 0
              ? canEditText && hasInsertionGap ? <InsertZone lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(bIdx)} /> :
                showSceneEndGap ? <BlockGap /> :
                rehearsalMode && showCharacterGap ? <BlockGap /> :
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
              onGroupsChange={script.editTagGroups}
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

      {pendingRehearsalMode !== null && (
        <RehearsalModeDialog
          entering={pendingRehearsalMode}
          pending={rehearsalModeSwitchPending}
          error={rehearsalModeSwitchError}
          onClose={() => {
            if (rehearsalModeSwitchPending) return;
            setPendingRehearsalMode(null);
            setRehearsalModeSwitchError("");
          }}
          onConfirm={() => { void confirmRehearsalModeChange(); }}
        />
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
            const index = script.getSnapshot().blockIndexById.get(marker.id);
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
          const index = script.getSnapshot().blockIndexById.get(id);
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
        const menuBlockIndex = blocks.findIndex((block) => block.id === menuBlock.id);
        const blockInsertDisabledReason = canEditText
          ? null
          : !baseCanEditText
            ? "需要剧本文本编辑权限"
            : rehearsalMode
              ? "排练模式下不可添加"
              : "只读模式下不可添加";
        const insertActions: Array<{ label: string; action: () => void; disabledReason?: string | null }> = [
          {
            label: "添加新剧本块",
            action: () => insertBlockAt(menuBlockIndex),
            disabledReason: blockInsertDisabledReason,
          },
          ...(canEditMetadata ? [
            { label: "添加新章", action: () => addChapterBeforeBlock(menuBlock.id) },
            { label: "添加新段", action: () => addSceneBeforeBlock(menuBlock.id) },
          ] : []),
          ...(canAddRehearsalMark ? [
            { label: "添加新排练记号", action: () => addRehearsalBeforeBlock(menuBlock.id) },
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
              data-script-mobile-block-id={menuBlock.id}
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
                    {mobileInsertMenuOpen && insertActions.map(({ label, action, disabledReason }) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => { if (!disabledReason) runAndClose(action); }}
                        aria-disabled={!!disabledReason}
                        title={disabledReason ?? undefined}
                        className={`flex w-full items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50 px-8 py-3 text-left text-[14px] ${
                          disabledReason ? "cursor-not-allowed text-zinc-300" : "text-zinc-600"
                        }`}
                      >
                        <span>{label}</span>
                        {disabledReason && <span className="text-xs">{disabledReason}</span>}
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
                {!isMarker && !isBatchMode && canEditText && (
                  <button
                    onClick={() => insertMobileBlockLineBreak(mobileBlockMenuBlockId)}
                    className="w-full px-5 py-3.5 text-left text-[15px] text-zinc-700 border-t border-zinc-100"
                  >
                    块内换行
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
