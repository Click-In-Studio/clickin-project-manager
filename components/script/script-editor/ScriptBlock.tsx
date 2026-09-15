"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { TagGroup, BlockTagValue } from "@/lib/db";
import type { BlockDragTarget } from "@/lib/script/script-drag-target";
import type { LargeSelectionOperation } from "@/lib/script/script-large-selection";
import { mdToHtml } from "@/lib/script/script-md";
import type { Block, BlockType, Character, Scene, ScriptTextLayoutMode } from "@/lib/script/script-types";
import BlockCharacterSelector from "./BlockCharacterSelector";
import BlockStageComment from "./BlockStageComment";
import CommentBubble from "./CommentBubble";
import RehearsalMarkInput from "./RehearsalMarkInput";
import RehearsalMarkLabel from "./RehearsalMarkLabel";
import SceneLabel from "./SceneLabel";
import TagPicker from "./TagPicker";
import { buildCommentBlockCaption, type RemotePresence, type Comment, type BlockAssetBubbleItem } from "./comments";
import { COMPACT_STAGE_COMMENT_EDITOR_WIDTH_RATIO, LINE_INDEX_GUTTER_OFFSET_REM, LINE_INDEX_CONTROL_MIN_WIDTH_REM } from "./constants";
import { isAtStart, isOnFirstLine, isOnLastLine, getHtmlSplit } from "./dom-cursor";
import { sanitizePasteHtml, htmlToMd, toggleInlineTag, wrapSelectionAsInlineStageCue, applyInlineStageStyling } from "./inline-stage";

export const COMPACT_STAGE_CONTROL_THRESHOLD_REM = 1.9;
export const COMPACT_STAGE_DELETE_SHIFT_PX = -3;
export const COMPACT_CONTENT_OPTICAL_OFFSET_PX = -2;
export const COMPACT_CHARACTER_COLUMN_WIDTH_REM = 7.5;
export const NARROW_COMPACT_CHARACTER_COLUMN_WIDTH_REM = 3.5;
export const COMPACT_TEXT_AUXILIARY_WIDTH_REM = 2;
export const COMPACT_TEXT_GRID_STYLE = {
  "--compact-character-column-width": `${NARROW_COMPACT_CHARACTER_COLUMN_WIDTH_REM}rem`,
  "--compact-character-column-width-wide": `${COMPACT_CHARACTER_COLUMN_WIDTH_REM}rem`,
} as React.CSSProperties;
export const COMPACT_TEXT_GRID_UNFOLDED_STYLE = {
  ...COMPACT_TEXT_GRID_STYLE,
  "--compact-character-column-width": `${COMPACT_CHARACTER_COLUMN_WIDTH_REM}rem`,
} as React.CSSProperties;
export const IN_BLOCK_STAGE_COMMENT_MANUAL_OFFSET_PX = -2;
export const REHEARSAL_NON_COMPACT_CHARACTER_BOTTOM_GAP_CLASS = "mb-[0.18rem]";
export const REHEARSAL_NON_COMPACT_CHARACTER_STAGE_COMMENT_GAP_CLASS = "mb-2";
export const REHEARSAL_NON_COMPACT_HIDDEN_CHARACTER_STAGE_COMMENT_GAP_CLASS = "mt-1";

export function getCompactFallbackLineHeightPx() {
  if (typeof window === "undefined") return 28;
  const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(rootFontSize) ? rootFontSize : 16) * 1.75;
}

export default function ScriptBlock({
  block,
  characters,
  scenes,
  hideCharSelector,
  isFocused,
  charEditToken,
  presenceEditors,
  onRegisterRef,
  onUpdate,
  onSplit,
  onMerge,
  onDelete,
  onFocus,
  onDeleteFocus,
  onToggleType,
  onToggleLyric,
  onRequestLargeSelectionOperation,
  onCanStartSelectionAction,
  onArrowUpFromChar,
  onArrowDownFromChar,
  onArrowUpFromTextarea,
  onArrowDownFromTextarea,
  onAddChapterBefore,
  onAddSceneBefore,
  onAddRehearsalBefore,
  onDragStartBlock,
  onDragEndBlock,
  onDragOverBlock,
  onDropBlock,
  onToggleSelected,
  onDeleteConfirmationChange,
  isMarkStart,
  commentCount,
  blockComments,
  blockAssets,
  isCommentPanelActive,
  isAssetPanelActive,
  commentBubbleOffsetY = 0,
  commentBubbleMode,
  commentBubbleWidth,
  onCommentClick,
  onAssetClick,
  dragTarget = null,
  isSelected = false,
  isDeleteConfirmHighlighted = false,
  isCharacterFocusHighlighted = false,
  isRecentlyMoved = false,
  deleteConfirmToken,
  selectedCount = 0,
  dismissToken = 0,
  canDeleteWithoutConfirmation = false,
  deleteConfirmNoopMessage,
  isReorderLocked = false,
  isScriptDragging = false,
  lineNum,
  captionLineNum,
  lineIndexWidth,
  isSearchHighlight,
  showReadOnlyRehearsalMark = false,
  readOnlyRehearsalMode = false,
  readOnlyScene = null,
  showSceneLabel = true,
  stageDelimOpen = "（",
  stageDelimClose = "）",
  textLayoutMode = "center",
  canEditText = false,
  canEditMetadata = false,
  canEditRehearsalMark = false,
  canMergeWithPrevious = false,
  tagGroups,
  blockTagValues,
  showBlockTags = false,
  hasLyricConfig = false,
  onTagChange,
  onTagCopyClick,
  onTagPasteClick,
  onCharacterChangeFocus,
  onMobileMenuOpen,
  contentPlaceholder,
}: {
  block: Block;
  characters: Character[];
  scenes: Scene[];
  hideCharSelector: boolean;
  isFocused: boolean;
  charEditToken: number;
  presenceEditors: RemotePresence[];
  onRegisterRef: (id: string, el: HTMLDivElement | null) => void;
  onUpdate: (changes: Partial<Block>) => void;
  onSplit: (before: string, after: string) => void;
  onMerge: () => void;
  onDelete: () => void;
  onFocus: () => void;
  onDeleteFocus: () => void;
  onToggleType: () => void;
  onToggleLyric: () => void;
  onRequestLargeSelectionOperation: (operation: LargeSelectionOperation, count: number, onConfirm: () => void) => void;
  onCanStartSelectionAction: () => boolean;
  onArrowUpFromChar: () => void;
  onArrowDownFromChar: () => void;
  onArrowUpFromTextarea: () => void;
  onArrowDownFromTextarea: () => void;
  onAddChapterBefore: () => void;
  onAddSceneBefore: () => void;
  onAddRehearsalBefore: () => void;
  onDragStartBlock: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEndBlock: () => void;
  onDragOverBlock: (e: DragEvent<HTMLDivElement>) => void;
  onDropBlock: (e: DragEvent<HTMLDivElement>) => void;
  onToggleSelected: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDeleteConfirmationChange: (active: boolean) => void;
  isMarkStart: boolean;
  commentCount: number;
  blockComments: Comment[];
  blockAssets: BlockAssetBubbleItem[];
  isCommentPanelActive: boolean;
  isAssetPanelActive: boolean;
  commentBubbleOffsetY?: number;
  commentBubbleMode: "full" | "compact" | null;
  commentBubbleWidth: number;
  onCommentClick: () => void;
  onAssetClick: () => void;
  dragTarget?: BlockDragTarget | null;
  isSelected?: boolean;
  isDeleteConfirmHighlighted?: boolean;
  isCharacterFocusHighlighted?: boolean;
  isRecentlyMoved?: boolean;
  deleteConfirmToken?: number;
  selectedCount?: number;
  dismissToken?: number;
  canDeleteWithoutConfirmation?: boolean;
  deleteConfirmNoopMessage?: string;
  isReorderLocked?: boolean;
  isScriptDragging?: boolean;
  lineNum?: number;
  captionLineNum: number;
  lineIndexWidth?: string;
  isSearchHighlight?: "match" | "focused";
  showReadOnlyRehearsalMark?: boolean;
  readOnlyRehearsalMode?: boolean;
  readOnlyScene?: Scene | null;
  showSceneLabel?: boolean;
  stageDelimOpen?: string;
  stageDelimClose?: string;
  textLayoutMode?: ScriptTextLayoutMode;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
  canMergeWithPrevious?: boolean;
  tagGroups?: TagGroup[];
  blockTagValues?: BlockTagValue[];
  showBlockTags?: boolean;
  hasLyricConfig?: boolean;
  onTagChange?: (groupId: string, optionId: string | null, value: number | null, del: boolean) => void;
  onTagCopyClick?: () => void;
  onTagPasteClick?: () => void;
  onCharacterChangeFocus?: () => void;
  onMobileMenuOpen?: () => void;
  contentPlaceholder?: string;
}) {
  const blockRootRef = useRef<HTMLDivElement | null>(null);
  const leftControlsRef = useRef<HTMLDivElement | null>(null);
  const blockTagsRef = useRef<HTMLDivElement | null>(null);
  const compactCharacterColumnRef = useRef<HTMLDivElement | null>(null);
  const divRef = useRef<HTMLDivElement | null>(null);
  const localContentRef = useRef<string | null>(null);
  const localTypeRef = useRef<BlockType | null>(null);
  const localStageDelimRef = useRef<{ open: string | null; close: string | null }>({ open: null, close: null });
  const latestBlockRef = useRef(block);
  const latestStageDelimRef = useRef({ open: stageDelimOpen, close: stageDelimClose });
  const composingRef = useRef(false);
  const compactControlLayoutActiveRef = useRef(false);
  const [charSelectorOpen, setCharSelectorOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTypeAction, setConfirmTypeAction] = useState<"type" | "lyric" | null>(null);
  const [stageCommentEditing, setStageCommentEditing] = useState(false);
  const [stageCommentOverflowBelow, setStageCommentOverflowBelow] = useState(0);
  const [commentBubbleHovered, setCommentBubbleHovered] = useState(false);
  const [compactCharacterColumnHeight, setCompactCharacterColumnHeight] = useState(0);
  const [compactCharacterLineHeight, setCompactCharacterLineHeight] = useState(getCompactFallbackLineHeightPx);
  const [compactContentLineHeight, setCompactContentLineHeight] = useState(getCompactFallbackLineHeightPx);
  const [unfoldForCompactControls, setUnfoldForCompactControls] = useState(false);
  const [compactControlLayout, setCompactControlLayout] = useState<{
    deleteLeft: number | null;
    compact: boolean;
    hoverWidth: number;
    mode: "stage" | "hidden-character";
  } | null>(null);

  useEffect(() => {
    setConfirmDelete(false);
    setConfirmTypeAction(null);
  }, [dismissToken]);

  useEffect(() => {
    if (deleteConfirmToken === undefined) return;
    setConfirmDelete(true);
  }, [deleteConfirmToken]);

  latestBlockRef.current = block;
  latestStageDelimRef.current = { open: stageDelimOpen, close: stageDelimClose };

  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      divRef.current = el;
      if (el) {
        const currentBlock = latestBlockRef.current;
        const currentDelims = latestStageDelimRef.current;
        el.innerHTML = currentBlock.type === "stage"
          ? mdToHtml(currentBlock.content)
          : mdToHtml(currentBlock.content, currentDelims.open, currentDelims.close);
        localContentRef.current = currentBlock.content;
        localTypeRef.current = currentBlock.type;
        localStageDelimRef.current = currentDelims;
      }
      onRegisterRef(block.id, el);
    },
    [block.id, onRegisterRef]
  );

  const isStage = block.type === "stage";
  const isCompactTextLayout = textLayoutMode === "compact" && !isStage;
  const hasBlockTags = !isStage && showBlockTags && !!tagGroups?.length;
  const isEditingLocked = isSelected || confirmDelete || isDeleteConfirmHighlighted;
  const hiddenCharacterCollapsed = !isStage && hideCharSelector && !isFocused && !isSelected;
  const canUnfoldHiddenCharacterControls = hiddenCharacterCollapsed && !isCompactTextLayout;
  const effectiveHideCharSelector = hideCharSelector && !(canUnfoldHiddenCharacterControls && unfoldForCompactControls);
  const shouldMeasureCompactControls = canEditText && (
    isStage || isCompactTextLayout || canUnfoldHiddenCharacterControls && !unfoldForCompactControls
  );
  const isCompactHiddenCharacterLayout = !!(
    compactControlLayout?.compact && compactControlLayout.mode === "hidden-character"
  );
  const unfoldCompactControls = () => {
    if (canUnfoldHiddenCharacterControls && isCompactHiddenCharacterLayout && !unfoldForCompactControls) {
      setUnfoldForCompactControls(true);
    }
  };
  const resetCompactControlHover = () => {
    if (unfoldForCompactControls) setUnfoldForCompactControls(false);
  };

  useEffect(() => {
    if (!shouldMeasureCompactControls) {
      compactControlLayoutActiveRef.current = false;
      setCompactControlLayout(null);
      return;
    }

    const blockEl = blockRootRef.current;
    if (!blockEl) return;

    const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    const compactControlThreshold = COMPACT_STAGE_CONTROL_THRESHOLD_REM * (Number.isFinite(rootFontSize) ? rootFontSize : 16);

    const updateCompactControls = () => {
      const railEl = leftControlsRef.current;
      const triangleEl = blockEl.querySelector<HTMLElement>("[data-rehearsal-triangle='true']");
      const mode = isStage ? "stage" : "hidden-character";
      const blockRect = blockEl.getBoundingClientRect();
      const tagRect = hasBlockTags
        ? blockTagsRef.current?.getBoundingClientRect()
        : null;
      const measuredBlockHeight = tagRect
        ? Math.max(blockRect.height, tagRect.bottom - blockRect.top)
        : blockRect.height;
      const isCompactBlock = measuredBlockHeight < compactControlThreshold;

      if (isCompactBlock) compactControlLayoutActiveRef.current = true;

      if (!compactControlLayoutActiveRef.current || !railEl || !triangleEl) {
        setCompactControlLayout(null);
        return;
      }

      const railRect = railEl.getBoundingClientRect();
      const triangleRect = triangleEl.getBoundingClientRect();
      const measuredDeleteLeft = triangleRect.left - railRect.left + COMPACT_STAGE_DELETE_SHIFT_PX;
      const deleteLeft = isCompactBlock ? measuredDeleteLeft : null;
      const controlRight = Math.max(triangleRect.right, railRect.left + measuredDeleteLeft + 16);
      const hoverWidth = Math.max(16, Math.ceil(controlRight - railRect.left));

      setCompactControlLayout((prev) => {
        if (
          prev &&
          prev.compact === isCompactBlock &&
          prev.mode === mode &&
          Math.abs(prev.hoverWidth - hoverWidth) < 0.5 &&
          (prev.deleteLeft === null && deleteLeft === null ||
            prev.deleteLeft !== null && deleteLeft !== null && Math.abs(prev.deleteLeft - deleteLeft) < 0.5)
        ) {
          return prev;
        }
        return { deleteLeft, compact: isCompactBlock, hoverWidth, mode };
      });
    };

    const observer = new ResizeObserver(updateCompactControls);
    observer.observe(blockEl);
    const tagEl = blockTagsRef.current;
    if (tagEl) observer.observe(tagEl);
    return () => observer.disconnect();
  }, [shouldMeasureCompactControls, isStage, hasBlockTags, lineNum, canEditRehearsalMark]);

  // Sync state → DOM only for external changes (split, merge, type toggle, etc.)
  useLayoutEffect(() => {
    const div = divRef.current;
    if (!div) return;
    const contentOrTypeChanged = block.content !== localContentRef.current || block.type !== localTypeRef.current;
    const stageDelimChanged =
      stageDelimOpen !== localStageDelimRef.current.open ||
      stageDelimClose !== localStageDelimRef.current.close;

    if (contentOrTypeChanged) {
      localContentRef.current = block.content;
      localTypeRef.current = block.type;
      div.innerHTML = block.type === "stage"
        ? mdToHtml(block.content)
        : mdToHtml(block.content, stageDelimOpen, stageDelimClose);
    }
    if (block.type !== "stage" && stageDelimChanged && !contentOrTypeChanged) {
      applyInlineStageStyling(div, stageDelimOpen, stageDelimClose);
    }
    localStageDelimRef.current = { open: stageDelimOpen, close: stageDelimClose };
  }, [block.content, block.type, stageDelimOpen, stageDelimClose]);

  const syncContent = () => {
    if (!canEditText) return;
    let html = divRef.current?.innerHTML ?? "";
    if (html === "<br>") html = "";
    const md = htmlToMd(html);
    localContentRef.current = md;
    onUpdate({ content: md });
  };

  const applyInlineFormat = (tag: "b" | "u") => {
    if (!canEditText) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    toggleInlineTag(sel.getRangeAt(0), tag);
    syncContent();
  };

  const handleInput = () => {
    if (!canEditText) return;
    if (composingRef.current) return;
    const div = divRef.current;
    if (!div) return;
    if (block.type !== "stage") applyInlineStageStyling(div, stageDelimOpen, stageDelimClose);
    syncContent();
  };

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = () => { composingRef.current = false; if (canEditText) syncContent(); };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canEditText) {
      e.preventDefault();
      return;
    }
    const div = divRef.current!;

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      if (isStage || hasLyricConfig) return;
      if (selectedCount > 1) setConfirmTypeAction("lyric");
      else onToggleLyric();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        const sel = window.getSelection();
        if (block.type !== "stage" && sel && !sel.isCollapsed && div.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0);
          wrapSelectionAsInlineStageCue(range, stageDelimOpen, stageDelimClose);
          syncContent();
        } else {
          onToggleType();
        }
        return;
      }
      if (e.key === "b" || e.key === "B") { e.preventDefault(); applyInlineFormat("b"); return; }
      if (e.key === "u" || e.key === "U") { e.preventDefault(); applyInlineFormat("u"); return; }
    }

    if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (isOnFirstLine(div)) { e.preventDefault(); onArrowUpFromTextarea(); return; }
    }
    if (e.key === "ArrowDown" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (isOnLastLine(div)) { e.preventDefault(); onArrowDownFromTextarea(); return; }
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement("br");
        range.insertNode(br);
        range.setStartAfter(br);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        syncContent();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const { before, after } = getHtmlSplit(div);
      onSplit(htmlToMd(before), htmlToMd(after));
      return;
    }
    if (e.key === "Backspace" && isAtStart(div)) {
      e.preventDefault();
      if (canMergeWithPrevious) onMerge();
    }
  };

  const firstEditor = presenceEditors[0];

  const searchRingClass =
    isSearchHighlight === "focused" ? "ring-2 ring-inset ring-amber-400" :
    isSearchHighlight === "match"   ? "ring-1 ring-inset ring-amber-200" : "";
  const hasExpandedSidePanel = isCommentPanelActive || isAssetPanelActive || commentBubbleHovered;
  const hasSideVisibleHighlight = hasExpandedSidePanel || isCharacterFocusHighlighted;
  const hasHardBlockHighlight = isDeleteConfirmHighlighted || isSelected;
  const usePartialFocusHighlight = isFocused && !hasHardBlockHighlight && hasSideVisibleHighlight;
  const blockBgClass = isDeleteConfirmHighlighted
    ? "bg-red-100"
    : isSelected
      ? "bg-[#eef3fa]"
      : isFocused && !hasSideVisibleHighlight
      ? "bg-zinc-100/70"
      : hasExpandedSidePanel
        ? "bg-emerald-500/10"
    : isCharacterFocusHighlighted
      ? "bg-purple-50"
      : captionLineNum % 2 === 1
        ? "bg-zinc-50/60"
        : "";
  const movedGlowClass = isRecentlyMoved ? "script-block-moved-glow" : "";
  const compactDeleteStyle: React.CSSProperties | undefined = compactControlLayout?.deleteLeft !== null && compactControlLayout?.deleteLeft !== undefined
    ? { left: compactControlLayout.deleteLeft }
    : undefined;
  const displayScene = showSceneLabel
    ? readOnlyScene ?? (block.sceneId ? scenes.find((scene) => scene.id === block.sceneId) ?? null : null)
    : null;
  const hasSceneLabel = !!displayScene;
  const hasStageComment = !!block.stageComment?.trim();
  const showCompactStageCommentRow = hasStageComment || stageCommentEditing;
  const stageCommentManualOffsetYPx =
    isCompactTextLayout && (canEditText || readOnlyRehearsalMode) && (hasStageComment || stageCommentEditing)
      ? IN_BLOCK_STAGE_COMMENT_MANUAL_OFFSET_PX
      : 0;
  const characterBottomGapClassName =
    readOnlyRehearsalMode && !isCompactTextLayout && block.characterIds.length > 0
      ? hasStageComment
        ? REHEARSAL_NON_COMPACT_CHARACTER_STAGE_COMMENT_GAP_CLASS
        : REHEARSAL_NON_COMPACT_CHARACTER_BOTTOM_GAP_CLASS
      : undefined;
  const compactCharacterLastLineCenter = compactCharacterColumnHeight - compactCharacterLineHeight / 2;
  const compactContentFirstLineTop = Math.max(
    0,
    Math.round(compactCharacterLastLineCenter - compactContentLineHeight / 2 + COMPACT_CONTENT_OPTICAL_OFFSET_PX)
  );
  const showStageCommentAddButton = !hasStageComment && (
    isCompactTextLayout ||
    (!isCompactTextLayout && !effectiveHideCharSelector)
  );
  const handleCommentClick = () => {
    setCommentBubbleHovered(false);
    onCommentClick();
  };
  const handleAssetClick = () => {
    setCommentBubbleHovered(false);
    onAssetClick();
  };
  const showCharacterSelector = !effectiveHideCharSelector || isFocused || isSelected;
  const stageCommentPlacementClassName =
    readOnlyRehearsalMode && !isCompactTextLayout && hasStageComment && !showCharacterSelector
      ? REHEARSAL_NON_COMPACT_HIDDEN_CHARACTER_STAGE_COMMENT_GAP_CLASS
      : undefined;
  const compactControlHoverStyle: React.CSSProperties | undefined = isCompactHiddenCharacterLayout
    ? { width: compactControlLayout.hoverWidth }
    : undefined;
  const rightActionRowClass = `absolute z-20 hidden sm:flex items-center transition-opacity ${
    isStage || isCompactTextLayout || isCompactHiddenCharacterLayout ? "-top-5" : "top-1"
  } ${hasSceneLabel ? "right-8" : "right-2"}`;
  const readOnlySceneLabelClass = `absolute right-1.5 z-10 leading-none ${
    isStage || isCompactTextLayout || isCompactHiddenCharacterLayout ? "-top-5" : "top-1"
  }`;
  const lineNumberClass = isFocused
    ? "text-zinc-600"
    : readOnlyRehearsalMode
      ? "text-zinc-300 group-hover:text-zinc-500"
      : "text-zinc-400 group-hover:text-zinc-600";
  const blockRootStyle: React.CSSProperties | undefined = lineIndexWidth
    ? { paddingLeft: `calc(${lineIndexWidth} + ${LINE_INDEX_GUTTER_OFFSET_REM}rem)` }
    : undefined;
  const partialFocusStyle: React.CSSProperties | undefined = usePartialFocusHighlight
    ? {
        backgroundImage: "linear-gradient(rgba(244, 244, 245, 0.7), rgba(244, 244, 245, 0.7))",
        backgroundPosition: "left 1.5rem center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "calc(100% - 2rem) 100%",
      }
    : undefined;
  const combinedBlockRootStyle: React.CSSProperties | undefined =
    blockRootStyle || partialFocusStyle
      ? ({
          ...blockRootStyle,
          ...partialFocusStyle,
        } as React.CSSProperties)
      : undefined;
  const commentBlockCaption = commentBubbleMode === "full"
    && !isCommentPanelActive
    && !isAssetPanelActive
    && (blockComments.length > 0 || blockAssets.length > 0)
    ? buildCommentBlockCaption(block, characters, captionLineNum)
    : null;
  const lineIndexSlotStyle: React.CSSProperties | undefined = lineNum === undefined
    ? {
        width: lineIndexWidth
          ? lineIndexWidth
          : `${LINE_INDEX_CONTROL_MIN_WIDTH_REM}rem`,
      }
    : undefined;

  const measureStageCommentEditorWidth = useCallback(() => {
    const blockEl = blockRootRef.current;
    if (!blockEl) return null;
    const blockStyle = window.getComputedStyle(blockEl);
    const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    const remPx = Number.isFinite(rootFontSize) ? rootFontSize : 16;
    const blockContentWidth =
      blockEl.getBoundingClientRect().width -
      parseFloat(blockStyle.paddingLeft) -
      parseFloat(blockStyle.paddingRight);
    const compactCharacterWidth = compactCharacterColumnRef.current?.getBoundingClientRect().width
      ?? COMPACT_CHARACTER_COLUMN_WIDTH_REM * remPx;
    const compactContentWidth = blockContentWidth - compactCharacterWidth - COMPACT_TEXT_AUXILIARY_WIDTH_REM * remPx;
    const width = Math.round(compactContentWidth * COMPACT_STAGE_COMMENT_EDITOR_WIDTH_RATIO);
    return width > 0 ? width : null;
  }, []);

  useLayoutEffect(() => {
    if (!isCompactTextLayout) return;
    const el = compactCharacterColumnRef.current;
    if (!el) return;
    const measure = () => {
      const height = el.getBoundingClientRect().height;
      setCompactCharacterColumnHeight(height);
      const characterLabelEl = el.querySelector<HTMLElement>("[data-character-label='true']");
      if (characterLabelEl) {
        const lineHeight = parseFloat(window.getComputedStyle(characterLabelEl).lineHeight);
        if (Number.isFinite(lineHeight)) setCompactCharacterLineHeight(lineHeight);
      }
      const contentEl = divRef.current;
      if (contentEl) {
        const lineHeight = parseFloat(window.getComputedStyle(contentEl).lineHeight);
        if (Number.isFinite(lineHeight)) setCompactContentLineHeight(lineHeight);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isCompactTextLayout, showCharacterSelector, block.characterIds, block.characterAnnotations]);

  useEffect(() => {
    if (!showCompactStageCommentRow && stageCommentOverflowBelow !== 0) {
      setStageCommentOverflowBelow(0);
    }
  }, [showCompactStageCommentRow, stageCommentOverflowBelow]);

  return (
    <div
      id={`block-content-${block.id}`}
      data-block-content={block.id}
      ref={blockRootRef}
      onDragOver={onDragOverBlock}
      onDrop={onDropBlock}
      onMouseLeave={resetCompactControlHover}
      style={combinedBlockRootStyle}
      className={`group relative px-6 py-0 text-center transition-colors ${searchRingClass} ${blockBgClass} ${movedGlowClass}`}
    >
      {dragTarget && (
        <div
          className={`pointer-events-none absolute left-4 right-4 z-10 border-t-2 ${
            dragTarget.position === "before" ? "-top-2.5" : "-bottom-2.5"
          }`}
          style={{ borderColor: "#91a8ca" }}    /* my signature color (lighter version). ^v^ -- QPT */
        />
      )}

      {(lineNum !== undefined || canEditMetadata || canEditRehearsalMark || (showReadOnlyRehearsalMark && isMarkStart && block.rehearsalMark)) && (
        <span className="absolute left-1.5 top-[3px] z-20 flex items-start gap-1 leading-none">
          {lineNum !== undefined && (
            <span
              className={`pointer-events-none select-none tabular-nums text-[9px] leading-none transition-colors ${lineNumberClass}`}
            >
              {lineNum}
            </span>
          )}
          {lineNum === undefined && (
            <span aria-hidden className="pointer-events-none shrink-0 select-none" style={lineIndexSlotStyle} />
          )}
          {(canEditMetadata || canEditRehearsalMark) && (
            <span
              onMouseEnter={unfoldCompactControls}
              className="relative top-[1px] hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex"
            >
              <RehearsalMarkInput
                canAddChapterScene={canEditMetadata}
                canAddRehearsal={canEditRehearsalMark}
                onAddChapterBefore={onAddChapterBefore}
                onAddSceneBefore={onAddSceneBefore}
                onAddRehearsalBefore={onAddRehearsalBefore}
              />
            </span>
          )}
          {!canEditRehearsalMark && showReadOnlyRehearsalMark && isMarkStart && block.rehearsalMark && (
            <span className="relative top-[1px]">
              <RehearsalMarkLabel mark={block.rehearsalMark} />
            </span>
          )}
        </span>
      )}

      {canEditText && (
        <div
          ref={leftControlsRef}
          onMouseEnter={unfoldCompactControls}
          style={compactControlHoverStyle}
          className="absolute left-0 top-1 bottom-0 flex w-4 flex-col items-start justify-between"
        >
          <span />

          {( /* `91a8ca` is my signature color (lighter version). ^v^ -- QPT */
            confirmDelete ? (
              <span
                className="absolute left-0 bottom-0 z-10 hidden translate-x-5 items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm sm:flex"
                style={compactDeleteStyle}
                data-script-confirmation="true"
              >
                <span className="whitespace-nowrap text-[10px] text-zinc-400">
                  {deleteConfirmNoopMessage ?? (selectedCount > 1 ? `确认删除所选 ${selectedCount} 行？` : "确认删除此行？")}
                </span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (deleteConfirmNoopMessage) {
                      setConfirmDelete(false);
                      onDeleteConfirmationChange(false);
                      return;
                    }
                    onRequestLargeSelectionOperation("delete", selectedCount, () => {
                      setConfirmDelete(false);
                      onDeleteConfirmationChange(false);
                      onDelete();
                    });
                  }}
                  className="shrink-0 whitespace-nowrap text-[10px] text-red-500 hover:text-red-700"
                >
                  确认
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setConfirmDelete(false); onDeleteConfirmationChange(false); }}
                  className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400 hover:text-zinc-600"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                data-script-selection-action={selectedCount > 1 ? "true" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (isScriptDragging) return;
                  if (!onCanStartSelectionAction()) return;
                  onDeleteFocus();
                  if (canDeleteWithoutConfirmation) {
                    onRequestLargeSelectionOperation("delete", selectedCount, onDelete);
                  }
                  else { setConfirmDelete(true); onDeleteConfirmationChange(true); }
                }}
                style={compactDeleteStyle}
                className="relative hidden h-4 w-4 items-center justify-center rounded text-[12px] leading-none text-zinc-300 opacity-0 transition-all hover:bg-red-100 hover:text-red-500 group-hover:opacity-100 sm:flex"
                title="删除此行"
                aria-label="删除此行"
              >
                ×
              </button>
            )
          )}

          {(
            <button
              draggable={!isReorderLocked}
              disabled={isReorderLocked}
              data-script-block-bar="true"
              onDragStart={onDragStartBlock}
              onDragEnd={onDragEndBlock}
              onMouseDown={(e) => {
                if (e.shiftKey) e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                onToggleSelected(e);
                if (window.matchMedia("(max-width: 639px)").matches) onMobileMenuOpen?.();
              }}
              className={`absolute left-0 top-[calc(50%-2px)] h-[max(1.5rem,calc(100%-3rem))] w-4 -translate-y-1/2 select-none rounded outline-none transition-all focus:outline-none focus-visible:outline-none sm:opacity-0 sm:group-hover:opacity-100 ${
                isReorderLocked
                  ? "cursor-not-allowed text-zinc-200 opacity-40"
                  : `sm:cursor-grab active:cursor-grabbing ${
                      isDeleteConfirmHighlighted
                        ? "bg-red-100 text-red-500 hover:bg-red-100 hover:text-red-600 sm:opacity-100"
                        : `hover:bg-[#dbe5f3] hover:text-[#91a8ca] ${
                            isSelected ? "bg-[#dbe5f3] text-[#91a8ca] sm:opacity-100" : "text-zinc-400 sm:text-zinc-200"
                          }`
                    }`
              }`}
              title="更多操作"
              aria-label="更多操作"
            >
              <span className="pointer-events-none flex items-center justify-center text-[13px] font-bold sm:hidden">⋮</span>
              <span className="pointer-events-none absolute bottom-1 left-1/2 top-1 w-0.5 -translate-x-1/2 rounded bg-current hidden sm:block" />
            </button>
          )}
        </div>
      )}

      {/* Colored left bar showing a remote editor is active in this block */}
      {firstEditor && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-0.5"
          style={{ backgroundColor: firstEditor.color }}
        />
      )}

      {/* Remote editor name badge — floats above the block on the top-left */}
      {firstEditor && (
        <div
          className="absolute left-3 -top-3 z-10 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow"
          style={{ backgroundColor: firstEditor.color }}
        >
          {presenceEditors.map(e => (
            <span key={e.clientId}>{e.userName}</span>
          ))}
        </div>
      )}

      <CommentBubble
        comments={blockComments}
        assets={blockAssets}
        active={isCommentPanelActive || isAssetPanelActive}
        offsetY={commentBubbleOffsetY}
        mode={commentBubbleMode}
        width={commentBubbleWidth}
        blockLabel={commentBlockCaption?.label ?? ""}
        captionBody={commentBlockCaption?.body ?? ""}
        onCommentClick={handleCommentClick}
        onAssetClick={handleAssetClick}
        onHoverChange={setCommentBubbleHovered}
      />

      {/* Right-side action buttons — flex row, no overlap */}
      <div className={`${rightActionRowClass} ${charSelectorOpen ? "opacity-0 pointer-events-none" : ""}`}>
        {confirmTypeAction && (
          <span className="z-10 mr-1 flex items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm" data-script-confirmation="true">
            <span className="whitespace-nowrap text-[10px] text-zinc-400">
              {confirmTypeAction === "type"
                ? `确认修改所选 ${selectedCount} 行类型？`
                : `确认修改所选 ${selectedCount} 行文本状态？`}
            </span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const action = confirmTypeAction;
                onRequestLargeSelectionOperation(action, selectedCount, () => {
                  setConfirmTypeAction(null);
                  if (action === "type") onToggleType();
                  else onToggleLyric();
                });
              }}
              className="text-[10px] text-red-500 hover:text-red-700"
            >
              确认
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setConfirmTypeAction(null)}
              className="text-[10px] text-zinc-400 hover:text-zinc-600"
            >
              取消
            </button>
          </span>
        )}
        {canEditText && !isStage && !hasLyricConfig && (
          <button
            data-script-selection-action={selectedCount > 1 ? "true" : undefined}
            onClick={() => {
              if (selectedCount > 1) setConfirmTypeAction("lyric");
              else onToggleLyric();
            }}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-200 opacity-0 transition-opacity hover:text-zinc-400 group-hover:opacity-100"
          >
            {block.lyric ? "台词" : "歌词"}
          </button>
        )}
        {canEditText && (
          <button
            data-script-selection-action={selectedCount > 1 ? "true" : undefined}
            onClick={() => {
              if (selectedCount > 1) setConfirmTypeAction("type");
              else onToggleType();
            }}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-200 opacity-0 transition-opacity hover:text-zinc-400 group-hover:opacity-100"
          >
            {isStage ? "台词" : "舞台"}
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onAssetClick(); }}
          title="附件"
          className="rounded px-1.5 py-0.5 text-[11px] text-zinc-200 opacity-0 transition-opacity hover:text-zinc-400 group-hover:opacity-100"
        >
          附件
        </button>
        <button
          onClick={e => { e.stopPropagation(); onCommentClick(); }}
          title="评论"
          className={`rounded px-1.5 py-0.5 text-[11px] transition-opacity ${
            commentCount > 0
              ? "text-zinc-400 opacity-100 hover:text-zinc-600"
              : "text-zinc-200 opacity-0 hover:text-zinc-400 group-hover:opacity-100"
          }`}
        >
          {commentCount > 0 ? `${commentCount} 评` : "评论"}
        </button>
      </div>
      {displayScene && (
        <span className={readOnlySceneLabelClass}>
          <SceneLabel scene={displayScene} focused={isFocused} />
        </span>
      )}

      {isCompactTextLayout ? (
        <div
          className="grid grid-cols-[var(--compact-character-column-width)_1rem_minmax(0,1fr)] items-start gap-x-2 text-left sm:grid-cols-[var(--compact-character-column-width-wide)_1rem_minmax(0,1fr)]"
          style={charSelectorOpen ? COMPACT_TEXT_GRID_UNFOLDED_STYLE : COMPACT_TEXT_GRID_STYLE}
        >
          <div ref={compactCharacterColumnRef} className="col-start-1 row-start-1 min-w-0 pt-0.5">
            {(showCharacterSelector || hiddenCharacterCollapsed) && (
              <div className={hiddenCharacterCollapsed && !showCharacterSelector ? "opacity-0 transition-opacity group-hover:opacity-100" : undefined}>
                <BlockCharacterSelector
                  block={block}
                  characters={characters}
                  onChange={(ids) => { onUpdate({ characterIds: ids }); onCharacterChangeFocus?.(); }}
                  onAnnotationChange={(charId, ann) => onUpdate({ characterAnnotations: { ...block.characterAnnotations, [charId]: ann } })}
                  onForceShowCharacterNameChange={(force) => onUpdate({ forceShowCharacterName: force })}
                  onEditingChange={setCharSelectorOpen}
                  editRequestToken={charEditToken}
                  onArrowUp={onArrowUpFromChar}
                  onArrowDown={onArrowDownFromChar}
                  readOnly={!canEditText || isEditingLocked}
                  layoutMode={textLayoutMode}
                />
              </div>
            )}
            {!showCharacterSelector && !hiddenCharacterCollapsed && (
              <span aria-hidden className="block invisible text-sm font-bold leading-7 tracking-[0.12em]">
                无角色
              </span>
            )}
          </div>
          {block.characterIds.length > 0 && (hasStageComment || isFocused || isSelected || isCompactTextLayout) && (
            <BlockStageComment
              value={block.stageComment}
              onChange={(stageComment) => onUpdate({ stageComment })}
              showAddButton={showStageCommentAddButton}
              readOnly={!canEditText || isEditingLocked}
              stageDelimOpen={stageDelimOpen}
              stageDelimClose={stageDelimClose}
              layoutMode={textLayoutMode}
              placementClassName={showCompactStageCommentRow ? "col-start-3 row-start-1 self-start pt-[0.0625rem]" : stageCommentEditing ? "col-start-3 row-start-1 self-start" : "col-start-2 row-start-1 self-start justify-self-center"}
              onEditingChange={setStageCommentEditing}
              addButtonCenter
              alignAddButtonToLineAnchor={!showCompactStageCommentRow}
              addButtonRevealOnHover
              alignFirstLineToEnd={showCompactStageCommentRow}
              onOverflowBelowChange={setStageCommentOverflowBelow}
              lineAnchorCenter={compactCharacterColumnHeight > 0 ? compactCharacterLastLineCenter : undefined}
              lineAnchorRowHeight={compactCharacterColumnHeight || undefined}
              manualOffsetYPx={stageCommentManualOffsetYPx}
              getEditorWidth={measureStageCommentEditorWidth}
            />
          )}
          <div
            className={`col-start-3 min-w-0 ${showCompactStageCommentRow ? "row-start-2" : "row-start-1"}`}
            style={showCompactStageCommentRow
              ? stageCommentOverflowBelow > 0 ? { marginTop: stageCommentOverflowBelow } : undefined
              : compactContentFirstLineTop > 0 ? { marginTop: compactContentFirstLineTop } : undefined}
          >
            <div
              ref={refCallback}
              contentEditable={canEditText && !isScriptDragging && !isEditingLocked}
              suppressContentEditableWarning
              tabIndex={isEditingLocked ? -1 : undefined}
              onInput={handleInput}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
              onPaste={(e) => {
                if (!canEditText) {
                  e.preventDefault();
                  return;
                }
                e.preventDefault();
                const html = e.clipboardData.getData("text/html");
                const plain = e.clipboardData.getData("text/plain");
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) return;
                sel.deleteFromDocument();
                const range = sel.getRangeAt(0);
                if (html) {
                  const sanitized = sanitizePasteHtml(html);
                  const tmp = document.createElement("div");
                  tmp.innerHTML = sanitized;
                  const frag = document.createDocumentFragment();
                  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
                  const last = frag.lastChild;
                  range.insertNode(frag);
                  if (last) {
                    const r = document.createRange();
                    r.setStartAfter(last);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                  }
                } else {
                  const node = document.createTextNode(plain);
                  range.insertNode(node);
                  sel.collapseToEnd();
                }
                if (block.type !== "stage") applyInlineStageStyling(divRef.current!, stageDelimOpen, stageDelimClose);
                syncContent();
              }}
              data-placeholder={contentPlaceholder ?? "在此输入台词…"}
              className={`w-full min-h-[1.75rem] pl-1 outline-none text-base leading-7 break-words text-left ${isScriptDragging || isEditingLocked ? "caret-transparent" : ""} ${
                block.lyric ? "font-lyric font-bold text-zinc-700 uppercase" : "font-script text-zinc-700"
              }`}
            />
          </div>
        </div>
      ) : (
        <>
          {!isStage && showCharacterSelector && (
            <BlockCharacterSelector
              block={block}
              characters={characters}
              onChange={(ids) => { onUpdate({ characterIds: ids }); onCharacterChangeFocus?.(); }}
              onAnnotationChange={(charId, ann) => onUpdate({ characterAnnotations: { ...block.characterAnnotations, [charId]: ann } })}
              onForceShowCharacterNameChange={(force) => onUpdate({ forceShowCharacterName: force })}
              onEditingChange={setCharSelectorOpen}
              editRequestToken={charEditToken}
              onArrowUp={onArrowUpFromChar}
              onArrowDown={onArrowDownFromChar}
              readOnly={!canEditText || isEditingLocked}
              bottomGapClassName={characterBottomGapClassName}
            />
          )}

          {!isStage && block.characterIds.length > 0 && (hasStageComment || !effectiveHideCharSelector || isFocused || isSelected) && (
            <BlockStageComment
              value={block.stageComment}
              onChange={(stageComment) => onUpdate({ stageComment })}
              showAddButton={showStageCommentAddButton}
              topGap={showCharacterSelector ? "compact" : undefined}
              readOnly={!canEditText || isEditingLocked}
              stageDelimOpen={stageDelimOpen}
              stageDelimClose={stageDelimClose}
              placementClassName={stageCommentPlacementClassName}
              addButtonRevealOnHover
              zeroHeightAddButton
              getEditorWidth={measureStageCommentEditorWidth}
            />
          )}

          <div
        ref={refCallback}
        contentEditable={canEditText && !isScriptDragging && !isEditingLocked}
        suppressContentEditableWarning
        tabIndex={isEditingLocked ? -1 : undefined}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onPaste={(e) => {
          if (!canEditText) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          const plain = e.clipboardData.getData("text/plain");
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          sel.deleteFromDocument();
          const range = sel.getRangeAt(0);
          if (html) {
            const sanitized = sanitizePasteHtml(html);
            const tmp = document.createElement("div");
            tmp.innerHTML = sanitized;
            const frag = document.createDocumentFragment();
            while (tmp.firstChild) frag.appendChild(tmp.firstChild);
            const last = frag.lastChild;
            range.insertNode(frag);
            if (last) {
              const r = document.createRange();
              r.setStartAfter(last);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            }
          } else {
            const node = document.createTextNode(plain);
            range.insertNode(node);
            sel.collapseToEnd();
          }
          if (block.type !== "stage") applyInlineStageStyling(divRef.current!, stageDelimOpen, stageDelimClose);
          syncContent();
        }}
        data-placeholder={contentPlaceholder ?? (isStage ? "舞台提示…" : "在此输入台词…")}
        className={`w-full min-h-[1.75rem] ${isStage ? "pl-1" : ""} outline-none text-base leading-7 break-words ${isScriptDragging || isEditingLocked ? "caret-transparent" : ""} ${
          isStage ? "font-stage italic text-zinc-400 text-left" :
          block.lyric ? "font-lyric font-bold text-zinc-700 text-center uppercase" :
          "font-script text-zinc-700 text-center"
        }`}
          />
        </>
      )}

      {hasBlockTags && (
        <div ref={blockTagsRef} className="relative mt-0.5 pb-1">
          <div className="flex flex-wrap items-center gap-1">
            {tagGroups.map(group => {
              const tagVal = (blockTagValues ?? []).find(t => t.groupId === group.id);
              const selectedOpt = group.type === "exclusive"
                ? group.options.find(o => o.id === (tagVal?.optionId ?? group.defaultOptionId))
                : null;
              const isDefault = group.type === "exclusive" && !tagVal?.optionId;
              const rangeVal = group.type === "range" ? (tagVal?.value ?? group.rangeDefault) : null;
              return (
                <span
                  key={group.id}
                  onClick={() => { if (canEditMetadata) setTagPickerOpen(v => !v); }}
                  className={`${canEditMetadata ? "cursor-pointer" : "cursor-default"} rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity select-none ${isDefault ? "opacity-35" : ""}`}
                  style={selectedOpt
                    ? { backgroundColor: selectedOpt.color + "20", color: selectedOpt.color }
                    : { backgroundColor: "#f4f4f5", color: "#71717a" }
                  }
                >
                  {group.type === "exclusive"
                    ? (selectedOpt?.label ?? group.name)
                    : `${group.name}${rangeVal !== null && rangeVal !== undefined ? `: ${rangeVal}` : ""}`
                  }
                </span>
              );
            })}
          </div>
          {tagPickerOpen && (
            <TagPicker
              tagGroups={tagGroups}
              blockTagValues={blockTagValues ?? []}
              onTagChange={(groupId, optionId, value, del) => { onTagChange?.(groupId, optionId, value, del); }}
              onCopy={() => onTagCopyClick?.()}
              onPaste={() => onTagPasteClick?.()}
              onClose={() => setTagPickerOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
