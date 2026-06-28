"use client";

import React from "react";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, BlockType, Character, Scene, ScriptState, ScriptConfig, ScriptTextLayoutMode, PageLayout } from "@/lib/script-types";
import type { TagGroup, BlockTagValue, Version, VersionStatus, SceneDetail } from "@/lib/db";
import TagGroupEditor from "@/components/TagGroupEditor";
import VersionSelector from "@/components/VersionSelector";
import BlockMountAssets from "@/components/assets/BlockMountAssets";
import MountPointAssets from "@/components/assets/MountPointAssets";
import DurationInput from "@/components/DurationInput";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { diffState, type TagEntry } from "@/lib/script-ops";
import { COMPACT_TEXT_SIDE_WIDTH_REM, PAGE_CONFIGS, updateEstimatedPageMap } from "@/lib/script-page";
import type { EstimatedPageMapCache, PageConfig } from "@/lib/script-page";
import SmartTextarea from "@/components/SmartTextarea";
import SmartText from "@/components/SmartText";
import CommentAssetPicker, { type PendingAsset } from "@/components/assets/CommentAssetPicker";
import { formatDuration, parseDuration } from "@/lib/duration";
import { toAlphaLabel, withGeneratedSceneNumbers } from "@/lib/script-generated-labels";
import { isMarkerBlock, shouldInsertEmptyBlockAfterMarker } from "@/lib/script-marker-blocks";
import { markerOwnershipRange, updateMarkerOwnership, type MarkerOwnershipDirty, type MarkerOwnershipRange } from "@/lib/script-marker-ownership-cache";
import {
  FIXED_INITIAL_CHAPTER_BLOCK_ID,
  FIXED_INITIAL_CHAPTER_NAME,
} from "@/lib/script-fixed-markers";

let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;
const LARGE_SELECTION_BLOCK_THRESHOLD = 500;
const TOOLBAR_FOLD_HYSTERESIS_PX = 16;
const COMPACT_STAGE_COMMENT_EDITOR_WIDTH_RATIO = 0.8;
const LINE_INDEX_GUTTER_OFFSET_REM = 1.25;
const LINE_INDEX_CONTROL_MIN_WIDTH_REM = 0.5;
const SCRIPT_TOC_CENTER_EVENT = "script-toc-center-active";
const SCRIPT_EDITOR_MAX_WIDTH_PX = 768; // Tailwind max-w-3xl
const SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM = 14;
const SCRIPT_TOC_RAIL_COMPACT_WIDTH_REM = 4;
const SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM = 2.5;
const SCRIPT_TOC_RAIL_NUMBER_SLOT_REM = 0.5; // Minimum number slot width; widened when longer scene numbers need it.
const SCRIPT_TOC_RAIL_LABEL_GAP_REM = 1.5;
const SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM = 2; // Right-edge gap between chapter numbers and scene numbers.
const SCRIPT_TOC_RAIL_GAP_REM = -1;
const SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM = 18;
const SCRIPT_SCENE_DETAIL_MODE_BUTTON_EXTRA_INSET_REM = 0.25;
const SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM = 2.5;
const SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX = 80;
const REHEARSAL_MARKER_ROW_BASE_HEIGHT_REM = 1.75;
const REHEARSAL_MARKER_ROW_HEIGHT_SCALE = 0;
const REHEARSAL_MARKER_ROW_MIN_HEIGHT_PX = 1;
const REHEARSAL_MARKER_FLOAT_LEFT_OFFSET_REM = -0.75;
const MARKER_CONTROL_DELETE_LEFT_PX = 0;
const MARKER_CONTROL_BAR_LEFT_PX = 12;
const MARKER_CONTROL_TRIANGLE_LEFT_PX = MARKER_CONTROL_BAR_LEFT_PX * 2 - MARKER_CONTROL_DELETE_LEFT_PX + 1;
const MARKER_CONTROL_TRIANGLE_TOP_OFFSET_PX = 0.6;
let scriptTocMeasureElement: HTMLSpanElement | null = null;
let scriptTocMeasureCache: {
  scenes: Scene[];
  layoutKey: string;
  railWidthPx: number;
  chapterNumberSlotWidthPx: number;
  sceneNumberSlotWidthPx: number;
} | null = null;

function measureScriptTocTextWidth(
  text: string,
  {
    fontSizePx,
    fontWeight,
    letterSpacingPx = 0,
  }: {
    fontSizePx: number;
    fontWeight: number;
    letterSpacingPx?: number;
  }
): number {
  scriptTocMeasureElement ??= document.createElement("span");
  const el = scriptTocMeasureElement;
  if (!el.isConnected) document.body.appendChild(el);
  Object.assign(el.style, {
    position: "fixed",
    top: "-9999px",
    left: "-9999px",
    visibility: "hidden",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    fontFamily: window.getComputedStyle(document.body).fontFamily,
    fontSize: `${fontSizePx}px`,
    fontWeight: String(fontWeight),
    letterSpacing: `${letterSpacingPx}px`,
  });
  el.textContent = text;
  return el.getBoundingClientRect().width;
}

function measureScriptTocRailLayout(scenes: Scene[], rootFontSizePx: number): {
  railWidthPx: number;
  chapterNumberSlotWidthPx: number;
  sceneNumberSlotWidthPx: number;
} {
  const maxWidthPx = SCRIPT_CONTENTS_MENU_MAX_WIDTH_REM * rootFontSizePx;
  const minimumNumberSlotWidthPx = SCRIPT_TOC_RAIL_NUMBER_SLOT_REM * rootFontSizePx;
  const gapPx = SCRIPT_TOC_RAIL_LABEL_GAP_REM * rootFontSizePx;
  const subSceneIndentPx = SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM * rootFontSizePx;
  const scrollbarWidthPx = SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM * rootFontSizePx;
  const minWidthPx = (SCRIPT_TOC_RAIL_COMPACT_WIDTH_REM + SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM) * rootFontSizePx;
  const layoutKey = [
    rootFontSizePx,
    maxWidthPx,
    minimumNumberSlotWidthPx,
    gapPx,
    subSceneIndentPx,
    scrollbarWidthPx,
    minWidthPx,
  ].join("|");
  if (scriptTocMeasureCache?.scenes === scenes && scriptTocMeasureCache.layoutKey === layoutKey) {
    return {
      railWidthPx: scriptTocMeasureCache.railWidthPx,
      chapterNumberSlotWidthPx: scriptTocMeasureCache.chapterNumberSlotWidthPx,
      sceneNumberSlotWidthPx: scriptTocMeasureCache.sceneNumberSlotWidthPx,
    };
  }
  if (typeof document === "undefined" || scenes.length === 0) {
    return {
      railWidthPx: maxWidthPx,
      chapterNumberSlotWidthPx: minimumNumberSlotWidthPx,
      sceneNumberSlotWidthPx: minimumNumberSlotWidthPx,
    };
  }

  const horizontalPaddingPx = 2 * rootFontSizePx;
  let requiredWidthPx = 0;
  const sceneNameWidths: Array<{ scene: Scene; nameWidthPx: number }> = [];
  let chapterNumberSlotWidthPx = minimumNumberSlotWidthPx;
  let sceneNumberSlotWidthPx = minimumNumberSlotWidthPx;

  const numberFontSizePx = 0.75 * rootFontSizePx;
  const numberTrackingPx = 0.05 * numberFontSizePx;

  for (const scene of scenes) {
    const numberText = scene.number || "—";
    const measuredNumberWidthPx = measureScriptTocTextWidth(numberText, {
      fontSizePx: numberFontSizePx,
      fontWeight: 700,
      letterSpacingPx: numberTrackingPx,
    });
    if (scene.parentId === null) {
      chapterNumberSlotWidthPx = Math.max(chapterNumberSlotWidthPx, measuredNumberWidthPx);
    } else {
      sceneNumberSlotWidthPx = Math.max(sceneNumberSlotWidthPx, measuredNumberWidthPx);
    }
    const nameWidthPx = scene.name
      ? measureScriptTocTextWidth(scene.name, {
        fontSizePx: scene.parentId === null ? 0.875 * rootFontSizePx : 0.75 * rootFontSizePx,
        fontWeight: scene.parentId === null ? 500 : 400,
      })
      : 32;
    sceneNameWidths.push({ scene, nameWidthPx });
  }

  for (const { scene, nameWidthPx } of sceneNameWidths) {
    const numberSlotWidthPx = scene.parentId === null ? chapterNumberSlotWidthPx : sceneNumberSlotWidthPx;
    requiredWidthPx = Math.max(
      requiredWidthPx,
      horizontalPaddingPx + (scene.parentId === null ? 0 : subSceneIndentPx) + numberSlotWidthPx + gapPx + nameWidthPx + scrollbarWidthPx
    );
  }

  const railWidthPx = Math.ceil(Math.min(maxWidthPx, Math.max(minWidthPx, requiredWidthPx)));
  scriptTocMeasureCache = {
    scenes,
    layoutKey,
    railWidthPx,
    chapterNumberSlotWidthPx,
    sceneNumberSlotWidthPx,
  };
  return { railWidthPx, chapterNumberSlotWidthPx, sceneNumberSlotWidthPx };
}

/**
 * Computes the `lyric` flag a block should have based on its tags and the
 * production's lyricSplitAfterOptionId rules (OR logic across groups).
 *
 * Returns null if none of the block's tag groups has a lyric-split rule —
 * meaning the caller should leave block.lyric unchanged.
 */
function computeLyricFromTags(tags: BlockTagValue[], tagGroups: TagGroup[]): boolean | null {
  const lyricGroups = tagGroups.filter(g => g.lyricSplitAfterOptionId);
  if (lyricGroups.length === 0) return null;
  for (const tag of tags) {
    if (!tag.optionId) continue;
    const group = lyricGroups.find(g => g.id === tag.groupId);
    if (!group) continue;
    const splitOpt = group.options.find(o => o.id === group.lyricSplitAfterOptionId);
    const selOpt = group.options.find(o => o.id === tag.optionId);
    if (!splitOpt || !selOpt) continue;
    if (selOpt.sortOrder <= splitOpt.sortOrder) return true;
  }
  // Has lyric groups, but no tag qualifies → false
  const blockHasLyricGroup = tags.some(t => lyricGroups.some(g => g.id === t.groupId));
  return blockHasLyricGroup ? false : null;
}

type LargeSelectionOperation = "delete" | "move" | "type" | "lyric";
type PendingLargeSelectionConfirmation = {
  operation: LargeSelectionOperation;
  count: number;
  onConfirm: () => void;
  onCancel?: () => void;
};
type PendingStageDelimiterChange = {
  open: string;
  close: string;
};
type EmptyScriptCleanupTarget = {
  id: string;
  key: string;
  label: string;
  kind: "chapter" | "scene" | "rehearsal";
  parentKey: string | null;
  dividerKey: string;
  chapterKey: string;
  disabledReason?: string;
};
type EmptyScriptCleanupAnalysis = {
  targets: EmptyScriptCleanupTarget[];
  hasEmptyTextBlock: boolean;
};
type PendingAggregateFocusPrompt = {
  characterId: string;
  aggregateIds: string[];
  selectedIds: Set<string>;
};
type SceneMetaFields = Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">;
type MarkerDetailDeleteBlockedKind = "chapter" | "scene";

function hasTextValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonNameSceneDetails(
  detail?: Partial<SceneMetaFields> | null,
  markerMeta?: Partial<SceneMetaFields> | null
): boolean {
  return (
    hasTextValue(markerMeta?.synopsis) ||
    hasTextValue(markerMeta?.actionLine) ||
    hasTextValue(markerMeta?.music) ||
    hasTextValue(markerMeta?.stageNotes) ||
    hasTextValue(markerMeta?.expectedDuration) ||
    hasTextValue(detail?.synopsis) ||
    hasTextValue(detail?.actionLine) ||
    hasTextValue(detail?.music) ||
    hasTextValue(detail?.stageNotes) ||
    hasTextValue(detail?.expectedDuration)
  );
}

function sceneDetailDeleteBlockedMessage(kind: MarkerDetailDeleteBlockedKind): string {
  const label = kind === "chapter" ? "章节" : "段落";
  return `${label}详情不为空，不可删除当前${label}块。\n如需删除，请确保详情内容（包括${label}名称）均已转移或清空。`;
}

function markerBlockDramaturgyDeleteBlockedKind(block: Block, detail?: SceneDetail | null): MarkerDetailDeleteBlockedKind | null {
  if (block.type !== "chapter_marker" && block.type !== "scene_marker") return null;
  const markerMeta = block.markerMeta ?? {};
  const hasDetails =
    hasTextValue(markerMeta.name) ||
    hasTextValue(markerMeta.synopsis) ||
    hasTextValue(markerMeta.actionLine) ||
    hasTextValue(markerMeta.music) ||
    hasTextValue(markerMeta.stageNotes) ||
    hasTextValue(markerMeta.expectedDuration) ||
    hasTextValue(detail?.name) ||
    hasTextValue(detail?.synopsis) ||
    hasTextValue(detail?.actionLine) ||
    hasTextValue(detail?.music) ||
    hasTextValue(detail?.stageNotes) ||
    hasTextValue(detail?.expectedDuration);
  if (!hasDetails) return null;
  return block.type === "chapter_marker" ? "chapter" : "scene";
}

function largeSelectionOperationMessage(operation: LargeSelectionOperation, count: number) {
  const actionLabel =
    operation === "delete" ? "删除" :
    operation === "move" ? "移动" :
    operation === "type" ? "更改" :
    "更改";
  const objectLabel =
    operation === "type" ? `${count} 行的类型` :
    operation === "lyric" ? `${count} 行的文本状态` :
    `${count} 行`;
  return `${actionLabel} ${objectLabel}可能导致页面卡顿，建议分批次进行。\n是否确认继续操作？`;
}

const Chevron = () => (
  <svg className="h-3 w-3 opacity-50" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FoldTriangle = ({ open }: { open: boolean }) => (
  <span
    aria-hidden
    className={`h-0 w-0 border-x-[3px] border-x-transparent ${
      open ? "border-b-[4px] border-b-current" : "border-t-[4px] border-t-current"
    }`}
  />
);

// ── Display settings (cookie-persisted) ───────────────────────────────────────
type DisplaySettings = {
  pageBreaks: boolean;
  lineNumbers: boolean;
  rehearsalMarks: boolean;
  blockTags: boolean;
  rehearsalMode: boolean;
  rehearsalBlockScenes: boolean;
};
const DEFAULT_DISPLAY: DisplaySettings = {
  pageBreaks: true,
  lineNumbers: true,
  rehearsalMarks: true,
  blockTags: true,
  rehearsalMode: false,
  rehearsalBlockScenes: true,
};
const DISPLAY_COOKIE = "script_display";
const CHARACTER_FOCUS_STORAGE_PREFIX = "script_character_focus";
function readDisplayCookie(): DisplaySettings {
  try {
    const m = document.cookie.match(/(?:^|;\s*)script_display=([^;]*)/);
    if (m) return { ...DEFAULT_DISPLAY, ...JSON.parse(decodeURIComponent(m[1])) };
  } catch { /* ignore */ }
  return DEFAULT_DISPLAY;
}
function writeDisplayCookie(s: DisplaySettings) {
  document.cookie = `${DISPLAY_COOKIE}=${encodeURIComponent(JSON.stringify(s))}; path=/; max-age=31536000; SameSite=Lax`;
}

function characterFocusStorageKey(scriptId: string): string {
  return `${CHARACTER_FOCUS_STORAGE_PREFIX}:${scriptId}:${getOrCreateClientId()}`;
}

function readStoredCharacterFocus(scriptId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(characterFocusStorageKey(scriptId));
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStoredCharacterFocus(scriptId: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    const key = characterFocusStorageKey(scriptId);
    if (ids.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch { /* ignore storage failures */ }
}

function ModeSwitch({
  active,
  activeClassName = "bg-teal-600",
}: {
  active: boolean;
  activeClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={`relative h-4 w-7 rounded-full transition-colors ${
        active ? activeClassName : "bg-zinc-200"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
          active ? "translate-x-3" : "translate-x-0"
        }`}
      />
    </span>
  );
}

const makeBlock = (content = "", characterIds: string[] = [], type: BlockType = "dialogue"): Block => ({
  id: uid(),
  type,
  content,
  characterIds,
  characterAnnotations: {},
  lyric: false,
  sceneId: null,
  rehearsalMark: null,
  forceShowCharacterName: false,
});

const isTextBlock = (block: Block) => !isMarkerBlock(block);

const makeMarkerBlock = (
  type: Extract<BlockType, "chapter_marker" | "scene_marker" | "rehearsal_marker">,
  fields: Pick<Partial<Block>, "sceneId" | "rehearsalMark"> = {}
): Block => ({
  ...makeBlock("", [], type),
  sceneId: fields.sceneId ?? null,
  rehearsalMark: fields.rehearsalMark ?? null,
});

const isBlockEmptyForDelete = (block: Block) =>
  block.content.trim() === "" &&
  !(block.stageComment ?? "").trim() &&
  block.characterIds.length === 0 &&
  Object.values(block.characterAnnotations).every((ann) => ann.trim() === "");

const isEmptyTextBlock = (block: Block) => isTextBlock(block) && isBlockEmptyForDelete(block);

// ─── contenteditable helpers ─────────────────────────────────────────────────

function getTextBeforeCursor(div: HTMLDivElement): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const r = document.createRange();
  r.setStart(div, 0);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const tmp = document.createElement("div");
  tmp.appendChild(r.cloneContents());
  return tmp.innerText;
}

function getTextAfterCursor(div: HTMLDivElement): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const r = document.createRange();
  r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  r.setEnd(div, div.childNodes.length);
  const tmp = document.createElement("div");
  tmp.appendChild(r.cloneContents());
  return tmp.innerText;
}

function isAtStart(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.setStart(div, 0);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

function isOnFirstLine(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  // Fallback for browsers that return a zero rect for collapsed ranges
  if (rect.height === 0) return !getTextBeforeCursor(div).includes("\n");
  return rect.top <= div.getBoundingClientRect().top + rect.height;
}

function isOnLastLine(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.height === 0) return !getTextAfterCursor(div).includes("\n");
  return rect.bottom >= div.getBoundingClientRect().bottom - rect.height;
}

function getHtmlSplit(div: HTMLDivElement): { before: string; after: string } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return { before: div.innerHTML, after: "" };
  const range = sel.getRangeAt(0);
  const t1 = document.createElement("div");
  const r1 = document.createRange();
  r1.setStart(div, 0);
  r1.setEnd(range.startContainer, range.startOffset);
  t1.appendChild(r1.cloneContents());
  const t2 = document.createElement("div");
  const r2 = document.createRange();
  r2.setStart(range.endContainer, range.endOffset);
  r2.setEnd(div, div.childNodes.length);
  t2.appendChild(r2.cloneContents());
  return { before: t1.innerHTML, after: t2.innerHTML };
}

function setCursorAtStart(div: HTMLDivElement) {
  const r = document.createRange();
  r.setStart(div, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function setCursorAtEnd(div: HTMLDivElement) {
  const r = document.createRange();
  r.selectNodeContents(div);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function setCursorAtTextOffset(div: HTMLDivElement, target: number) {
  // Walk both text nodes and <br> elements. <br> counts as 1 character (same
  // as the \n it represents in innerText / mdToHtml output).
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR")
        return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  const sel = window.getSelection();
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.ELEMENT_NODE) {
      // BR element: counts as 1 character
      if (offset + 1 > target) {
        // target <= offset: the position is before this BR.
        // Place the cursor right before the BR element.
        const r = document.createRange();
        r.setStartBefore(node);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
      offset += 1;
      if (offset === target) {
        // Position right after the BR (= start of the next line)
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
    } else {
      const textNode = node as Text;
      if (offset + textNode.length >= target) {
        const r = document.createRange();
        r.setStart(textNode, target - offset);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
      offset += textNode.length;
    }
  }
  setCursorAtEnd(div);
}

function getEditableElementForRange(range: Range): HTMLElement | null {
  let node: Node | null = range.commonAncestorContainer;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).isContentEditable) {
      return node as HTMLElement;
    }
    node = node.parentNode;
  }
  return null;
}

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  const node = target instanceof Node ? target : null;
  return node instanceof HTMLElement
    ? node
    : node?.parentElement ?? null;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return !!element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
}

function isFormEditingTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  return !!element?.closest("input, textarea, select");
}

function getTextLength(html: string): number {
  if (!html) return 0;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.innerText.length;
}

function sanitizePasteNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(sanitizePasteNode).join("");
  switch (tag) {
    case "b": case "strong": return `<b>${inner}</b>`;
    case "u": return `<u>${inner}</u>`;
    case "br": return "<br>";
    case "span":
      if (el.hasAttribute("data-stage-inline"))
        return `<span data-stage-inline="" style="font-family:var(--font-stage);font-style:italic;color:#a1a1aa">${inner}</span>`;
      return inner;
    case "p": case "div": case "li":
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return inner ? inner + "<br>" : "";
    default: return inner;
  }
}

function sanitizePasteHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return Array.from(tmp.childNodes).map(sanitizePasteNode).join("").replace(/<br>$/, "");
}

// ─── Markdown ↔ HTML conversion ───────────────────────────────────────────────
// Storage format: plain text with **bold** and __underline__ markers.
// Stage-inline cues are stored as plain bracketed text — no span markup.

function nodeToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(nodeToMd).join("");
  switch (tag) {
    case "b": case "strong": return `**${inner}**`;
    case "u": return `__${inner}__`;
    case "br": return "\n";
    case "span": return inner; // strip all spans (including stage-inline); brackets remain
    case "p": case "div": case "li":
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return inner ? inner + "\n" : "";
    default: return inner;
  }
}

function htmlToMd(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return Array.from(tmp.childNodes).map(nodeToMd).join("").replace(/\n$/, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stagePairRegex(delimOpen = "（", delimClose = "）"): RegExp {
  return new RegExp(
    `${escapeRegex(delimOpen)}[^${escapeRegex(delimClose)}\n]*${escapeRegex(delimClose)}`,
    "g"
  );
}

function mdToHtml(md: string, delimOpen?: string, delimClose?: string): string {
  let s = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (delimOpen !== undefined && delimClose !== undefined) {
    const pairRegex = stagePairRegex(delimOpen, delimClose);
    s = s.replace(pairRegex, (match) =>
      `<span data-stage-inline="" style="font-family:var(--font-stage);font-style:italic;color:#a1a1aa">${match}</span>`
    );
  }
  // Collapse 3+ consecutive * or _ to exactly 2, so nested markers from old
  // double-bold bugs render as a single level instead of mis-parsing.
  s = s.replace(/\*{3,}/g, "**").replace(/_{3,}/g, "__");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => `<b>${inner}</b>`);
  s = s.replace(/__([\s\S]+?)__/g, (_, inner) => `<u>${inner}</u>`);
  s = s.replace(/\n/g, "<br>");
  return s;
}

function replaceInlineStageDelimiters(content: string, fromOpen: string, fromClose: string, toOpen: string, toClose: string): string {
  const pairRegex = stagePairRegex(fromOpen, fromClose);
  return content.replace(pairRegex, (match) =>
    `${toOpen}${match.slice(fromOpen.length, match.length - fromClose.length)}${toClose}`
  );
}

// Properly toggle a bold/underline tag on the given range:
// - If the common ancestor of the range is inside ONE existing tag element → unwrap it.
// - Otherwise → flatten any nested tags inside the range, wrap the whole range,
//   and restore the selection over the new wrapper so the next toggle works immediately.
function toggleInlineTag(range: Range, tag: "b" | "u"): void {
  // commonAncestorContainer is inside the <b>/<u> whenever the selection is fully
  // within it — even when start/end containers land at the element boundary in the parent.
  const ancestor = range.commonAncestorContainer;
  const ancestorEl = ancestor.nodeType === Node.TEXT_NODE
    ? ancestor.parentElement
    : (ancestor as HTMLElement);
  const existingTag = ancestorEl?.closest(tag) ?? null;
  const sel = window.getSelection();

  // Helper: restore selection spanning first..last nodes.
  // Anchors to child nodes (text nodes or elements), NOT to the wrapper element,
  // so the range stays valid even if the wrapper is later removed by another toggle.
  const restoreSelection = (first: ChildNode, last: ChildNode) => {
    if (!sel) return;
    try {
      const r = document.createRange();
      r.setStart(first, 0);
      r.setEnd(
        last,
        last.nodeType === Node.TEXT_NODE
          ? (last.textContent?.length ?? 0)
          : (last as Element).childNodes.length
      );
      sel.removeAllRanges();
      sel.addRange(r);
    } catch { /* ignore stale-range errors */ }
  };

  if (existingTag) {
    const first = existingTag.firstChild;
    const last  = existingTag.lastChild;
    existingTag.replaceWith(...Array.from(existingTag.childNodes));
    if (first && last) restoreSelection(first, last);
    return;
  }

  const frag = range.extractContents();
  frag.querySelectorAll(tag).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
  const wrapper = document.createElement(tag);
  wrapper.appendChild(frag);
  range.insertNode(wrapper);
  if (wrapper.firstChild && wrapper.lastChild)
    restoreSelection(wrapper.firstChild, wrapper.lastChild);
}

function wrapSelectionAsInlineStageCue(
  range: Range,
  delimOpen: string,
  delimClose: string,
): void {
  const frag = range.extractContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag.cloneNode(true));
  const selectedMd = htmlToMd(tmp.innerHTML);
  if (selectedMd.includes("\n")) {
    const wrappedMd = selectedMd
      .split("\n")
      .map((line) => line ? `${delimOpen}${line}${delimClose}` : line)
      .join("\n");
    const html = mdToHtml(wrappedMd, delimOpen, delimClose);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const replacement = document.createDocumentFragment();
    while (wrapper.firstChild) replacement.appendChild(wrapper.firstChild);
    const last = replacement.lastChild;
    range.insertNode(replacement);

    const sel = window.getSelection();
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
    return;
  }

  const span = document.createElement("span");
  span.setAttribute("data-stage-inline", "");
  span.style.fontFamily = "var(--font-stage)";
  span.style.fontStyle = "italic";
  span.style.color = "#a1a1aa";
  span.appendChild(document.createTextNode(delimOpen));
  span.appendChild(frag);
  span.appendChild(document.createTextNode(delimClose));
  range.insertNode(span);

  const sel = window.getSelection();
  const after = document.createRange();
  after.setStartAfter(span);
  after.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(after);
}

function applyInlineStageStyling(div: HTMLDivElement, delimOpen = "（", delimClose = "）") {
  const sel = window.getSelection();
  let savedOffset: number | null = null;
  if (sel && sel.rangeCount && sel.isCollapsed && div.contains(sel.anchorNode)) {
    savedOffset = getTextBeforeCursor(div).length;
  }

  const isStageSpan = (el: Element) =>
    el.hasAttribute("data-stage-inline");

  const validStageText = (text: string) =>
    text.startsWith(delimOpen) &&
    text.endsWith(delimClose) &&
    text.length >= delimOpen.length + delimClose.length;

  // Remove spans whose content no longer forms a valid pair
  div.querySelectorAll("span[data-stage-inline]").forEach((span) => {
    if (!validStageText(span.textContent ?? "")) {
      const parent = span.parentNode!;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  div.normalize();

  // Wrap new delimiter patterns in text nodes outside existing spans
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node;
  while ((node = walker.nextNode())) {
    let el: Node | null = (node as Text).parentNode;
    let inside = false;
    while (el && el !== div) {
      if (el instanceof Element && isStageSpan(el)) { inside = true; break; }
      el = el.parentNode;
    }
    if (!inside) textNodes.push(node as Text);
  }

  const pairRegex = stagePairRegex(delimOpen, delimClose);

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const matches: { start: number; end: number }[] = [];
    let m;
    pairRegex.lastIndex = 0;
    while ((m = pairRegex.exec(text)) !== null) matches.push({ start: m.index, end: m.index + m[0].length });
    if (!matches.length) continue;

    const parent = textNode.parentNode!;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const { start, end } of matches) {
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const span = document.createElement("span");
      span.setAttribute("data-stage-inline", "");
      span.style.fontFamily = "var(--font-stage)";
      span.style.fontStyle = "italic";
      span.style.color = "#a1a1aa";
      span.textContent = text.slice(start, end);
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, textNode);
  }

  if (savedOffset !== null) {
    setCursorAtTextOffset(div, savedOffset);
    // If cursor landed at the end of a stage-inline span, push it outside
    const s = window.getSelection();
    if (s && s.rangeCount && s.isCollapsed) {
      const r = s.getRangeAt(0);
      let el: Node | null = r.startContainer;
      while (el && el !== div) {
        if (el instanceof HTMLSpanElement && isStageSpan(el)) {
          const endR = document.createRange();
          endR.selectNodeContents(el);
          endR.collapse(false);
          if (r.compareBoundaryPoints(Range.START_TO_END, endR) >= 0) {
            const after = document.createRange();
            after.setStartAfter(el);
            after.collapse(true);
            s.removeAllRanges();
            s.addRange(after);
          }
          break;
        }
        el = el.parentNode;
      }
    }
  }
}

// ─── TableOfContents ──────────────────────────────────────────────────────────

function buildOrderedTocScenes(scenes: Scene[], blocks: Block[]): Scene[] {
  const usesMarkerBlocks = blocks.some(isMarkerBlock);
  const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter((id): id is string => id !== null));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const usedOrdered: Scene[] = [];
  const usedOrderedIds = new Set<string>();
  for (const b of blocks) {
    if (b.sceneId) {
      const scene = sceneById.get(b.sceneId);
      if (scene && !usedOrderedIds.has(scene.id)) {
        usedOrderedIds.add(scene.id);
        usedOrdered.push(scene);
      }
    }
  }
  if (usedOrdered.length === 0 && usedSceneIds.size === 0) return [];
  if (usesMarkerBlocks) return usedOrdered;

  const orderedScenes: Scene[] = [];
  const orderedSceneIds = new Set<string>();
  const pushOrderedScene = (scene: Scene) => {
    if (orderedSceneIds.has(scene.id)) return;
    orderedSceneIds.add(scene.id);
    orderedScenes.push(scene);
  };

  for (let i = 0; i < usedOrdered.length; i++) {
    const prevIdx = i === 0 ? -1 : scenes.findIndex((s) => s.id === usedOrdered[i - 1].id);
    const currIdx = scenes.findIndex((s) => s.id === usedOrdered[i].id);
    for (let j = prevIdx + 1; j < currIdx; j++) {
      if (!usedSceneIds.has(scenes[j].id)) pushOrderedScene(scenes[j]);
    }
    pushOrderedScene(usedOrdered[i]);
  }

  const lastIdx = usedOrdered.length
    ? scenes.findIndex((s) => s.id === usedOrdered[usedOrdered.length - 1].id)
    : -1;
  for (let j = lastIdx + 1; j < scenes.length; j++) {
    if (!usedSceneIds.has(scenes[j].id)) pushOrderedScene(scenes[j]);
  }

  return orderedScenes;
}

function toSceneDetail(scene: Scene): SceneDetail {
  return {
    ...scene,
    synopsis: "",
    actionLine: "",
    music: "",
    stageNotes: "",
    expectedDuration: "",
  };
}

function syncSceneDetailsWithScenes(details: SceneDetail[], scenes: Scene[]): SceneDetail[] {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const next = scenes.map((scene) => ({ ...(detailById.get(scene.id) ?? toSceneDetail(scene)), ...scene }));
  return sameSceneDetails(next, details) ? details : next;
}

function TableOfContents({
  scenes,
  blocks,
  onScrollToScene,
  activeSceneId,
  placement = "inline",
  chapterNumberSlotWidthPx,
  sceneNumberSlotWidthPx,
}: {
  scenes: Scene[];
  blocks: Block[];
  onScrollToScene?: (sceneId: string) => void;
  activeSceneId?: string | null;
  placement?: "inline" | "rail" | "rail-compact";
  chapterNumberSlotWidthPx?: number;
  sceneNumberSlotWidthPx?: number;
}) {
  const isRailPlacement = placement !== "inline";
  const isCompactRail = placement === "rail-compact";
  const orderedScenes = useMemo(() => buildOrderedTocScenes(scenes, blocks), [scenes, blocks]);
  const navRef = useRef<HTMLElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const didInitialCenterRef = useRef(false);
  const centerFrameRef = useRef<number | null>(null);
  const centerActiveItem = useCallback(() => {
    const nav = navRef.current;
    const item = activeItemRef.current;
    if (!nav || !item) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    nav.scrollTop += itemRect.top + itemRect.height / 2 - (navRect.top + nav.clientHeight / 2);
  }, []);
  const centerActiveItemSoon = useCallback(() => {
    if (centerFrameRef.current !== null) cancelAnimationFrame(centerFrameRef.current);
    centerFrameRef.current = requestAnimationFrame(() => {
      centerFrameRef.current = null;
      centerActiveItem();
    });
  }, [centerActiveItem]);

  useEffect(() => {
    if (!isRailPlacement || !activeSceneId || didInitialCenterRef.current) return;
    didInitialCenterRef.current = true;
    centerActiveItem();
  }, [activeSceneId, centerActiveItem, isRailPlacement]);

  useEffect(() => {
    if (!isRailPlacement) return;
    window.addEventListener(SCRIPT_TOC_CENTER_EVENT, centerActiveItemSoon);
    return () => {
      window.removeEventListener(SCRIPT_TOC_CENTER_EVENT, centerActiveItemSoon);
      if (centerFrameRef.current !== null) cancelAnimationFrame(centerFrameRef.current);
    };
  }, [centerActiveItemSoon, isRailPlacement]);

  if (orderedScenes.length === 0) return null;

  const scrollTo = (sceneId: string) => {
    if (onScrollToScene) { onScrollToScene(sceneId); return; }
    document.getElementById(`scene-block-${sceneId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const wrapClass = isRailPlacement
    ? `flex h-full flex-col rounded-xl border border-transparent bg-transparent py-3 ${isCompactRail ? "px-1" : "px-3"}`
    : "px-8 pt-6 pb-5 border-b border-zinc-100";
  const navClass = isRailPlacement
    ? "script-toc-rail-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain pr-1"
    : "flex flex-col gap-0.5";

  return (
    <div className={wrapClass}>
      <p className={`mb-3 text-[10px] font-bold tracking-widest text-zinc-300 uppercase ${isCompactRail ? "text-center" : ""}`}>目录</p>
      <nav ref={navRef} className={navClass}>
        {orderedScenes.map((scene) => {
          const isSubScene = scene.parentId !== null;
          const isActive = scene.id === activeSceneId;
          const numberSlotWidthPx = isSubScene ? sceneNumberSlotWidthPx : chapterNumberSlotWidthPx;
          return (
            <button
              key={scene.id}
              ref={isActive ? activeItemRef : undefined}
              title={scene.name ? `${scene.number || "—"} ${scene.name}` : (scene.number || "—")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.currentTarget.blur();
                scrollTo(scene.id);
              }}
              style={isCompactRail ? undefined : {
                columnGap: `${SCRIPT_TOC_RAIL_LABEL_GAP_REM}rem`,
                ...(isRailPlacement && isSubScene ? { paddingLeft: `calc(0.5rem + ${SCRIPT_TOC_RAIL_SUBSCENE_INDENT_REM}rem)` } : {}),
              }}
              className={`flex items-baseline rounded-lg px-2 py-1 text-left transition-colors hover:bg-zinc-50 group ${
                isCompactRail ? "justify-center gap-0" : `${!isRailPlacement && isSubScene ? "pl-6" : ""}`
              } ${
                isActive ? "bg-white hover:bg-white" : ""
              }`}
            >
              <span
                style={isCompactRail
                  ? undefined
                  : { minWidth: numberSlotWidthPx ? `${numberSlotWidthPx}px` : `${SCRIPT_TOC_RAIL_NUMBER_SLOT_REM}rem` }}
                className={`${isCompactRail ? "min-w-0" : "inline-block text-right"} text-xs tracking-wider ${
                isActive
                  ? "font-bold text-[#637ca1]"
                  : isSubScene
                    ? "font-medium text-zinc-300 group-hover:text-zinc-400"
                    : "font-bold text-zinc-400 group-hover:text-zinc-600"
                }`}
              >
                {scene.number || "—"}
              </span>
              {!isCompactRail && (
                <span className={`min-w-0 truncate ${
                  isActive
                    ? `${isSubScene ? "text-xs" : "text-sm"} font-semibold text-zinc-700`
                    : isSubScene
                      ? "text-xs text-zinc-300 group-hover:text-zinc-500"
                      : "text-sm font-medium text-zinc-500 group-hover:text-zinc-700"
                }`}>
                  {scene.name || <span className="italic text-zinc-200">未命名</span>}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function ScriptSceneMetaField({
  label,
  value,
  multiline,
  canEdit,
  onSave,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  canEdit: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = async () => {
    if (draft === value) return;
    setSaving(true);
    try {
      await onSave(draft);
    } catch {
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group space-y-1.5">
      <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">{label}</label>
      {canEdit ? (
        multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            disabled={saving}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
            placeholder="—"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={saving}
            className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
            placeholder="—"
          />
        )
      ) : (
        <p className="min-h-[1.75rem] whitespace-pre-wrap rounded-lg border border-zinc-200 bg-transparent px-2.5 py-2 text-xs leading-relaxed text-zinc-700 transition-colors group-hover:border-zinc-300 group-hover:text-zinc-950">
          {value || <span className="italic text-zinc-400">—</span>}
        </p>
      )}
    </div>
  );
}

function ScriptSceneDetailRail({
  scene,
  productionId,
  versionId,
  canEdit,
  isDeleteConfirmHighlighted = false,
  scrollbarOffsetPx,
  onUpdateIdentity,
  onPatchMeta,
}: {
  scene: SceneDetail | null;
  productionId: string;
  versionId: string | null;
  canEdit: boolean;
  isDeleteConfirmHighlighted?: boolean;
  scrollbarOffsetPx: number;
  onUpdateIdentity: (id: string, name: string) => void;
  onPatchMeta: (id: string, fields: Partial<SceneMetaFields>) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(scene?.name ?? "");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  const sectionCanEdit = canEdit && editMode;
  const expectedDuration = scene?.expectedDuration ?? "";
  const expectedDurationSeconds = useMemo(
    () => expectedDuration ? parseDuration(expectedDuration) : null,
    [expectedDuration]
  );
  const durationText = scene ? formatDuration(expectedDurationSeconds) || "—" : "—";
  const sceneCaptionNumber = scene ? scene.number.trim() || "—" : "";
  const sceneCaptionName = scene ? scene.name.trim() || "未命名" : "";
  const sceneCaptionText = scene
    ? `【${sceneCaptionNumber}】${sceneCaptionName}`
    : "";

  useEffect(() => {
    setNameDraft(scene?.name ?? "");
  }, [scene?.id, scene?.name]);
  useEffect(() => {
    setEditMode(false);
  }, [scene?.id]);
  useEffect(() => {
    if (!editMode) return;
    const handlePointerDown = (event: PointerEvent) => {
      const rail = railRef.current;
      if (!rail || rail.contains(event.target as Node)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && rail.contains(active)) active.blur();
      window.setTimeout(() => setEditMode(false), 0);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [editMode]);

  const commitIdentity = async () => {
    if (!scene) return;
    const name = nameDraft.trim();
    if (name === scene.name) return;
    setSavingIdentity(true);
    try {
      onUpdateIdentity(scene.id, name);
    } finally {
      setSavingIdentity(false);
    }
  };
  const renderDurationField = () => {
    if (!scene) return null;
    return (
      <div className="group space-y-1.5">
        <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">预期时长</label>
        <DurationInput
          value={expectedDurationSeconds}
          canEdit={sectionCanEdit}
          onSave={(seconds) => onPatchMeta(scene.id, { expectedDuration: seconds != null ? String(seconds) : "" })}
          className="!min-h-[1.75rem] !rounded-lg !border !border-zinc-200 !bg-transparent !px-2.5 !py-2 !text-xs !text-zinc-700 hover:!border-zinc-300 hover:!bg-transparent hover:!text-zinc-950"
        />
      </div>
    );
  };

  return (
    <div
      ref={railRef}
      data-script-scene-detail="true"
      className="group/scene-detail box-border flex h-full min-h-0 w-full flex-col rounded-lg px-3 pt-3 text-left"
      style={{
        background: isDeleteConfirmHighlighted
          ? "#fee2e2"
          : `linear-gradient(to bottom, rgb(255, 255, 255) 0, rgb(255, 255, 255) ${SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM}rem, rgba(255, 255, 255, ${sectionCanEdit ? "1" : "0.5"}) ${SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM}rem, rgba(255, 255, 255, ${sectionCanEdit ? "1" : "0.5"}) 100%)`,
      }}
    >
      <div
        className="mb-3 flex shrink-0 items-center justify-between gap-2"
        style={{
          marginRight: `calc(-0.75rem - ${scrollbarOffsetPx}px)`,
          paddingRight: `calc(${scrollbarOffsetPx}px + 8px + ${SCRIPT_SCENE_DETAIL_MODE_BUTTON_EXTRA_INSET_REM}rem)`,
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {sectionCanEdit ? (
            <p className="shrink-0 text-xs font-bold tracking-widest text-zinc-500 uppercase">章节详情</p>
          ) : scene ? (
            <>
              <p className="min-w-0 flex-1 truncate text-xs text-zinc-600" title={sceneCaptionText}>
                <span className="font-bold">【{sceneCaptionNumber}】</span>
                <span>{sceneCaptionName}</span>
              </p>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <p className="shrink-0 whitespace-nowrap text-xs text-zinc-600">
                <span className="font-bold">预期时长：</span>
                <span className="font-normal">{durationText}</span>
              </p>
            </>
          ) : (
            <p className="shrink-0 text-xs font-bold tracking-widest text-zinc-500 uppercase">章节详情</p>
          )}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditMode((value) => !value)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
              editMode
                ? "bg-zinc-700 text-white opacity-100 hover:bg-zinc-600"
                : "pointer-events-none bg-[#637ca1] text-white opacity-0 hover:bg-[#91a8ca] group-hover/scene-detail:pointer-events-auto group-hover/scene-detail:opacity-100"
            }`}
          >
            {editMode ? "确认" : "编辑"}
          </button>
        ) : (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">只读</span>
        )}
      </div>
      {!scene ? (
        <div className="flex flex-1 items-center justify-center text-center text-xs leading-relaxed text-zinc-500">
          滚动或选择目录中的章节
        </div>
      ) : (
        <div
          className="script-toc-rail-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain"
          style={{
            marginRight: `calc(-0.75rem - ${scrollbarOffsetPx}px)`,
            paddingRight: `${scrollbarOffsetPx}px`,
            scrollbarGutter: "stable",
          }}
        >
          {sectionCanEdit && (
            <>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
                <div className="group space-y-1.5">
                  <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">编号</label>
                  <div className="w-full rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 text-xs font-semibold tabular-nums text-zinc-500">
                    {scene.number || "—"}
                  </div>
                </div>
                <div className="group space-y-1.5">
                  <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">名称</label>
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitIdentity}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    disabled={savingIdentity}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
                    placeholder="未命名"
                  />
                </div>
              </div>
              {renderDurationField()}
            </>
          )}
          <ScriptSceneMetaField label="简介" value={scene.synopsis} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { synopsis: value })} />
          <ScriptSceneMetaField label="行动线" value={scene.actionLine} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { actionLine: value })} />
          <ScriptSceneMetaField label="音乐" value={scene.music} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { music: value })} />
          <ScriptSceneMetaField label="舞台呈现" value={scene.stageNotes} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { stageNotes: value })} />
          <div className="pt-3">
            <MountPointAssets
              productionId={productionId}
              mountType="scene"
              mountId={scene.id}
              label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
              canEdit={sectionCanEdit}
              versionId={versionId}
              display="compact"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ScenePanel ───────────────────────────────────────────────────────────────

function SceneRow({
  scene,
  onUpdate,
  onRemove,
  canRemove = true,
  indent = false,
}: {
  scene: Scene;
  onUpdate: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  canRemove?: boolean;
  indent?: boolean;
}) {
  const [name, setName] = useState(scene.name);
  const [lastSeenName, setLastSeenName] = useState(scene.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (lastSeenName !== scene.name) { setLastSeenName(scene.name); setName(scene.name); }

  const commit = () => {
    if (name.trim() !== scene.name) {
      onUpdate(scene.id, name.trim());
    }
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className={`py-1 pr-2 align-middle${indent ? " pl-4" : ""}`}>
        <span className={`block w-14 px-1 py-0.5 text-sm font-medium tabular-nums${indent ? " text-zinc-400" : " text-zinc-600"}`}>
          {scene.number || "—"}
        </span>
      </td>
      <td className="py-1 align-middle">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          className="w-full rounded border border-transparent px-1 py-0.5 text-sm outline-none focus:border-zinc-300"
          placeholder="名称"
        />
      </td>
      <td className="py-1 pl-2 align-middle">
        {!canRemove ? null : confirmDelete ? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <button
              onClick={() => onRemove(scene.id)}
              className="text-xs text-red-500 hover:text-red-700"
            >
              确认
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-zinc-400 hover:text-zinc-600"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          >
            ×
          </button>
        )}
      </td>
    </tr>
  );
}

function ScenePanel({
  scenes,
  productionId,
  onAdd,
  onUpdate,
  onRemove,
  open,
  onOpenChange,
  canImport,
  onNavigate,
  triggerClassName,
  nestedFromMore = false,
  label = "章节",
}: {
  scenes: Scene[];
  productionId: string;
  onAdd: (parentId?: string, target?: { insertAfterSceneId?: string; insertBeforeSceneId?: string }) => void;
  onUpdate: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canImport?: boolean;
  onNavigate?: () => void;
  triggerClassName?: string;
  nestedFromMore?: boolean;
  label?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => onOpenChange(!open)}
        className={triggerClassName ?? "flex items-center gap-0.5 rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"}
      >
        {label} <Chevron />
      </button>
      {open && (
        <div
          className={`${nestedFromMore ? "fixed right-2 top-64" : "absolute right-0 top-full"} z-30 mt-1 flex w-72 flex-col rounded-xl border border-zinc-100 bg-white shadow-xl`}
          style={{ maxHeight: nestedFromMore ? "min(28rem, calc(100vh - 18rem))" : "min(28rem, calc(100vh - 8rem))" }}
        >
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">章节管理</span>
            <div className="flex items-center gap-2">
              {canImport && productionId && (
                <Link href={`/production/${productionId}/import-scenes`} onNavigate={onNavigate} className="text-[11px] text-blue-400 hover:text-blue-600 transition-colors">
                  导入
                </Link>
              )}
              <Link href={`/production/${productionId}/scenes`} onNavigate={onNavigate} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
                管理页 →
              </Link>
            </div>
          </div>
          <div className="overflow-y-auto p-3">
            {scenes.length === 0 ? (
              <p className="mb-2 text-center text-xs text-zinc-300">暂无章节</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                    <th className="pb-1 pr-2 font-medium">编号</th>
                    <th className="pb-1 font-medium">名称</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s) => {
                    const isSubScene = s.parentId !== null;
                    return (
                      <React.Fragment key={s.id}>
                        <SceneRow
                          scene={s}
                          onUpdate={onUpdate}
                          onRemove={onRemove}
                          canRemove={s.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID}
                          indent={isSubScene}
                        />
                        {/* After each act row, show an inline "add sub-scene" row */}
                        {!isSubScene && (
                          <tr>
                            <td colSpan={3} className="pt-0 pb-1 pl-5">
                              <button
                                onClick={() => onAdd(s.id, { insertAfterSceneId: s.id })}
                                className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors"
                              >
                                + 添加段落
                              </button>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="shrink-0 border-t border-zinc-100 p-3">
            <button
              onClick={() => onAdd(undefined, scenes.length > 0 ? { insertAfterSceneId: scenes[scenes.length - 1].id } : undefined)}
              className="w-full rounded-lg border border-dashed border-zinc-200 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600"
            >
              + 添加章节
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type ScriptMarkerNode =
  | { kind: "chapter"; id: string; scene: Scene }
  | { kind: "scene"; id: string; scene: Scene }
  | { kind: "rehearsal"; id: string; mark: string };

function SceneHeader({
  scene,
  canEditName = false,
  onNameChange,
}: {
  scene: Scene;
  canEditName?: boolean;
  onNameChange?: (id: string, name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(scene.name);
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNameDraft(scene.name);
  }, [scene.id, scene.name]);
  useEffect(() => {
    if (!editingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [editingName]);

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (nextName !== scene.name) onNameChange?.(scene.id, nextName);
    setEditingName(false);
  };

  const startEditingName = () => {
    if (!canEditName) return;
    setNameDraft(scene.name);
    setEditingName(true);
  };

  const nameEl = (className: string, placeholder: string) => editingName ? (
    <input
      ref={nameInputRef}
      value={nameDraft}
      onChange={(e) => setNameDraft(e.target.value)}
      onBlur={commitName}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setNameDraft(scene.name);
          setEditingName(false);
        }
      }}
      placeholder={placeholder}
      className={`${className} min-w-[6rem] max-w-[18rem] rounded border border-transparent bg-transparent px-1 py-0.5 outline-none transition-colors placeholder:text-zinc-300 hover:border-zinc-200 hover:bg-white/70 focus:border-zinc-300 focus:bg-white`}
    />
  ) : (
    scene.name ? <span className={className}>{scene.name}</span> : null
  );

  if (scene.parentId === null) {
    return (
      <div className="flex select-none items-center gap-3 py-4">
        <div className="h-px flex-1 bg-zinc-300" />
        <div
          data-script-marker-title="true"
          className={`flex items-baseline gap-2.5${canEditName ? " cursor-text" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            startEditingName();
          }}
        >
          <span className="text-xs font-extrabold tracking-widest text-zinc-500">{scene.number}</span>
          {nameEl("text-base font-semibold text-zinc-600", "章节名称")}
        </div>
        <div className="h-px flex-1 bg-zinc-300" />
      </div>
    );
  }

  return (
    <div className="flex select-none items-center gap-2 py-2">
      <div className="h-px flex-1 bg-zinc-100" />
      <div
        data-script-marker-title="true"
        className={`flex items-baseline gap-1.5${canEditName ? " cursor-text" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          startEditingName();
        }}
      >
        <span className="text-[10px] font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {nameEl("text-xs text-zinc-400", "段落名称")}
      </div>
      <div className="h-px flex-1 bg-zinc-100" />
    </div>
  );
}

function ScriptMarkerRow({
  node,
  canEdit,
  isSelected,
  isReorderLocked,
  isScriptDragging,
  dragTarget,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onSelect,
  canAddChapterScene,
  canAddRehearsal,
  onAddChapterBefore,
  onAddSceneBefore,
  onAddRehearsalBefore,
  onConvertToChapter,
  onConvertToScene,
  onDeleteConfirmChange,
  onSceneNameChange,
  lineIndexWidth,
  dismissToken = 0,
  isFixed = false,
  isRecentlyMoved = false,
  isTocHighlighted = false,
}: {
  node: ScriptMarkerNode;
  canEdit: boolean;
  isSelected: boolean;
  isReorderLocked: boolean;
  isScriptDragging: boolean;
  dragTarget?: DragTarget | null;
  onRemove: () => void;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onSelect: () => void;
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapterBefore: () => void;
  onAddSceneBefore: () => void;
  onAddRehearsalBefore: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
  onDeleteConfirmChange?: (confirming: boolean) => void;
  onSceneNameChange?: (id: string, name: string) => void;
  lineIndexWidth?: string;
  dismissToken?: number;
  isFixed?: boolean;
  isRecentlyMoved?: boolean;
  isTocHighlighted?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setConfirmDelete(false);
  }, [dismissToken]);
  const isRehearsal = node.kind === "rehearsal";
  const markerRootStyle: React.CSSProperties | undefined = lineIndexWidth
    ? { paddingLeft: `calc(${lineIndexWidth} + ${LINE_INDEX_GUTTER_OFFSET_REM}rem)` }
    : undefined;
  const rehearsalMarkerStyle: React.CSSProperties | undefined = isRehearsal
    ? { height: `max(${REHEARSAL_MARKER_ROW_MIN_HEIGHT_PX}px, ${REHEARSAL_MARKER_ROW_BASE_HEIGHT_REM * REHEARSAL_MARKER_ROW_HEIGHT_SCALE}rem)` }
    : undefined;
  const rehearsalFloatStyle: React.CSSProperties | undefined = isRehearsal
    ? { left: `calc(1.5rem + ${REHEARSAL_MARKER_FLOAT_LEFT_OFFSET_REM}rem)` }
    : undefined;
  const title = isRehearsal
    ? `排练记号 ${node.mark}`
    : [node.scene.number, node.scene.name].filter(Boolean).join(" ");
  const deleteConfirmText =
    node.kind === "chapter"
      ? "确认删除此章节标记？"
      : node.kind === "scene"
        ? "确认删除此段落标记？"
        : "确认删除此排练记号？";
  const markerMovedGlowClass = isRecentlyMoved ? "script-block-moved-glow" : "";
  const markerTocGlowClass = !isRehearsal && !isRecentlyMoved && isTocHighlighted ? "script-toc-marker-glow" : "";
  const markerGlowEndColor = !isRehearsal && isTocHighlighted
    ? confirmDelete ? "#fee2e2" : isSelected ? "#eef3fa" : "#ffffff"
    : undefined;
  const convertToChapter = node.kind === "scene" || node.kind === "rehearsal" ? onConvertToChapter : undefined;
  const convertToScene = node.kind === "chapter" || node.kind === "rehearsal" ? onConvertToScene : undefined;
  const canShowBoundaryMenu = !isFixed && (
    canAddChapterScene ||
    canAddRehearsal ||
    !!convertToChapter ||
    !!convertToScene
  );
  const boundaryMenuControl = canShowBoundaryMenu ? (
    <RehearsalMarkInput
      variant="marker-control"
      canAddChapterScene={canAddChapterScene}
      canAddRehearsal={canAddRehearsal}
      onAddChapterBefore={onAddChapterBefore}
      onAddSceneBefore={onAddSceneBefore}
      onAddRehearsalBefore={onAddRehearsalBefore}
      onConvertToChapter={convertToChapter}
      onConvertToScene={convertToScene}
    />
  ) : null;
  const markerRootCombinedStyle: React.CSSProperties | undefined = (
    markerRootStyle || rehearsalMarkerStyle || markerGlowEndColor
      ? ({
          ...markerRootStyle,
          ...rehearsalMarkerStyle,
          ...(markerGlowEndColor ? { "--script-block-glow-fade-end": markerGlowEndColor } : {}),
        } as React.CSSProperties)
      : undefined
  );

  return (
    <div
      id={`marker-${node.id}`}
      data-script-marker={node.id}
      title={title}
      onClick={(e) => {
        if (isScriptDragging) return;
        if (isRehearsal) return;
        if (!canEdit) return;
        if ((e.target as HTMLElement | null)?.closest("[data-script-marker-title='true']")) return;
        onSelect();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={markerRootCombinedStyle}
      className={`group/marker relative select-none text-left transition-colors ${
        isRehearsal
          ? ""
          : confirmDelete ? "bg-red-100" : isSelected ? "bg-[#eef3fa]" : "hover:bg-zinc-50/70"
      } ${markerMovedGlowClass} ${markerTocGlowClass} px-6 ${isRehearsal ? "overflow-visible" : ""}`}
    >
      {dragTarget && (
        <div
          className={`pointer-events-none absolute left-4 right-4 z-10 border-t-2 ${
            dragTarget.kind !== "edge" && dragTarget.position === "before" ? "-top-0.5" : "-bottom-0.5"
          }`}
          style={{ borderColor: "#91a8ca" }}
        />
      )}
      {!isFixed && !isRehearsal && (canEdit || boundaryMenuControl) && (
        <div className="absolute left-0 top-1 bottom-1 z-20 w-12">
          {canEdit && confirmDelete ? (
            <span
              className="absolute left-0 top-1/2 z-10 flex -translate-y-1/2 translate-x-8 items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm"
              data-script-confirmation="true"
            >
              <span className="whitespace-nowrap text-[10px] text-zinc-400">{deleteConfirmText}</span>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setConfirmDelete(false);
                  onDeleteConfirmChange?.(false);
                  onRemove();
                }}
                className="shrink-0 whitespace-nowrap text-[10px] text-red-500 hover:text-red-700"
              >
                确认
              </button>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setConfirmDelete(false);
                  onDeleteConfirmChange?.(false);
                }}
                className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400 hover:text-zinc-600"
              >
                取消
              </button>
            </span>
          ) : canEdit ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (isScriptDragging) return;
                setConfirmDelete(true);
                onDeleteConfirmChange?.(true);
              }}
              style={{ left: MARKER_CONTROL_DELETE_LEFT_PX }}
              className="absolute top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-[12px] leading-none text-zinc-300 opacity-0 transition-all hover:bg-red-100 hover:text-red-500 group-hover/marker:opacity-100"
              title="删除此标记"
              aria-label="删除此标记"
            >
              ×
            </button>
          ) : null}
          {canEdit && (
            <button
              type="button"
              draggable={!isReorderLocked}
              disabled={isReorderLocked}
              data-script-block-bar="true"
              data-script-marker-bar="true"
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMouseDown={(e) => {
                if (e.shiftKey) e.preventDefault();
                e.stopPropagation();
              }}
              onClick={onSelect}
              style={{ left: MARKER_CONTROL_BAR_LEFT_PX }}
              className={`absolute top-1/2 h-[max(1.25rem,calc(100%-0.25rem))] w-4 -translate-y-1/2 select-none rounded opacity-0 outline-none transition-all focus:outline-none focus-visible:outline-none group-hover/marker:opacity-100 ${
                isReorderLocked
                  ? "cursor-not-allowed text-zinc-200 opacity-40"
                  : `cursor-grab hover:bg-[#dbe5f3] hover:text-[#91a8ca] active:cursor-grabbing ${
                      isSelected ? "bg-[#dbe5f3] text-[#91a8ca] opacity-100" : "text-zinc-200"
                    }`
              }`}
              title="拖动调整标记位置"
              aria-label="拖动调整标记位置"
            >
              <span className="pointer-events-none absolute bottom-1 left-1/2 top-1 w-0.5 -translate-x-1/2 rounded bg-current" />
            </button>
          )}
          {boundaryMenuControl && (
            <span
              className="absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/marker:opacity-100"
              style={{
                left: MARKER_CONTROL_TRIANGLE_LEFT_PX,
                marginTop: MARKER_CONTROL_TRIANGLE_TOP_OFFSET_PX,
              }}
            >
              {boundaryMenuControl}
            </span>
          )}
        </div>
      )}
      {isRehearsal ? (
        <div
          className="absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1"
          style={rehearsalFloatStyle}
        >
          <button
            type="button"
            draggable={canEdit && !isFixed && !isReorderLocked}
            data-script-block-bar="true"
            data-script-marker-bar="true"
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (isScriptDragging) return;
              if (!canEdit) return;
              onSelect();
            }}
            className={`inline-flex h-5 min-w-6 items-center justify-center rounded px-2 text-[10px] font-bold tracking-wider ${confirmDelete ? "transition-none" : "transition-all"} ${
              confirmDelete
                ? "bg-red-100 text-red-600 ring-1 ring-red-300"
                : isSelected ? "bg-[#eef3fa] text-[#637ca1] ring-1 ring-[#91a8ca]" : "bg-zinc-100 text-zinc-500"
            } ${
              canEdit && !isFixed && !isReorderLocked
                ? confirmDelete
                  ? "cursor-grab hover:bg-red-100 hover:text-red-700 active:cursor-grabbing"
                  : "cursor-grab hover:bg-[#dbe5f3] hover:text-[#637ca1] active:cursor-grabbing"
                : "cursor-default"
            }`}
            title="拖动调整排练记号位置"
            aria-label={`排练记号 ${node.mark}`}
          >
            {node.mark}
          </button>
          {canEdit && !isFixed && confirmDelete ? (
            <span
              className="flex items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm"
              data-script-confirmation="true"
            >
              <span className="whitespace-nowrap text-[10px] text-zinc-400">{deleteConfirmText}</span>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(false);
                  onDeleteConfirmChange?.(false);
                  onRemove();
                }}
                className="shrink-0 whitespace-nowrap text-[10px] text-red-500 hover:text-red-700"
              >
                确认
              </button>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(false);
                  onDeleteConfirmChange?.(false);
                }}
                className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400 hover:text-zinc-600"
              >
                取消
              </button>
            </span>
          ) : canEdit && !isFixed ? (
            <button
              type="button"
              data-script-confirmation="true"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isScriptDragging) return;
                onSelect();
                setConfirmDelete(true);
                onDeleteConfirmChange?.(true);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              className={`flex h-4 w-4 items-center justify-center rounded text-[12px] leading-none text-zinc-300 transition-all hover:bg-red-100 hover:text-red-500 ${
                isSelected ? "opacity-100" : "opacity-0 group-hover/marker:opacity-100"
              }`}
              title="删除此排练记号"
              aria-label="删除此排练记号"
            >
              ×
            </button>
          ) : null}
          {!confirmDelete && boundaryMenuControl ? (
            <span className="flex h-4 items-center opacity-0 transition-opacity group-hover/marker:opacity-100">
              {boundaryMenuControl}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-[7.5rem_1rem_minmax(0,1fr)] gap-x-2">
          <div className="col-span-3">
            <SceneHeader
              scene={node.scene}
              canEditName={canEdit}
              onNameChange={onSceneNameChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BoundaryInsertMenu({
  canAddChapterScene,
  canAddRehearsal,
  onAddChapter,
  onAddScene,
  onAddRehearsal,
  onConvertToChapter,
  onConvertToScene,
}: {
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapter: () => void;
  onAddScene: () => void;
  onAddRehearsal: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
}) {
  const actions: Array<[string, () => void]> = [
    ...(canAddChapterScene ? [
      ["添加新章", onAddChapter] as [string, () => void],
      ["添加新段", onAddScene] as [string, () => void],
    ] : []),
    ...(canAddRehearsal ? [["添加新排练记号", onAddRehearsal] as [string, () => void]] : []),
  ];
  const conversionActions: Array<[string, () => void]> = [
    ...(onConvertToChapter ? [["转为章节", onConvertToChapter] as [string, () => void]] : []),
    ...(onConvertToScene ? [["转为段落", onConvertToScene] as [string, () => void]] : []),
  ];
  const renderAction = ([label, handler]: [string, () => void]) => (
    <button
      key={label}
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        handler();
      }}
      className="block w-full px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
    >
      {label}
    </button>
  );

  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-lg border border-zinc-100 bg-white py-1 text-left shadow-xl">
      {actions.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-400">在块前</div>
          {actions.map(renderAction)}
        </>
      )}
      {conversionActions.length > 0 && (
        <>
          {actions.length > 0 && <div className="my-1 h-px bg-zinc-100" />}
          <div className="px-3 py-1 text-[10px] font-semibold tracking-wide text-zinc-400">转换</div>
          {conversionActions.map(renderAction)}
        </>
      )}
    </div>
  );
}

function SceneLabel({ scene, focused = false }: { scene: Scene; focused?: boolean }) {
  return (
    <span
      title={scene.name ? `${scene.number} ${scene.name}` : scene.number}
      className={`pointer-events-none select-none rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
        focused ? "text-zinc-600" : "text-zinc-300 group-hover:text-zinc-500"
      }`}
    >
      {scene.number}
    </span>
  );
}

// ─── Per-block rehearsal mark ──────────────────────────────────────────────────

function RehearsalMarkInput({
  variant = "script-block",
  canAddChapterScene,
  canAddRehearsal,
  onAddChapterBefore,
  onAddSceneBefore,
  onAddRehearsalBefore,
  onConvertToChapter,
  onConvertToScene,
}: {
  variant?: "script-block" | "marker-control";
  canAddChapterScene: boolean;
  canAddRehearsal: boolean;
  onAddChapterBefore: () => void;
  onAddSceneBefore: () => void;
  onAddRehearsalBefore: () => void;
  onConvertToChapter?: () => void;
  onConvertToScene?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const closeAfter = (fn: () => void) => {
    fn();
    setOpen(false);
  };
  const triggerLayoutClass = variant === "marker-control"
    ? "flex h-4 w-4 items-center justify-center p-0"
    : "px-0.5 py-0";

  return (
    <span
      ref={wrapRef}
      className={`relative flex items-start gap-1 ${open ? "z-50" : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        title="添加章节/段落/排练记号"
        data-rehearsal-triangle="true"
        className={`rounded ${triggerLayoutClass} text-[8px] font-bold leading-none tracking-wide text-zinc-300 transition-colors hover:text-zinc-500`}
      >
        ▶
      </button>
      {open && (
        <BoundaryInsertMenu
          canAddChapterScene={canAddChapterScene}
          canAddRehearsal={canAddRehearsal}
          onAddChapter={() => closeAfter(onAddChapterBefore)}
          onAddScene={() => closeAfter(onAddSceneBefore)}
          onAddRehearsal={() => closeAfter(onAddRehearsalBefore)}
          onConvertToChapter={onConvertToChapter ? () => closeAfter(onConvertToChapter) : undefined}
          onConvertToScene={onConvertToScene ? () => closeAfter(onConvertToScene) : undefined}
        />
      )}
    </span>
  );
}

function RehearsalMarkLabel({ mark }: { mark: string }) {
  return (
    <span className="flex items-start gap-1">
      <span
        data-rehearsal-triangle="true"
        className="rounded px-0.5 py-0 text-[8px] font-bold leading-none tracking-wide text-zinc-500"
      >
        ▶
      </span>
      <span className="text-[9px] font-bold leading-none tracking-wide text-zinc-500">
        {mark}
      </span>
    </span>
  );
}

// ─── CharacterPanel ───────────────────────────────────────────────────────────

function CharacterRow({
  char,
  focused,
  onToggleFocus,
  onRename,
  onRemove,
  readOnly = false,
}: {
  char: Character;
  focused: boolean;
  onToggleFocus: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(char.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commit = () => {
    const t = draft.trim();
    if (t) onRename(t);
    else setDraft(char.name);
    setEditing(false);
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className="max-w-0 px-4 py-2 w-full">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(char.name); setEditing(false); }
            }}
            className="w-full border-b border-zinc-400 text-sm text-zinc-800 outline-none"
          />
        ) : (
          <span
            onClick={() => {
              if (readOnly) return;
              setDraft(char.name);
              setEditing(true);
            }}
            className={`block truncate whitespace-nowrap text-sm text-zinc-700 ${readOnly ? "" : "cursor-text hover:text-zinc-900"}`}
            title={readOnly ? undefined : "点击重命名"}
          >
            {char.name}
          </span>
        )}
      </td>
      <td className="w-8 py-2 pr-2 text-right align-middle">
        <button
          type="button"
          onClick={onToggleFocus}
          className="inline-flex items-center align-middle"
          title={focused ? "取消聚焦角色" : "聚焦角色"}
          aria-pressed={focused}
        >
          <ModeSwitch active={focused} activeClassName="bg-purple-800/60" />
        </button>
      </td>
      {!readOnly && (
        <td className="w-7 py-2 pr-4 text-right align-middle whitespace-nowrap">
          {confirmDelete ? (
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <button
                onClick={onRemove}
                className="text-xs text-red-500 hover:text-red-700"
              >
                确认
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-sm text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              ×
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

function CharacterPanel({
  characters,
  productionId,
  focusedCharacterIds,
  onToggleFocus,
  onClearFocus,
  onAdd,
  onRemove,
  onRename,
  open,
  onOpenChange,
  onNavigate,
  readOnly = false,
  triggerClassName,
  nestedFromMore = false,
  label = "角色",
}: {
  characters: Character[];
  productionId: string;
  focusedCharacterIds: Set<string>;
  onToggleFocus: (id: string) => void;
  onClearFocus: () => void;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigate?: () => void;
  readOnly?: boolean;
  triggerClassName?: string;
  nestedFromMore?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const submit = () => {
    if (readOnly) return;
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    setDraft("");
  };

  return (
    <div ref={panelRef} className="relative shrink-0">
      <button
        onClick={() => onOpenChange(!open)}
        className={triggerClassName ?? `flex items-center gap-0.5 rounded px-1.5 py-1 text-sm transition-colors ${
          open
            ? "bg-zinc-100 text-zinc-800"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        }`}
      >
        {label} <Chevron />
      </button>

      {open && (
        <div
          className={`${nestedFromMore ? "fixed right-2 top-64" : "absolute right-0 top-full"} z-30 mt-1 flex w-56 flex-col rounded-xl border border-zinc-100 bg-white shadow-xl`}
          style={{ maxHeight: nestedFromMore ? "min(28rem, calc(100vh - 18rem))" : "min(28rem, calc(100vh - 8rem))" }}
        >
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-4 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">角色管理</span>
            {(focusedCharacterIds.size > 0 || !readOnly) && (
              <div className="flex items-center gap-2">
                {focusedCharacterIds.size > 0 && (
                  <button
                    type="button"
                    onClick={onClearFocus}
                    className="whitespace-nowrap text-[11px] text-purple-800/60 transition-colors hover:text-purple-800"
                  >
                    重置聚焦
                  </button>
                )}
                {!readOnly && (
                  <Link href={`/production/${productionId}/characters`} onNavigate={onNavigate} className="whitespace-nowrap text-[11px] text-zinc-300 transition-colors hover:text-zinc-500">
                    管理页 →
                  </Link>
                )}
              </div>
            )}
          </div>

          <div className="overflow-y-auto">
          <table className="w-full">
            <tbody>
              {characters.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-sm text-zinc-300">暂无角色</td>
                </tr>
              ) : (
                characters.map((c) => (
                  <CharacterRow
                    key={c.id}
                    char={c}
                    focused={focusedCharacterIds.has(c.id)}
                    onToggleFocus={() => onToggleFocus(c.id)}
                    onRename={(name) => onRename(c.id, name)}
                    onRemove={() => onRemove(c.id)}
                    readOnly={readOnly}
                  />
                ))
              )}
            </tbody>
          </table>
          </div>

          {!readOnly && (
            <div className="shrink-0 flex items-center gap-2 border-t border-zinc-100 px-4 py-2.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="新角色名…"
                className="min-w-0 flex-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-300"
              />
              <button
                onClick={submit}
                disabled={!draft.trim()}
                className="shrink-0 rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-30"
              >
                添加
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── BlockCharacterSelector ───────────────────────────────────────────────────

function BlockCharacterSelector({
  block,
  characters,
  onChange,
  onAnnotationChange,
  onForceShowCharacterNameChange,
  onEditingChange,
  editRequestToken,
  onArrowUp,
  onArrowDown,
  readOnly = false,
  layoutMode = "center",
  bottomGapClassName = "mb-2",
}: {
  block: Block;
  characters: Character[];
  onChange: (ids: string[]) => void;
  onAnnotationChange: (charId: string, annotation: string) => void;
  onForceShowCharacterNameChange: (force: boolean) => void;
  onEditingChange: (editing: boolean) => void;
  editRequestToken: number;
  onArrowUp: () => void;
  onArrowDown: () => void;
  readOnly?: boolean;
  layoutMode?: ScriptTextLayoutMode;
  bottomGapClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const setEditingWithNotify = useCallback((v: boolean) => { setEditing(v); onEditingChange(v); }, [onEditingChange]);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open editing when token increments (token changes on each external open request)
  const prevTokenRef = useRef(editRequestToken);
  useEffect(() => {
    if (editRequestToken > 0 && editRequestToken !== prevTokenRef.current) {
      prevTokenRef.current = editRequestToken;
      setEditingWithNotify(true);
    }
  }, [editRequestToken, setEditingWithNotify]);

  // Focus input whenever editing mode activates; auto-expand annotations if any exist
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (block.characterIds.some((id) => block.characterAnnotations[id])) setShowAnnotations(true);
    } else {
      setShowAnnotations(false);
      setDisplayMenuOpen(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setEditingWithNotify(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing, setEditingWithNotify]);

  const selected = characters.filter((c) => block.characterIds.includes(c.id));
  const suggestions = characters.filter(
    (c) => !block.characterIds.includes(c.id) && c.name.includes(query)
  );
  const selectorControlClass = "flex h-4 items-center gap-0.5 text-[11px] leading-none transition-colors";

  const addChar = (id: string) => {
    onChange([...block.characterIds, id]);
    setQuery("");
    setHighlightIdx(0);
    inputRef.current?.focus();
  };

  const removeChar = (id: string) =>
    onChange(block.characterIds.filter((c) => c !== id));

  const close = () => { setEditingWithNotify(false); setQuery(""); setHighlightIdx(0); setDisplayMenuOpen(false); };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (highlightIdx < suggestions.length - 1) {
        setHighlightIdx((i) => i + 1);
      } else {
        close();
        onArrowDown();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlightIdx > 0) {
        setHighlightIdx((i) => i - 1);
      } else {
        close();
        onArrowUp();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        addChar(suggestions[Math.min(highlightIdx, suggestions.length - 1)].id);
        close();
        onArrowDown();
      }
    } else if (e.key === "Escape") {
      close();
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      removeChar(selected[selected.length - 1].id);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C") && query === "") {
      // Copy current character names as plain text
      e.preventDefault();
      const names = selected.map((c) => c.name).join("、");
      navigator.clipboard.writeText(names).catch(() => {});
    }
  };

  const charLabel = (c: Character) => {
    const ann = block.characterAnnotations[c.id];
    return ann ? `${c.name}（${ann}）` : c.name;
  };
  const compactLayout = layoutMode === "compact";

  if (!editing) {
    return (
      <div className={`${compactLayout ? "mb-0 flex justify-end text-right" : `${bottomGapClassName} flex translate-x-px justify-center`}`}>
        {readOnly ? (
          <span data-character-label="true" className={`max-w-full break-words text-sm font-bold leading-7 tracking-[0.12em] ${selected.length ? "text-zinc-800" : "text-zinc-300"}`}>
            {selected.length ? selected.map(charLabel).join("、") : "无角色"}
          </span>
        ) : (
          <button
            data-character-label="true"
            onClick={() => setEditingWithNotify(true)}
            className={`max-w-full break-words text-right text-sm font-bold leading-7 tracking-[0.12em] transition-colors ${
              selected.length
                ? "text-zinc-800 hover:text-zinc-500"
                : "text-zinc-300 hover:text-zinc-400"
            }`}
          >
            {selected.length ? selected.map(charLabel).join("、") : "无角色"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`relative z-30 ${compactLayout ? "mb-0" : "mb-2"}`}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 transition-colors focus-within:border-zinc-500">
        {selected.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
          >
            {c.name}
            <button
              onMouseDown={(e) => { e.preventDefault(); removeChar(c.id); }}
              className="ml-0.5 text-zinc-400 hover:text-zinc-700"
            >×</button>
          </span>
        ))}
        {characters.length === 0 ? (
          <p className="min-w-[12rem] flex-1 text-left text-xs leading-5 text-zinc-400">
            当前版本尚无任何角色。请通过【戏剧构作】—【角色】进行添加。
          </p>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlightIdx(0); }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text/plain");
              const matches = text
                .split(/[、，,\n]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .flatMap((name) => {
                  const c = characters.find((c) => c.name === name && !block.characterIds.includes(c.id));
                  return c ? [c.id] : [];
                });
              if (matches.length > 0) {
                e.preventDefault();
                onChange([...block.characterIds, ...matches]);
              }
              // No matches → let default paste fill the search query
            }}
            placeholder={selected.length === 0 ? "搜索角色…" : ""}
            className="min-w-[5rem] flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-300"
          />
        )}
        {selected.length > 0 && !readOnly && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="relative flex h-4 items-center">
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setDisplayMenuOpen((v) => !v); }}
                className={`${selectorControlClass} ${
                  block.forceShowCharacterName ? "text-zinc-600" : "text-zinc-300 hover:text-zinc-500"
                }`}
              >
                <span>显示状态</span>
                <FoldTriangle open={displayMenuOpen} />
              </button>
              {displayMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 w-32 rounded-xl border border-zinc-100 bg-white py-1 shadow-xl">
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onForceShowCharacterNameChange(true);
                      setDisplayMenuOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${
                      block.forceShowCharacterName ? "text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
                    }`}
                  >
                    永远显示该行角色
                  </button>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onForceShowCharacterNameChange(false);
                      setDisplayMenuOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${
                      block.forceShowCharacterName ? "text-zinc-500 hover:bg-zinc-50" : "text-zinc-900"
                    }`}
                  >
                    自动
                  </button>
                </div>
              )}
            </div>
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setShowAnnotations((v) => !v); }}
              className={`${selectorControlClass} text-zinc-300 hover:text-zinc-500`}
            >
              <span>备注</span>
              <FoldTriangle open={showAnnotations} />
            </button>
          </div>
        )}
      </div>
      {showAnnotations && selected.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 rounded-b-lg border border-t-0 border-zinc-200 px-2.5 py-1.5">
          {selected.map((c) => (
            <label key={c.id} className="flex items-center gap-1">
              <span className="text-[11px] text-zinc-400">{c.name}</span>
              <input
                value={block.characterAnnotations[c.id] ?? ""}
                onChange={(e) => onAnnotationChange(c.id, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="备注…"
                className="w-16 border-b border-zinc-200 bg-transparent text-[11px] text-zinc-600 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
              />
            </label>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-zinc-100 bg-white py-1 shadow-xl overflow-y-auto" style={{ maxHeight: "min(16rem, calc(100vh - 12rem))" }}>
          {suggestions.map((c, i) => (
            <button
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); addChar(c.id); }}
              className={`w-full px-4 py-1.5 text-left text-sm ${
                i === highlightIdx
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {suggestions.length === 0 && query && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-zinc-100 bg-white px-4 py-2 shadow-xl">
          <p className="text-xs text-zinc-400">无匹配角色</p>
        </div>
      )}
    </div>
  );
}

function BlockStageComment({
  value,
  onChange,
  showAddButton = true,
  topGap,
  readOnly = false,
  stageDelimOpen,
  stageDelimClose,
  layoutMode = "center",
  placementClassName = "",
  onEditingChange,
  addButtonCenter = false,
  alignFirstLineToEnd = false,
  alignAddButtonToLineAnchor = false,
  onOverflowBelowChange,
  addButtonRevealOnHover = false,
  lineAnchorCenter,
  lineAnchorRowHeight,
  zeroHeightAddButton = false,
  manualOffsetYPx = 0,
  getEditorWidth,
}: {
  value?: string | null;
  onChange: (value: string | null) => void;
  showAddButton?: boolean;
  topGap?: "compact" | "leading";
  readOnly?: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  layoutMode?: ScriptTextLayoutMode;
  placementClassName?: string;
  onEditingChange?: (editing: boolean) => void;
  addButtonCenter?: boolean;
  alignFirstLineToEnd?: boolean;
  alignAddButtonToLineAnchor?: boolean;
  onOverflowBelowChange?: (height: number) => void;
  addButtonRevealOnHover?: boolean;
  lineAnchorCenter?: number;
  lineAnchorRowHeight?: number;
  zeroHeightAddButton?: boolean;
  manualOffsetYPx?: number;
  getEditorWidth?: () => number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const skipBlurCommitRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [lineAnchorShift, setLineAnchorShift] = useState(0);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const text = value?.trim() ?? "";

  const commit = () => {
    const next = draft.trim();
    onChange(next || null);
    skipBlurCommitRef.current = false;
    setEditing(false);
    onEditingChange?.(false);
  };
  const openEditor = () => {
    skipBlurCommitRef.current = false;
    setDraft(value ?? "");
    setEditorWidth(getEditorWidth?.() ?? null);
    setEditing(true);
    onEditingChange?.(true);
  };
  const topGapClass = topGap === "leading" ? "mt-2 " : topGap === "compact" ? "-mt-1 " : "";
  const compactLayout = layoutMode === "compact";
  const alignClass = compactLayout ? "justify-start text-left" : "justify-center text-center";
  const addButtonAlignClass = addButtonCenter ? "justify-center" : alignClass;
  const stageCommentLeadingClass = "leading-normal";
  const stageCommentTextClass = `font-stage text-sm italic text-zinc-400 ${compactLayout ? "text-left" : ""} ${stageCommentLeadingClass} whitespace-pre-wrap`;
  const rootTranslateY = ((alignFirstLineToEnd || alignAddButtonToLineAnchor) ? lineAnchorShift : 0) + manualOffsetYPx;
  const rootStyle: React.CSSProperties | undefined = rootTranslateY !== 0
    ? { transform: `translateY(${rootTranslateY}px)` }
    : undefined;
  const addButtonStyle: React.CSSProperties | undefined = zeroHeightAddButton
    ? { transform: "translateY(-0.75rem)" }
    : undefined;

  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useLayoutEffect(() => {
    if (!alignFirstLineToEnd && !alignAddButtonToLineAnchor) {
      setLineAnchorShift(0);
      onOverflowBelowChange?.(0);
      return;
    }
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const target = alignFirstLineToEnd
        ? el.querySelector<HTMLElement>("[data-stage-comment-body='true']")
        : addButtonRef.current;
      if (!target) {
        setLineAnchorShift(0);
        onOverflowBelowChange?.(0);
        return;
      }
      const rootRect = el.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const lineHeight = alignFirstLineToEnd
        ? parseFloat(window.getComputedStyle(target).lineHeight)
        : targetRect.height;
      const firstLineCenter = targetRect.top - rootRect.top + (Number.isFinite(lineHeight) ? lineHeight : targetRect.height) / 2;
      if (lineAnchorCenter === undefined) {
        setLineAnchorShift(0);
        onOverflowBelowChange?.(0);
        return;
      }
      const shift = Math.round(lineAnchorCenter - firstLineCenter);
      const rowHeight = Math.max(lineAnchorRowHeight ?? 0, rootRect.height);
      setLineAnchorShift(shift);
      onOverflowBelowChange?.(
        alignFirstLineToEnd ? Math.max(0, Math.ceil(shift + rootRect.height - rowHeight)) : 0
      );
    };
    measure();
    if (alignAddButtonToLineAnchor && !alignFirstLineToEnd) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    alignFirstLineToEnd,
    alignAddButtonToLineAnchor,
    editing,
    draft,
    text,
    readOnly,
    showAddButton,
    onOverflowBelowChange,
    lineAnchorCenter,
    lineAnchorRowHeight,
  ]);

  if (editing && !readOnly) {
    return (
      <div ref={rootRef} style={rootStyle} className={`${topGapClass}mb-0.5 flex ${alignClass} ${placementClassName}`}>
        <textarea
          data-stage-comment-body="true"
          ref={textareaRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (skipBlurCommitRef.current) {
              skipBlurCommitRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === "Escape") {
              e.preventDefault();
              skipBlurCommitRef.current = true;
              setDraft(value ?? "");
              setEditing(false);
              onEditingChange?.(false);
            }
          }}
          placeholder="在此输入演员提示/补充舞台提示"
          rows={1}
          style={editorWidth ? { width: editorWidth } : undefined}
          className={`${editorWidth ? "shrink-0" : "w-full max-w-xs"} ${compactLayout ? "min-h-[1.125rem]" : "min-h-7"} ${stageCommentLeadingClass} resize-none overflow-hidden border-b border-zinc-200 bg-transparent px-1 ${compactLayout ? "text-left" : "text-center"} font-stage text-sm italic text-zinc-500 outline-none placeholder:text-zinc-300 focus:border-zinc-400`}
        />
      </div>
    );
  }

  if (text) {
    const label = text
      .split(/\r\n|\r|\n/)
      .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
      .join("\n");
    return (
      <div ref={rootRef} style={rootStyle} className={`${topGapClass}mb-0.5 flex ${alignClass} ${placementClassName}`}>
        {readOnly ? (
          <span data-stage-comment-body="true" className={stageCommentTextClass}>{label}</span>
        ) : (
          <button
            data-stage-comment-body="true"
            type="button"
            onClick={openEditor}
            className={`${stageCommentTextClass} transition-colors hover:text-zinc-600`}
          >
            {label}
          </button>
        )}
      </div>
    );
  }

  if (readOnly || !showAddButton) return null;
  return (
    <div
      ref={rootRef}
      style={rootStyle}
      className={`${zeroHeightAddButton ? "mb-0 h-0 overflow-visible" : "mb-1"} flex ${addButtonAlignClass} ${placementClassName}`}
    >
      <button
        ref={addButtonRef}
        type="button"
        onClick={openEditor}
        title="添加演员提示/补充舞台提示"
        aria-label="添加演员提示/补充舞台提示"
        style={addButtonStyle}
        className={`relative flex h-4 w-4 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-zinc-100 hover:text-zinc-500 ${
          addButtonRevealOnHover ? "opacity-0 transition-opacity group-hover:opacity-100" : ""
        }`}
      >
        <span aria-hidden className="absolute left-1/2 top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-current" />
        <span aria-hidden className="absolute left-1/2 top-1/2 h-px w-[5px] -translate-x-1/2 -translate-y-1/2 rounded bg-current" />
        <span aria-hidden className="absolute left-1/2 top-1/2 h-[5px] w-px -translate-x-1/2 -translate-y-1/2 rounded bg-current" />
      </button>
    </div>
  );
}

// ─── Print ────────────────────────────────────────────────────────────────────

type PrintItem =
  | { kind: "sceneHeader"; scene: Scene }
  | { kind: "block"; block: Block; hideChar: boolean; leadingCharacterGap: boolean };

const PRINT_CHAR_NAME_HEIGHT = 22;
const PRINT_CHARACTER_GAP_HEIGHT = 10;
const PRINT_WRAPPER_PADDING_HEIGHT = 8;
const PRINT_TEXT_CLASS = "w-full break-words text-sm leading-7";
const PRINT_STAGE_COMMENT_CLASS = "font-stage text-sm italic leading-7 text-zinc-400 whitespace-pre-wrap";
const PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX: number = 1;

type PrintPageData = {
  items: PrintItem[];
  sceneLabel: string;
  pageNum: number;
};
type PrintHeaderMode = "all-left" | "all-right" | "first-right" | "first-left";
const PRINT_HEADER_MODES: PrintHeaderMode[] = ["all-left", "all-right", "first-right", "first-left"];
const PRINT_HEADER_MODE_LABELS: Record<PrintHeaderMode, string> = {
  "all-left": "页眉统一靠左",
  "all-right": "页眉统一靠右",
  "first-right": "首页页眉靠右",
  "first-left": "首页页眉靠左",
};

function computePrintPages(
  blocks: Block[],
  scenes: Scene[],
  heights: Record<string, number>,
  contentH: number
): { pages: PrintPageData[]; scenePageNums: Record<string, number> } {
  const pages: PrintPageData[] = [];
  const scenePageNums: Record<string, number> = {};
  let curItems: PrintItem[] = [];
  let curH = 0;
  let curLabel = "";
  let activeSceneLabel = "";
  let pageNum = 1;
  let curHasBlock = false;
  let prevTextBlock: Block | null = null;

  const flush = () => {
    if (curItems.length === 0) return;
    pages.push({ items: [...curItems], sceneLabel: curLabel, pageNum });
    pageNum++;
    curItems = [];
    curH = 0;
    curLabel = "";
    curHasBlock = false;
  };

  const addItem = (item: PrintItem, h: number) => {
    const forcedCharHeight = item.kind === "block" && item.hideChar && item.block.characterIds.length > 0
      ? PRINT_CHAR_NAME_HEIGHT + PRINT_WRAPPER_PADDING_HEIGHT
      : 0;
    let firstBlockOnPage = item.kind === "block" && !curHasBlock;
    const leadingGapHeight = item.kind === "block" && item.leadingCharacterGap && !firstBlockOnPage
      ? PRINT_CHARACTER_GAP_HEIGHT
      : 0;
    let nextH = h + leadingGapHeight + (firstBlockOnPage ? forcedCharHeight : 0);
    if (curH + nextH > contentH && curItems.length > 0) {
      flush();
      firstBlockOnPage = item.kind === "block";
      nextH = h + (firstBlockOnPage ? forcedCharHeight : 0);
    }
    const nextItem = firstBlockOnPage
      ? { ...item, hideChar: false, leadingCharacterGap: false }
      : item;
    curItems.push(nextItem);
    curH += nextH;
    if (item.kind === "block") {
      if (!curHasBlock) curLabel = activeSceneLabel;
      curHasBlock = true;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isTextBlock(block)) continue;
    const prev = prevTextBlock;
    const hideChar = shouldHideCharacterLabel(prev, block);
    const leadingCharacterGap = shouldShowCharacterGap(prev, block, hideChar);

    if (!block.sceneId) {
      activeSceneLabel = "";
    } else if (block.sceneId !== prev?.sceneId) {
      const scene = scenes.find((s) => s.id === block.sceneId);
      if (scene) {
        activeSceneLabel = scene.number;
        addItem({ kind: "sceneHeader", scene }, heights[`sh-${block.sceneId}`] ?? 52);
        if (!(scene.id in scenePageNums)) scenePageNums[scene.id] = pageNum;
      } else {
        activeSceneLabel = "";
      }
    }

    addItem({ kind: "block", block, hideChar, leadingCharacterGap }, heights[`b-${block.id}`] ?? 60);
    prevTextBlock = block;
  }

  flush();
  return { pages, scenePageNums };
}

function pageMapFromPrintPages(pages: PrintPageData[]): Record<string, number> {
  const pageMap: Record<string, number> = {};
  for (const page of pages) {
    for (const item of page.items) {
      if (item.kind === "block") pageMap[item.block.id] = page.pageNum;
    }
  }
  return pageMap;
}

function samePageMap(a: Record<string, number> | null, b: Record<string, number>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((key) => a[key] === b[key]);
}

function PrintMeasurementLayer({
  blocks,
  characters,
  scenes,
  contentW,
  compactLayout,
  stageDelimOpen,
  stageDelimClose,
  measureRef,
  onLayoutChange,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  contentW: number;
  compactLayout: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  measureRef: React.RefObject<HTMLDivElement | null>;
  onLayoutChange?: () => void;
}) {
  const characterById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const measuredBlocks = useMemo(() => blocks.filter(isTextBlock), [blocks]);

  const renderSceneHeader = (scene: Scene) => (
    <div className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-sm text-zinc-500">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
    </div>
  );

  const renderBlock = (block: Block, hideChar: boolean) => {
    const isStage = block.type === "stage";
    const sel = block.characterIds
      .map((id) => characterById.get(id))
      .filter((c): c is Character => !!c);
    const blockPaddingClass = isStage ? "py-0" : hideChar ? "py-0" : "py-1";
    const characterLabel = sel.map((c) => {
      const ann = block.characterAnnotations[c.id];
      return ann ? `${c.name}（${ann}）` : c.name;
    }).join("、");

    if (compactLayout && !isStage) {
      const stageCommentText = sel.length > 0 && block.stageComment?.trim()
        ? block.stageComment.trim()
            .split(/\r\n|\r|\n/)
            .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
            .join("\n")
        : "";
      return (
        <CompactPrintBlock
          block={block}
          blockPaddingClass={blockPaddingClass}
          characterLabel={characterLabel}
          showCharacterLabel={!hideChar && sel.length > 0}
          stageCommentText={stageCommentText}
          leadingCharacterGap={false}
          stageDelimOpen={stageDelimOpen}
          stageDelimClose={stageDelimClose}
          onLayoutChange={onLayoutChange}
        />
      );
    }

    const content = !isStage && sel.length > 0 && block.stageComment?.trim()
      ? `${block.stageComment.trim().split(/\r\n|\r|\n/).map((line) => `${stageDelimOpen}${line}${stageDelimClose}`).join("\n")}\n${block.content}`
      : block.content;

    return (
      <div className={`w-full ${blockPaddingClass}`}>
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {characterLabel}
          </div>
        )}
        <div
          className={`${PRINT_TEXT_CLASS} ${
            isStage
              ? "font-stage text-left italic text-zinc-500"
              : block.lyric
              ? "font-lyric text-center font-bold uppercase text-zinc-800"
              : "font-script text-center text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
    );
  };

  return (
    <div
      ref={measureRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: -9999,
        top: 0,
        width: contentW,
        visibility: "hidden",
      }}
    >
      {measuredBlocks.map((block, i) => {
        const prev = i > 0 ? measuredBlocks[i - 1] : null;
        const hideChar = shouldHideCharacterLabel(prev, block);
        const sceneStart = isSceneBoundaryBlock(block, prev);
        return (
          <div key={block.id}>
            {sceneStart && (() => {
              const sceneId = block.sceneId;
              if (sceneId === null) return null;
              const scene = sceneById.get(sceneId);
              return scene ? (
                <div data-mid={`sh-${sceneId}`}>
                  {renderSceneHeader(scene)}
                </div>
              ) : null;
            })()}
            <div data-mid={`b-${block.id}`}>{renderBlock(block, hideChar)}</div>
          </div>
        );
      })}
    </div>
  );
}

function PrintPaginationMeasure({
  blocks,
  characters,
  scenes,
  pageLayout,
  stageDelimOpen,
  stageDelimClose,
  textLayoutMode,
  onPageMapChange,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  onPageMapChange: (pageMap: Record<string, number>) => void;
}) {
  const cfg = PAGE_CONFIGS[pageLayout];
  const contentW = cfg.width - cfg.marginX * 2;
  const contentH = cfg.height - cfg.marginTop - cfg.marginBottom;
  const compactLayout = textLayoutMode === "compact";
  const measureRef = useRef<HTMLDivElement>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const requestLayoutRemeasure = useCallback(() => {
    if (remeasureTimerRef.current) return;
    remeasureTimerRef.current = setTimeout(() => {
      remeasureTimerRef.current = null;
      setLayoutMeasureTick((tick) => tick + 1);
    }, 0);
  }, []);

  useEffect(() => {
    return () => {
      if (remeasureTimerRef.current) clearTimeout(remeasureTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const heights: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
      if (node.dataset.mid) heights[node.dataset.mid] = node.offsetHeight;
    });
    const result = computePrintPages(blocks, scenes, heights, contentH);
    onPageMapChange(pageMapFromPrintPages(result.pages));
  }, [blocks, characters, scenes, contentW, contentH, textLayoutMode, stageDelimOpen, stageDelimClose, layoutMeasureTick, onPageMapChange]);

  return (
    <PrintMeasurementLayer
      blocks={blocks}
      characters={characters}
      scenes={scenes}
      contentW={contentW}
      compactLayout={compactLayout}
      stageDelimOpen={stageDelimOpen}
      stageDelimClose={stageDelimClose}
      measureRef={measureRef}
      onLayoutChange={requestLayoutRemeasure}
    />
  );
}

function PrintPage({
  cfg,
  header,
  headerAlign = "left",
  pageNum,
  isToc,
  children,
}: {
  cfg: PageConfig;
  header: string;
  headerAlign?: "left" | "right";
  pageNum: number | null;
  isToc?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="print-page relative bg-white shadow-lg print:shadow-none"
      style={{ width: cfg.width, height: cfg.height }}
    >
      {/* Header band */}
      <div
        className={`absolute flex items-center border-b border-zinc-100 ${
          headerAlign === "right" ? "justify-end" : "justify-start"
        }`}
        style={{
          top: cfg.marginTop - cfg.headerHeight,
          left: cfg.marginX,
          right: cfg.marginX,
          height: cfg.headerHeight,
        }}
      >
        {!isToc && header && (
          <span className="text-[10px] font-medium tracking-widest text-zinc-400 uppercase">
            {header}
          </span>
        )}
      </div>

      {/* Content area */}
      <div
        className="absolute overflow-hidden"
        style={{
          top: cfg.marginTop,
          bottom: cfg.marginBottom,
          left: cfg.marginX,
          right: cfg.marginX,
        }}
      >
        {children}
      </div>

      {/* Footer band */}
      <div
        className="absolute flex items-center justify-center"
        style={{
          bottom: cfg.marginBottom - cfg.footerHeight,
          left: cfg.marginX,
          right: cfg.marginX,
          height: cfg.footerHeight,
        }}
      >
        {pageNum !== null && (
          <span className="text-xs text-zinc-500">— {pageNum} —</span>
        )}
      </div>
    </div>
  );
}

function PrintHeaderModeMenu({
  headerMode,
  onHeaderModeChange,
}: {
  headerMode: PrintHeaderMode;
  onHeaderModeChange: (mode: PrintHeaderMode) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        title="选择页眉位置"
      >
        <span>{PRINT_HEADER_MODE_LABELS[headerMode]}</span>
        <Chevron />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 w-36 rounded-xl border border-zinc-100 bg-white py-1 shadow-md">
          {PRINT_HEADER_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => { onHeaderModeChange(mode); setOpen(false); }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-zinc-50 ${
                headerMode === mode ? "font-medium text-zinc-900" : "text-zinc-500"
              }`}
            >
              <span>{PRINT_HEADER_MODE_LABELS[mode]}</span>
              {headerMode === mode && <span className="text-[10px] text-zinc-900">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function getElementLineBounds(el: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  range.detach();

  if (rects.length === 0) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }

  const lines: DOMRect[] = [];
  for (const rect of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(rect.top - last.top) < 2) {
      const left = Math.min(last.left, rect.left);
      const top = Math.min(last.top, rect.top);
      const right = Math.max(last.right, rect.right);
      const bottom = Math.max(last.bottom, rect.bottom);
      lines[lines.length - 1] = new DOMRect(left, top, right - left, bottom - top);
    } else {
      lines.push(new DOMRect(rect.left, rect.top, rect.width, rect.height));
    }
  }
  return lines;
}

function CompactPrintBlock({
  block,
  blockPaddingClass,
  characterLabel,
  showCharacterLabel,
  stageCommentText,
  leadingCharacterGap,
  stageDelimOpen,
  stageDelimClose,
  onLayoutChange,
}: {
  block: Block;
  blockPaddingClass: string;
  characterLabel: string;
  showCharacterLabel: boolean;
  stageCommentText: string;
  leadingCharacterGap: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  onLayoutChange?: () => void;
}) {
  const characterColumnRef = useRef<HTMLDivElement | null>(null);
  const firstLineRef = useRef<HTMLDivElement | null>(null);
  const lastNotifiedOffsetRef = useRef(0);
  const [firstLineOffset, setFirstLineOffset] = useState(0);

  useLayoutEffect(() => {
    const characterEl = characterColumnRef.current;
    const firstLineEl = firstLineRef.current;
    if (!characterEl || !firstLineEl || !showCharacterLabel) {
      setFirstLineOffset((prev) => {
        if (prev === 0) return prev;
        return 0;
      });
      return;
    }

    const characterLines = getElementLineBounds(characterEl);
    const firstLines = getElementLineBounds(firstLineEl);
    const targetLine = characterLines[characterLines.length - 1];
    const currentLine = firstLines[0];
    if (!targetLine || !currentLine) return;

    const targetCenter = targetLine.top + targetLine.height / 2 - PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX;
    const currentCenter = currentLine.top + currentLine.height / 2;
    const nextOffset = Math.max(
      0,
      Math.round(firstLineOffset + targetCenter - currentCenter)
    );

    setFirstLineOffset((prev) => {
      if (Math.abs(prev - nextOffset) < 1) return prev;
      return nextOffset;
    });
  }, [block.id, characterLabel, showCharacterLabel, stageCommentText, firstLineOffset]);

  useEffect(() => {
    if (!onLayoutChange) return;
    if (lastNotifiedOffsetRef.current === firstLineOffset) return;
    lastNotifiedOffsetRef.current = firstLineOffset;
    onLayoutChange();
  }, [firstLineOffset, onLayoutChange]);

  const firstLineStyle: React.CSSProperties | undefined = firstLineOffset > 0
    ? { marginTop: firstLineOffset }
    : undefined;
  const characterLabelStyle: React.CSSProperties | undefined =
    PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX !== 0
      ? { transform: `translateY(${PRINT_COMPACT_CHARACTER_OPTICAL_OFFSET_PX}px)` }
      : undefined;

  return (
    <div key={block.id} className={`w-full ${blockPaddingClass}`}>
      {leadingCharacterGap && <div className="h-2.5" aria-hidden="true" />}
      <div className="grid grid-cols-[7.5rem_1rem_minmax(0,1fr)] items-start gap-x-2 text-left">
        <div className="col-start-1 row-start-1 min-w-0 text-right">
          {showCharacterLabel && (
            <div
              ref={characterColumnRef}
              style={characterLabelStyle}
              className="max-w-full break-words text-sm font-bold leading-7 tracking-[0.12em] text-zinc-800"
            >
              {characterLabel}
            </div>
          )}
        </div>
        {stageCommentText && (
          <div
            ref={firstLineRef}
            style={firstLineStyle}
            className={`col-start-3 row-start-1 self-start ${PRINT_STAGE_COMMENT_CLASS}`}
          >
            {stageCommentText}
          </div>
        )}
        <div
          ref={stageCommentText ? undefined : firstLineRef}
          style={stageCommentText ? undefined : firstLineStyle}
          className={`col-start-3 min-w-0 ${stageCommentText ? "row-start-2" : "row-start-1"} ${PRINT_TEXT_CLASS} ${
            block.lyric
              ? "font-lyric font-bold uppercase text-zinc-800"
              : "font-script text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(block.content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
    </div>
  );
}

function PrintPreview({
  blocks,
  characters,
  scenes,
  pageLayout,
  stageDelimOpen,
  stageDelimClose,
  textLayoutMode,
  canEditTextLayout,
  onTextLayoutModeChange,
  onClose,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  pageLayout: PageLayout;
  stageDelimOpen: string;
  stageDelimClose: string;
  textLayoutMode: ScriptTextLayoutMode;
  canEditTextLayout: boolean;
  onTextLayoutModeChange: (mode: ScriptTextLayoutMode) => void;
  onClose: () => void;
}) {
  const cfg = PAGE_CONFIGS[pageLayout];
  const contentW = cfg.width - cfg.marginX * 2;
  const contentH = cfg.height - cfg.marginTop - cfg.marginBottom;
  const compactLayout = textLayoutMode === "compact";

  const measureRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{
    pages: PrintPageData[];
    scenePageNums: Record<string, number>;
    layoutMode: ScriptTextLayoutMode;
    measureTick: number;
  } | null>(null);
  const [forceLoadingNotice, setForceLoadingNotice] = useState(false);
  const forceLoadingNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutMeasureTick, setLayoutMeasureTick] = useState(0);
  const [headerMode, setHeaderMode] = useState<PrintHeaderMode>("first-right");
  const requestLayoutRemeasure = useCallback(() => {
    if (remeasureTimerRef.current) return;
    remeasureTimerRef.current = setTimeout(() => {
      remeasureTimerRef.current = null;
      setData(null);
      setLayoutMeasureTick((tick) => tick + 1);
    }, 0);
  }, []);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const heights: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
      if (node.dataset.mid) heights[node.dataset.mid] = node.offsetHeight;
    });
    setData({
      ...computePrintPages(blocks, scenes, heights, contentH),
      layoutMode: textLayoutMode,
      measureTick: layoutMeasureTick,
    });
  }, [blocks, characters, scenes, contentW, contentH, textLayoutMode, stageDelimOpen, stageDelimClose, layoutMeasureTick]);

  const printPreviewReady = !!data &&
    data.layoutMode === textLayoutMode &&
    data.measureTick === layoutMeasureTick;
  const showLoadingNotice = forceLoadingNotice || !printPreviewReady;

  useEffect(() => {
    if (!forceLoadingNotice || !printPreviewReady) return;
    if (forceLoadingNoticeTimerRef.current) clearTimeout(forceLoadingNoticeTimerRef.current);
    forceLoadingNoticeTimerRef.current = setTimeout(() => {
      setForceLoadingNotice(false);
      forceLoadingNoticeTimerRef.current = null;
    }, 250);
  }, [forceLoadingNotice, printPreviewReady]);

  useEffect(() => {
    return () => {
      if (forceLoadingNoticeTimerRef.current) clearTimeout(forceLoadingNoticeTimerRef.current);
      if (layoutSwitchTimerRef.current) clearTimeout(layoutSwitchTimerRef.current);
      if (remeasureTimerRef.current) clearTimeout(remeasureTimerRef.current);
    };
  }, []);

  const handleTextLayoutModeToggle = () => {
    if (!canEditTextLayout || !printPreviewReady) return;
    const nextLayoutMode = compactLayout ? "center" : "compact";
    flushSync(() => {
      setForceLoadingNotice(true);
      setData(null);
    });
    if (layoutSwitchTimerRef.current) clearTimeout(layoutSwitchTimerRef.current);
    layoutSwitchTimerRef.current = setTimeout(() => {
      layoutSwitchTimerRef.current = null;
      onTextLayoutModeChange(nextLayoutMode);
    }, 0);
  };

  const getHeaderAlign = (pageNum: number): "left" | "right" => {
    if (headerMode === "all-left") return "left";
    if (headerMode === "all-right") return "right";
    const firstPageRight = headerMode === "first-right";
    return pageNum % 2 === (firstPageRight ? 1 : 0) ? "right" : "left";
  };

  // Scenes in document order for TOC
  const tocScenes: Scene[] = [];
  for (const b of blocks) {
    if (b.sceneId) {
      const s = scenes.find((sc) => sc.id === b.sceneId);
      if (s && !tocScenes.some((ts) => ts.id === s.id)) tocScenes.push(s);
    }
  }

  const renderSceneHeader = (scene: Scene, key: string) => (
    <div key={key} className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-sm text-zinc-500">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
    </div>
  );

  const renderBlock = (
    block: Block,
    hideChar: boolean,
    leadingCharacterGap = false,
    continuesToHiddenCharacter = false,
    endsHiddenCharacterRun = false,
    measureLayout = false,
  ) => {
    const isStage = block.type === "stage";
    const sel = characters.filter((c) => block.characterIds.includes(c.id));
    const blockPaddingClass = isStage
      ? "py-0"
      : hideChar
        ? endsHiddenCharacterRun ? "pt-0 pb-1" : "py-0"
        : continuesToHiddenCharacter ? "pt-1 pb-0" : "py-1";
    const characterLabel = sel.map((c) => {
      const ann = block.characterAnnotations[c.id];
      return ann ? `${c.name}（${ann}）` : c.name;
    }).join("、");

    if (compactLayout && !isStage) {
      const stageCommentText = sel.length > 0 && block.stageComment?.trim()
        ? block.stageComment.trim()
            .split(/\r\n|\r|\n/)
            .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
            .join("\n")
        : "";
      return (
        <CompactPrintBlock
          key={block.id}
          block={block}
          blockPaddingClass={blockPaddingClass}
          characterLabel={characterLabel}
          showCharacterLabel={!hideChar && sel.length > 0}
          stageCommentText={stageCommentText}
          leadingCharacterGap={leadingCharacterGap}
          stageDelimOpen={stageDelimOpen}
          stageDelimClose={stageDelimClose}
          onLayoutChange={measureLayout ? requestLayoutRemeasure : undefined}
        />
      );
    }

    const content = !isStage && sel.length > 0 && block.stageComment?.trim()
      ? `${block.stageComment.trim().split(/\r\n|\r|\n/).map((line) => `${stageDelimOpen}${line}${stageDelimClose}`).join("\n")}\n${block.content}`
      : block.content;

    return (
      <div key={block.id} className={`w-full ${blockPaddingClass}`}>
        {leadingCharacterGap && <div className="h-2.5" aria-hidden="true" />}
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {characterLabel}
          </div>
        )}
        <div
          className={`${PRINT_TEXT_CLASS} ${
            isStage
              ? "font-stage text-left italic text-zinc-500"
              : block.lyric
              ? "font-lyric text-center font-bold uppercase text-zinc-800"
              : "font-script text-center text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(content, stageDelimOpen, stageDelimClose) || "　" }}
        />
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-300 print:static print:block print:bg-white">
      {/* Preview toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 print:hidden">
        <span className="text-sm font-semibold text-zinc-700">打印预览</span>
        <div className="flex items-center gap-3">
          <PrintHeaderModeMenu headerMode={headerMode} onHeaderModeChange={setHeaderMode} />
          <button
            onClick={handleTextLayoutModeToggle}
            disabled={!canEditTextLayout || !printPreviewReady}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
              canEditTextLayout && printPreviewReady
                ? "text-zinc-600 hover:bg-zinc-100"
                : "cursor-not-allowed text-zinc-300"
            }`}
            title={
              !canEditTextLayout
                ? "无权修改剧本排版模式"
                : printPreviewReady
                  ? "保存为所有人共用的剧本排版模式"
                  : "打印预览加载中"
            }
          >
            <span>紧凑排版</span>
            <ModeSwitch
              active={compactLayout}
              activeClassName="bg-[#637ca1]"
            />
          </button>
          <button
            onClick={() => window.print()}
            className="rounded-md bg-zinc-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
          >
            打印 / 导出 PDF
          </button>
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Scrollable page stack */}
      <div className="relative flex-1 overflow-auto print:overflow-visible print:h-auto">
        {showLoadingNotice && (
          <div className="pointer-events-none fixed inset-x-0 bottom-0 top-14 z-[60] flex items-center justify-center bg-zinc-300 print:hidden">
            <span className="rounded-md border border-zinc-200 bg-white/95 px-4 py-2 text-sm font-medium text-zinc-500 shadow-lg">
              加载中...
            </span>
          </div>
        )}
        <div className="mx-auto flex flex-col items-center gap-6 py-8 print:gap-0 print:py-0">
          <PrintMeasurementLayer
            blocks={blocks}
            characters={characters}
            scenes={scenes}
            contentW={contentW}
            compactLayout={compactLayout}
            stageDelimOpen={stageDelimOpen}
            stageDelimClose={stageDelimClose}
            measureRef={measureRef}
            onLayoutChange={requestLayoutRemeasure}
          />

          {/* TOC page */}
          {tocScenes.length > 0 && (
            <PrintPage cfg={cfg} header="" pageNum={null} isToc>
              <div className="pt-6">
                <h1 className="mb-10 text-center text-base font-bold tracking-[0.25em] text-zinc-700">
                  目录
                </h1>
                <div className="flex flex-col gap-3">
                  {tocScenes.map((scene) => (
                    <div key={scene.id} className="flex items-baseline gap-2">
                      <span className="min-w-[4rem] text-sm font-bold text-zinc-500">
                        {scene.number || "—"}
                      </span>
                      <span className="text-sm text-zinc-600">{scene.name}</span>
                      <span className="mx-2 mb-1 flex-1 border-b border-dotted border-zinc-300" />
                      <span className="min-w-[2rem] text-right text-sm tabular-nums text-zinc-400">
                        {data?.scenePageNums[scene.id] ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </PrintPage>
          )}

          {/* Content pages */}
          {data?.pages.map((page, idx) => {
            const continuesToHiddenCharacter = new Set<string>();
            const endsHiddenCharacterRun = new Set<string>();
            let nextBlockHidden = false;
            let hasNextBlock = false;
            for (let i = page.items.length - 1; i >= 0; i--) {
              const item = page.items[i];
              if (item.kind !== "block") continue;
              if (!item.hideChar && hasNextBlock && nextBlockHidden) continuesToHiddenCharacter.add(item.block.id);
              if (item.hideChar && (!hasNextBlock || !nextBlockHidden)) endsHiddenCharacterRun.add(item.block.id);
              nextBlockHidden = item.hideChar;
              hasNextBlock = true;
            }
            return (
              <PrintPage
                key={idx}
                cfg={cfg}
                header={page.sceneLabel}
                headerAlign={getHeaderAlign(page.pageNum)}
                pageNum={page.pageNum}
              >
                {page.items.map((item, iIdx) =>
                  item.kind === "sceneHeader"
                    ? renderSceneHeader(item.scene, `sh-${item.scene.id}-${iIdx}`)
                    : renderBlock(
                        item.block,
                        item.hideChar,
                        item.leadingCharacterGap,
                        continuesToHiddenCharacter.has(item.block.id),
                        endsHiddenCharacterRun.has(item.block.id),
                        false,
                      )
                )}
              </PrintPage>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Presence helpers ─────────────────────────────────────────────────────────

type RemotePresence = {
  clientId: string;
  userName: string;
  color: string;
  blockId: string | null;
};

// ─── Comment types ────────────────────────────────────────────────────────────

type Mention = { openId: string; name: string };

type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  openId: string;
  authorName: string;
  body: string;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

type CommentBlockCaption = {
  label: string;
  body: string;
};

type SideBlockPanelNavigation = {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

type SideBlockPanelNavigationTargets = {
  previousBlockId: string | null;
  nextBlockId: string | null;
};

type BlockAssetBubbleItem = {
  id: string;
  name: string | null;
  fileName: string;
};

const EMPTY_COMMENTS: Comment[] = [];
const EMPTY_BLOCK_ASSETS: BlockAssetBubbleItem[] = [];
const COMMENT_BUBBLE_MIN_WIDTH_PX = 135;
const COMMENT_BUBBLE_MIN_GUTTER_PX = 170;
const SPEECH_TAIL_PIN_OFFSET_PX = 96;
const SPEECH_TAIL_BASE_HALF_PX = 14;
const SPEECH_TAIL_EDGE_INSET_PX = 24;
const SIDE_PANEL_TOP_PX = 56;
const SIDE_PANEL_MIN_WIDTH_PX = 360;
const SIDE_PANEL_MAX_WIDTH_PX = 576;
const SIDE_PANEL_GUTTER_PADDING_PX = 15;

function buildCommentBlockCaption(block: Block, characters: Character[], index: number): CommentBlockCaption {
  const normalizedBlockContent = block.content.replace(/\s+/g, " ").trim();
  const blockContentPreview = normalizedBlockContent.slice(0, 20);
  const blockContentSuffix = normalizedBlockContent.length > blockContentPreview.length ? "..." : "";
  const characterCaption = block.type === "stage"
    ? ""
    : block.characterIds
        .map(id => characters.find(c => c.id === id)?.name)
        .filter((name): name is string => !!name)
        .join("/");

  return {
    label: `【${index + 1}】`,
    body: `${characterCaption ? `${characterCaption}: ` : ""}${blockContentPreview || "（空）"}${blockContentSuffix}`,
  };
}

function findSideBlockPanelNavigationTargets(
  blocks: Block[],
  activeBlockId: string | null,
  hasPanelItem: (blockId: string) => boolean,
): SideBlockPanelNavigationTargets {
  if (!activeBlockId) return { previousBlockId: null, nextBlockId: null };
  const activeIndex = blocks.findIndex(block => block.id === activeBlockId);
  if (activeIndex < 0) return { previousBlockId: null, nextBlockId: null };

  let previousBlockId: string | null = null;
  let nextBlockId: string | null = null;
  for (let index = activeIndex - 1; index >= 0; index--) {
    if (hasPanelItem(blocks[index].id)) {
      previousBlockId = blocks[index].id;
      break;
    }
  }
  for (let index = activeIndex + 1; index < blocks.length; index++) {
    if (hasPanelItem(blocks[index].id)) {
      nextBlockId = blocks[index].id;
      break;
    }
  }
  return { previousBlockId, nextBlockId };
}

function SpeechTail({
  offsetY = 0,
  top = "50%",
  fillClassName = "fill-white",
}: {
  offsetY?: number;
  top?: number | string;
  fillClassName?: string;
}) {
  const rawPointOffset = -Math.round(offsetY);
  const width = 24;
  const overlap = 4;
  const baseHalf = SPEECH_TAIL_BASE_HALF_PX;
  const padding = 16;
  const pointSlideLimit = SPEECH_TAIL_PIN_OFFSET_PX;
  const baseSlideLimit = 48;
  const isPinned = Math.abs(offsetY) >= pointSlideLimit;
  const pointOffset = Math.max(-pointSlideLimit, Math.min(pointSlideLimit, rawPointOffset));
  const baseOffset = Math.max(-baseSlideLimit, Math.min(baseSlideLimit, rawPointOffset * 0.65));
  const height = isPinned ? 36 : Math.max(32, (Math.max(Math.abs(pointOffset), Math.abs(baseOffset)) + padding) * 2);
  const centerY = height / 2;
  const pinnedFromTop = offsetY > 0;
  const pointY = isPinned ? (pinnedFromTop ? 2 : height - 2) : centerY + pointOffset;
  const baseY = isPinned ? pointY : centerY + baseOffset;
  const baseTopY = isPinned && pinnedFromTop ? pointY : isPinned ? pointY - baseHalf * 2 : baseY - baseHalf;
  const baseBottomY = isPinned && !pinnedFromTop ? pointY : isPinned ? pointY + baseHalf * 2 : baseY + baseHalf;
  const topValue = typeof top === "number" ? `${top}px` : top;

  return (
    <svg
      className="pointer-events-none absolute left-0 z-[5] overflow-visible"
      style={{
        top: topValue,
        width,
        height,
        transform: `translate(${-width + overlap}px, ${-height / 2}px)`,
      }}
      aria-hidden="true"
    >
      <polygon
        className={fillClassName}
        points={`0,${pointY} ${width},${baseTopY} ${width},${baseBottomY}`}
        stroke="#e4e4e7"
        strokeWidth="1"
      />
    </svg>
  );
}

function useBlockSpeechTail(blockId: string) {
  const [pointerTop, setPointerTop] = useState(SPEECH_TAIL_EDGE_INSET_PX);
  const [pointerOffsetY, setPointerOffsetY] = useState(0);

  useLayoutEffect(() => {
    const updatePointer = () => {
      const panelHeight = window.innerHeight - SIDE_PANEL_TOP_PX;
      const blockEl = document.getElementById(`block-${blockId}`);
      if (!blockEl) {
        setPointerTop(SPEECH_TAIL_EDGE_INSET_PX);
        setPointerOffsetY(0);
        return;
      }
      const rect = blockEl.getBoundingClientRect();
      const raw = rect.top + rect.height / 2 - SIDE_PANEL_TOP_PX;
      const minPointerTop = SPEECH_TAIL_EDGE_INSET_PX;
      const maxPointerTop = Math.max(minPointerTop, panelHeight - minPointerTop);
      if (raw - SPEECH_TAIL_BASE_HALF_PX <= minPointerTop) {
        setPointerTop(minPointerTop);
        setPointerOffsetY(SPEECH_TAIL_PIN_OFFSET_PX);
        return;
      }
      if (raw + SPEECH_TAIL_BASE_HALF_PX >= maxPointerTop) {
        setPointerTop(maxPointerTop);
        setPointerOffsetY(-SPEECH_TAIL_PIN_OFFSET_PX);
        return;
      }
      setPointerTop(raw);
      setPointerOffsetY(0);
    };
    updatePointer();
    window.addEventListener("resize", updatePointer);
    window.addEventListener("scroll", updatePointer, true);
    return () => {
      window.removeEventListener("resize", updatePointer);
      window.removeEventListener("scroll", updatePointer, true);
    };
  }, [blockId]);

  return { pointerTop, pointerOffsetY };
}

function CommentBubble({
  comments,
  assets,
  active,
  offsetY = 0,
  hasGutterSpace,
  maxWidth,
  blockLabel,
  captionBody,
  onCommentClick,
  onAssetClick,
  onHoverChange,
}: {
  comments: Comment[];
  assets: BlockAssetBubbleItem[];
  active: boolean;
  offsetY?: number;
  hasGutterSpace: boolean;
  maxWidth: number;
  blockLabel: string;
  captionBody: string;
  onCommentClick: () => void;
  onAssetClick: () => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  if ((comments.length === 0 && assets.length === 0) || !hasGutterSpace) return null;

  if (active) return null;

  const sortedComments = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const childrenByParent = new Map<string, Comment[]>();
  for (const comment of sortedComments) {
    if (!comment.parentId) continue;
    const replies = childrenByParent.get(comment.parentId) ?? [];
    replies.push(comment);
    childrenByParent.set(comment.parentId, replies);
  }
  const orderedComments: Array<{ comment: Comment; reply: boolean }> = [];
  for (const comment of sortedComments.filter(c => c.parentId === null)) {
    orderedComments.push({ comment, reply: false });
    for (const reply of childrenByParent.get(comment.id) ?? []) {
      orderedComments.push({ comment: reply, reply: true });
    }
  }
  for (const orphanReply of sortedComments.filter(c => c.parentId !== null && !sortedComments.some(parent => parent.id === c.parentId))) {
    orderedComments.push({ comment: orphanReply, reply: true });
  }
  const maxVisible = 4;
  const visibleCommentLimit = assets.length > 0 ? Math.min(3, orderedComments.length) : maxVisible;
  const visibleComments = orderedComments.slice(0, visibleCommentLimit);
  const visibleAssets = assets.slice(0, maxVisible - visibleComments.length);
  const hiddenCommentCount = orderedComments.length - visibleComments.length;
  const hiddenAssetCount = assets.length - visibleAssets.length;
  const defaultAction = comments.length > 0 ? onCommentClick : onAssetClick;
  const handleClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  return (
    <div
      className="absolute left-full top-1/2 z-10 ml-6 hover:z-40 focus-within:z-40"
      style={{ transform: `translateY(calc(-50% + ${offsetY}px))` }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div
        className="relative z-10 flex max-h-40 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-colors hover:border-zinc-300"
        style={{ width: maxWidth, minWidth: COMMENT_BUBBLE_MIN_WIDTH_PX }}
      >
        <button
          type="button"
          onClick={(e) => handleClick(e, defaultAction)}
          className="shrink-0 truncate whitespace-nowrap border-b border-zinc-100 bg-zinc-100 px-2.5 py-1 text-left text-[10px] font-medium text-zinc-600"
          title={`${blockLabel} ${captionBody}`}
        >
          <span className="font-bold text-zinc-800">{blockLabel}</span>{" "}
          <span>{captionBody}</span>
        </button>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {(visibleComments.length > 0 || hiddenCommentCount > 0) && (
            <div
              className={`flex shrink-0 flex-col gap-0.5 px-2.5 py-1.5 transition-colors hover:bg-zinc-50 focus-within:bg-zinc-50 ${hiddenCommentCount > 0 ? "relative pr-10" : ""}`}
              title="打开评论"
            >
              {visibleComments.map(({ comment, reply }) => (
                <button
                  key={comment.id}
                  type="button"
                  onClick={(e) => handleClick(e, onCommentClick)}
                  className={`line-clamp-1 shrink-0 text-left text-[11px] leading-snug text-zinc-700 ${reply ? "pl-3 text-zinc-500" : ""}`}
                >
                  {reply && <span className="text-zinc-400">↳ </span>}
                  <span className="font-semibold text-zinc-900">{comment.authorName}: </span>
                  <span className="font-normal">{comment.body.trim() || "（空评论）"}</span>
                </button>
              ))}
              {hiddenCommentCount > 0 && (
                <button
                  type="button"
                  onClick={(e) => handleClick(e, onCommentClick)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold leading-3 text-zinc-500 shadow-sm hover:border-zinc-300 hover:text-zinc-700"
                >
                  +{hiddenCommentCount}
                </button>
              )}
            </div>
          )}
          {visibleComments.length > 0 && visibleAssets.length > 0 && (
            <div className="shrink-0 border-t border-zinc-300" aria-hidden="true" />
          )}
          {(visibleAssets.length > 0 || hiddenAssetCount > 0) && (
            <div
              className={`flex shrink-0 flex-col gap-0.5 px-2.5 py-1.5 transition-colors hover:bg-zinc-50 focus-within:bg-zinc-50 ${hiddenAssetCount > 0 ? "relative pr-10" : ""}`}
              title="打开附件"
            >
              {visibleAssets.map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={(e) => handleClick(e, onAssetClick)}
                  className="line-clamp-1 shrink-0 text-left text-[11px] leading-snug text-zinc-700"
                >
                  <span className="font-semibold text-zinc-900">附件: </span>
                  <span className="font-normal">{asset.name ?? asset.fileName}</span>
                </button>
              ))}
              {hiddenAssetCount > 0 && (
                <button
                  type="button"
                  onClick={(e) => handleClick(e, onAssetClick)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold leading-3 text-zinc-500 shadow-sm hover:border-zinc-300 hover:text-zinc-700"
                >
                  +{hiddenAssetCount}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PRESENCE_COLORS = [
  "#E53E3E", "#DD6B20", "#D69E2E", "#38A169",
  "#3182CE", "#805AD5", "#D53F8C", "#00B5D8",
];
const EDITABLE_MODE_VISIBLE_PRESENCE_AVATARS = 3;
const REHEARSAL_MODE_VISIBLE_PRESENCE_AVATARS = 5;

function presenceColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = ((h * 31) + clientId.charCodeAt(i)) & 0xffff;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length];
}

function getOrCreateClientId(): string {
  const key = "presence_client_id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(key, id); }
  return id;
}

function anonymousName(clientId: string): string {
  return "访客 " + clientId.slice(-4).toUpperCase();
}

function PresenceAvatar({ name, color, title }: { name: string; color: string; title?: string }) {
  return (
    <div
      title={title ?? name}
      style={{ backgroundColor: color }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
    >
      {name.slice(0, 1)}
    </div>
  );
}

// ─── Server-state merge ───────────────────────────────────────────────────────

function mergeServerBlocks(
  local: Block[],
  serverBlocks: Block[],
  synced: ScriptState | null
): Block[] {
  const syncedMap = new Map((synced?.blocks ?? []).map(b => [b.id, b]));
  const localMap = new Map(local.map(b => [b.id, b]));
  const projectedLocalMap = new Map(normalizeScriptBlockStream(local).map(b => [b.id, b]));
  const syncedBlocks = synced?.blocks ?? [];
  const localOrderDirty = !!synced && (
    local.length !== syncedBlocks.length ||
    local.some((b, i) => b.id !== syncedBlocks[i]?.id)
  );

  const isDirty = (b: Block): boolean => {
    const s = syncedMap.get(b.id);
    if (!s) return true;
    const projected = projectedLocalMap.get(b.id) ?? b;
    return (
      projected.content !== s.content ||
      (projected.stageComment ?? "") !== (s.stageComment ?? "") ||
      projected.type !== s.type ||
      projected.lyric !== s.lyric ||
      (projected.forceShowCharacterName ?? false) !== (s.forceShowCharacterName ?? false) ||
      projected.rehearsalMark !== s.rehearsalMark ||
      projected.sceneId !== s.sceneId ||
      projected.characterIds.length !== s.characterIds.length ||
      projected.characterIds.some((id, i) => id !== s.characterIds[i]) ||
      projected.characterIds.some((id) => (projected.characterAnnotations[id] ?? "") !== (s.characterAnnotations[id] ?? ""))
    );
  };

  if (localOrderDirty) {
    const serverMap = new Map(serverBlocks.map(b => [b.id, b]));
    const result = local.map(lb => {
      const sb = serverMap.get(lb.id);
      return isDirty(lb) ? lb : (sb ?? lb);
    });
    for (const sb of serverBlocks) {
      if (!localMap.has(sb.id)) result.push(sb);
    }
    return result;
  }

  // Server ordering is authoritative when local ordering has no unsynced edits.
  const result: Block[] = serverBlocks.map(sb => {
    const loc = localMap.get(sb.id);
    return loc && isDirty(loc) ? loc : sb;
  });

  // Keep locally-new blocks not yet on server
  const serverIds = new Set(serverBlocks.map(b => b.id));
  for (const loc of local) {
    if (!serverIds.has(loc.id) && isDirty(loc)) result.push(loc);
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtmlText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function _sameCharacters(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

function shouldHideCharacterLabel(prev: Block | null, block: Block): boolean {
  if (block.forceShowCharacterName) return false;
  if (!prev || prev.type !== "dialogue" || block.type !== "dialogue") return false;
  if (block.sceneId !== prev.sceneId) return false;
  if (block.rehearsalMark !== prev.rehearsalMark) return false;
  return _sameCharacters(prev.characterIds, block.characterIds);
}

function shouldShowCharacterGap(prev: Block | null, block: Block, hideChar: boolean): boolean {
  if (!prev) return false;
  if (isMarkerBlock(prev) || isMarkerBlock(block)) return false;
  if (block.type === "stage") return prev.type !== "stage";
  if (block.type === "dialogue" && block.characterIds.length === 0) {
    return !(
      prev.type === "dialogue" &&
      prev.characterIds.length === 0 &&
      block.sceneId === prev.sceneId &&
      block.rehearsalMark === prev.rehearsalMark
    );
  }
  return block.type === "dialogue" && block.characterIds.length > 0 && !hideChar;
}

function shouldShowSceneEndGap(prev: Block | null, block: Block): boolean {
  if (!prev || isMarkerBlock(prev)) return false;
  return block.type === "chapter_marker" || block.type === "scene_marker";
}

function isSceneBoundaryBlock(block: Block, prev: Block | null): boolean {
  if (isMarkerBlock(block)) return block.type === "chapter_marker" || block.type === "scene_marker";
  if (prev && isMarkerBlock(prev)) return false;
  return block.sceneId !== null && block.sceneId !== prev?.sceneId;
}

function expandLegacyMarkersToBlocks(blocks: Block[], scenes: Scene[] = []): Block[] {
  if (blocks.some(isMarkerBlock)) {
    return normalizeScriptBlockStream(blocks);
  }

  let changed = false;
  let previousSceneId: string | null = null;
  let previousRehearsalMark: string | null = null;
  let lastChapterId: string | null = null;
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const next: Block[] = [];

  for (const block of blocks) {
    const sceneChanged = block.sceneId !== previousSceneId;
    if (sceneChanged && block.sceneId) {
      const scene = sceneById.get(block.sceneId) ?? null;
      if (scene?.parentId) {
        if (scene.parentId !== lastChapterId) {
          next.push(makeMarkerBlock("chapter_marker", { sceneId: scene.parentId }));
          lastChapterId = scene.parentId;
        }
        next.push(makeMarkerBlock("scene_marker", { sceneId: scene.id }));
      } else {
        next.push(makeMarkerBlock("chapter_marker", { sceneId: block.sceneId }));
        lastChapterId = block.sceneId;
      }
      changed = true;
      previousRehearsalMark = null;
    }

    if (block.rehearsalMark && block.rehearsalMark !== previousRehearsalMark) {
      next.push(makeMarkerBlock("rehearsal_marker", { rehearsalMark: block.rehearsalMark }));
      changed = true;
    }

    previousSceneId = block.sceneId;
    previousRehearsalMark = block.rehearsalMark;
    if (block.sceneId || block.rehearsalMark) {
      changed = true;
      next.push({ ...block, sceneId: null, rehearsalMark: null });
    } else {
      next.push(block);
    }
  }

  return changed ? normalizeScriptBlockStream(next) : blocks;
}

function withGeneratedMarkerRehearsalMarks(blocks: Block[]): Block[] {
  let changed = false;
  let rehearsalIndex = 0;
  const next = blocks.map((block) => {
    if (block.type === "chapter_marker" || block.type === "scene_marker") rehearsalIndex = 0;
    if (block.type !== "rehearsal_marker") {
      if (isTextBlock(block) && (block.sceneId || block.rehearsalMark)) {
        changed = true;
        return { ...block, sceneId: null, rehearsalMark: null };
      }
      return block;
    }
    const generatedMark = toAlphaLabel(rehearsalIndex);
    rehearsalIndex++;
    if (block.rehearsalMark === generatedMark) return block;
    changed = true;
    return { ...block, rehearsalMark: generatedMark };
  });
  return changed ? next : blocks;
}

function normalizeScriptBlockStream(blocks: Block[]): Block[] {
  return withGeneratedMarkerRehearsalMarks(blocks);
}

function withLeadingRehearsalMarkersForMarkedSegments(blocks: Block[]): Block[] {
  let needsInsertion = false;
  for (let index = 0; index < blocks.length;) {
    const boundary = blocks[index];
    if (boundary.type !== "chapter_marker" && boundary.type !== "scene_marker") {
      index++;
      continue;
    }

    let nextBoundaryIndex = blocks.length;
    let hasRehearsalInSegment = false;
    for (let cursor = index + 1; cursor < blocks.length; cursor++) {
      const candidate = blocks[cursor];
      if (candidate.type === "chapter_marker" || candidate.type === "scene_marker") {
        nextBoundaryIndex = cursor;
        break;
      }
      if (candidate.type === "rehearsal_marker") hasRehearsalInSegment = true;
    }

    if (hasRehearsalInSegment && blocks[index + 1]?.type !== "rehearsal_marker") {
      needsInsertion = true;
      break;
    }
    index = nextBoundaryIndex;
  }

  if (!needsInsertion) return blocks;

  let index = 0;
  const next: Block[] = [];
  while (index < blocks.length) {
    const boundary = blocks[index];
    if (boundary.type !== "chapter_marker" && boundary.type !== "scene_marker") {
      next.push(boundary);
      index++;
      continue;
    }

    let nextBoundaryIndex = blocks.length;
    let hasRehearsalInSegment = false;
    for (let cursor = index + 1; cursor < blocks.length; cursor++) {
      const candidate = blocks[cursor];
      if (candidate.type === "chapter_marker" || candidate.type === "scene_marker") {
        nextBoundaryIndex = cursor;
        break;
      }
      if (candidate.type === "rehearsal_marker") hasRehearsalInSegment = true;
    }

    next.push(boundary);
    if (hasRehearsalInSegment && blocks[index + 1]?.type !== "rehearsal_marker") {
      next.push(makeMarkerBlock("rehearsal_marker", { rehearsalMark: `__auto_rehearsal_${uid()}` }));
    }
    next.push(...blocks.slice(index + 1, nextBoundaryIndex));
    index = nextBoundaryIndex;
  }

  return normalizeScriptBlockStream(next);
}

function rehearsalMarkerDeleteIds(blocks: Block[], index: number): Set<string> {
  const block = blocks[index];
  if (block?.type !== "rehearsal_marker") return new Set(block ? [block.id] : []);
  const previousBlock = blocks[index - 1] ?? null;
  if (previousBlock?.type !== "chapter_marker" && previousBlock?.type !== "scene_marker") {
    return new Set([block.id]);
  }

  for (let cursor = index + 1; cursor < blocks.length; cursor++) {
    const candidate = blocks[cursor];
    if (candidate.type === "chapter_marker" || candidate.type === "scene_marker") break;
    if (candidate.type === "rehearsal_marker") return new Set();
  }

  return new Set([block.id]);
}

function sameBlocks(a: Block[], b: Block[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    return !!other &&
      block.id === other.id &&
      block.type === other.type &&
      block.content === other.content &&
      (block.stageComment ?? null) === (other.stageComment ?? null) &&
      (block.forceShowCharacterName ?? false) === (other.forceShowCharacterName ?? false) &&
      block.lyric === other.lyric &&
      block.sceneId === other.sceneId &&
      block.rehearsalMark === other.rehearsalMark &&
      sameMarkerMeta(block.markerMeta, other.markerMeta) &&
      block.characterIds.length === other.characterIds.length &&
      block.characterIds.every((id, charIndex) => id === other.characterIds[charIndex]) &&
      sameCharacterAnnotations(block.characterAnnotations, other.characterAnnotations);
  });
}

function sameMarkerMeta(a: Block["markerMeta"], b: Block["markerMeta"]): boolean {
  const aMeta = a ?? {};
  const bMeta = b ?? {};
  return (aMeta.number ?? undefined) === (bMeta.number ?? undefined) &&
    (aMeta.name ?? undefined) === (bMeta.name ?? undefined) &&
    (aMeta.parentMarkerId ?? undefined) === (bMeta.parentMarkerId ?? undefined) &&
    (aMeta.synopsis ?? undefined) === (bMeta.synopsis ?? undefined) &&
    (aMeta.actionLine ?? undefined) === (bMeta.actionLine ?? undefined) &&
    (aMeta.music ?? undefined) === (bMeta.music ?? undefined) &&
    (aMeta.stageNotes ?? undefined) === (bMeta.stageNotes ?? undefined) &&
    (aMeta.expectedDuration ?? undefined) === (bMeta.expectedDuration ?? undefined);
}

function sameCharacterAnnotations(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function normalizeScriptMarkerInvariants(blocks: Block[], scenes: Scene[]): { blocks: Block[]; scenes: Scene[] } {
  let nextBlocks = normalizeScriptBlockStream(blocks);
  let nextScenes = scenes;
  let changed = nextBlocks !== blocks;

  const hasFixedInitialScene = nextScenes.some((scene) => scene.id === FIXED_INITIAL_CHAPTER_BLOCK_ID);
  if (!hasFixedInitialScene) {
    nextScenes = [
      { id: FIXED_INITIAL_CHAPTER_BLOCK_ID, number: "", name: FIXED_INITIAL_CHAPTER_NAME, parentId: null },
      ...nextScenes,
    ];
    changed = true;
  } else if (nextScenes.some((scene) => scene.id === FIXED_INITIAL_CHAPTER_BLOCK_ID && scene.name === "")) {
    nextScenes = nextScenes.map((scene) => (
      scene.id === FIXED_INITIAL_CHAPTER_BLOCK_ID && scene.name === ""
        ? { ...scene, name: FIXED_INITIAL_CHAPTER_NAME }
        : scene
    ));
    changed = true;
  }

  const firstBlock = nextBlocks[0];
  if (
    firstBlock?.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID ||
    firstBlock.type !== "chapter_marker" ||
    firstBlock.sceneId !== FIXED_INITIAL_CHAPTER_BLOCK_ID
  ) {
    const fixedChapterBlock = makeMarkerBlock("chapter_marker", { sceneId: FIXED_INITIAL_CHAPTER_BLOCK_ID });
    fixedChapterBlock.id = FIXED_INITIAL_CHAPTER_BLOCK_ID;
    fixedChapterBlock.markerMeta = {
      name: FIXED_INITIAL_CHAPTER_NAME,
      parentMarkerId: null,
    };
    nextBlocks = [fixedChapterBlock, ...nextBlocks.filter((block) => block.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID)];
    changed = true;
  }

  let scanIndex = 0;
  while (scanIndex < nextBlocks.length) {
    const chapterBlock = nextBlocks[scanIndex];
    if (chapterBlock.type !== "chapter_marker" || !chapterBlock.sceneId) {
      scanIndex++;
      continue;
    }

    let nextChapterIndex = nextBlocks.length;
    let hasSceneInChapter = false;
    for (let i = scanIndex + 1; i < nextBlocks.length; i++) {
      if (nextBlocks[i].type === "chapter_marker") {
        nextChapterIndex = i;
        break;
      }
      if (nextBlocks[i].type === "scene_marker") hasSceneInChapter = true;
    }
    const hasSceneImmediatelyAfterChapter = nextBlocks[scanIndex + 1]?.type === "scene_marker";

    if (hasSceneInChapter && !hasSceneImmediatelyAfterChapter) {
      const scene: Scene = { id: uid(), number: "", name: "", parentId: chapterBlock.sceneId };
      nextScenes = [...nextScenes, scene];
      nextBlocks = [
        ...nextBlocks.slice(0, scanIndex + 1),
        makeMarkerBlock("scene_marker", { sceneId: scene.id }),
        ...nextBlocks.slice(scanIndex + 1),
      ];
      changed = true;
      scanIndex += 2;
      continue;
    }

    scanIndex = nextChapterIndex;
  }

  const rehearsalNormalizedBlocks = withLeadingRehearsalMarkersForMarkedSegments(nextBlocks);
  if (rehearsalNormalizedBlocks !== nextBlocks) {
    nextBlocks = rehearsalNormalizedBlocks;
    changed = true;
  }

  const sceneIds = new Set(nextScenes.map((scene) => scene.id));
  let currentChapterId: string | null = null;
  for (const block of nextBlocks) {
    if (!block.sceneId) continue;
    if (block.type === "chapter_marker") {
      currentChapterId = block.sceneId;
      if (!sceneIds.has(block.sceneId)) {
        nextScenes = [...nextScenes, { id: block.sceneId, number: "", name: "", parentId: null }];
        sceneIds.add(block.sceneId);
        changed = true;
      }
    } else if (block.type === "scene_marker" && !sceneIds.has(block.sceneId)) {
      nextScenes = [...nextScenes, { id: block.sceneId, number: "", name: "", parentId: currentChapterId }];
      sceneIds.add(block.sceneId);
      changed = true;
    }
  }

  const normalizedScenes = normalizeSceneRowsForMarkers(nextScenes, nextBlocks);
  const scenesChanged = !sameSceneRows(normalizedScenes, scenes);
  return {
    blocks: changed ? normalizeScriptBlockStream(nextBlocks) : nextBlocks,
    scenes: scenesChanged ? normalizedScenes : nextScenes,
  };
}

function orderSceneRowsByMarkers<T extends Scene>(rows: T[], markerBlocks: Block[]): T[] {
  if (rows.length === 0) return rows;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  const orderedIds = new Set<string>();
  let currentChapterId: string | null = null;

  const pushScene = (sceneId: string, parentId: string | null) => {
    if (orderedIds.has(sceneId)) return;
    const row = rowById.get(sceneId);
    if (!row) return;
    const nextParentId = parentId === sceneId ? null : parentId;
    ordered.push({ ...row, parentId: nextParentId } as T);
    orderedIds.add(sceneId);
  };

  for (const block of markerBlocks) {
    if (!block.sceneId) continue;
    const scene = rowById.get(block.sceneId);
    if (!scene) continue;

    if (block.type === "chapter_marker" || (!isMarkerBlock(block) && scene.parentId === null)) {
      currentChapterId = scene.id;
      pushScene(scene.id, null);
      continue;
    }

    if (block.type === "scene_marker" || (!isMarkerBlock(block) && scene.parentId !== null)) {
      const parentId = currentChapterId ?? scene.parentId ?? null;
      pushScene(scene.id, parentId);
    }
  }

  for (const row of rows) {
    if (!orderedIds.has(row.id)) ordered.push(row);
  }

  return ordered.length === rows.length && ordered.every((row, index) => (
    row.id === rows[index].id &&
    row.parentId === rows[index].parentId
  ))
    ? rows
    : ordered;
}

function normalizeSceneRowsForMarkers<T extends Scene>(rows: T[], markerBlocks: Block[]): T[] {
  return withGeneratedSceneNumbers(orderSceneRowsByMarkers(rows, markerBlocks));
}

function previousAdjacentMarker(blocks: Block[], index: number): Block | null {
  const block = blocks[index - 1];
  return block && isMarkerBlock(block) ? block : null;
}

function insertMarkerWithEmptyBlockIfNeeded(blocks: Block[], marker: Block, insertIndex: number): Block[] {
  const next = [...blocks];
  const boundedIndex = Math.max(0, Math.min(next.length, insertIndex));
  const previousMarker = previousAdjacentMarker(blocks, boundedIndex);
  next.splice(boundedIndex, 0, marker);
  if (shouldInsertEmptyBlockAfterMarker(next, boundedIndex)) {
    next.splice(boundedIndex + 1, 0, makeBlock());
  }
  const repaired = repairEmptyMarkerSegments(next, [previousMarker?.id, marker.id].filter((id): id is string => !!id));
  return repaired === next ? normalizeScriptBlockStream(next) : repaired;
}

function repairEmptyMarkerSegments(blocks: Block[], markerIds: Iterable<string>, options?: { includeTerminal?: boolean }): Block[] {
  const ids = [...new Set(markerIds)];
  if (ids.length === 0) return blocks;
  const markerIndexes = ids.length <= 1
    ? ids.map((id) => blocks.findIndex((block) => block.id === id)).filter((index) => index >= 0)
    : (() => {
        const markerIndexById = new Map(blocks.map((block, index) => [block.id, index]));
        return ids
          .map((id) => markerIndexById.get(id) ?? -1)
          .filter((index) => index >= 0)
          .sort((a, b) => b - a);
      })();
  let next = blocks;
  let changed = false;
  for (const markerIndex of markerIndexes) {
    if (!shouldInsertEmptyBlockAfterMarker(next, markerIndex)) continue;
    if (!changed) next = [...blocks];
    next.splice(markerIndex + 1, 0, makeBlock());
    changed = true;
  }
  if (options?.includeTerminal) {
    const terminalIndexes = changed
      ? ids
          .map((id) => next.findIndex((block) => block.id === id))
          .filter((index) => index >= 0)
          .sort((a, b) => b - a)
      : markerIndexes;
    for (const markerIndex of terminalIndexes) {
      const marker = next[markerIndex];
      if (!marker || !isMarkerBlock(marker) || next[markerIndex + 1]) continue;
      if (!changed) next = [...blocks];
      next.splice(markerIndex + 1, 0, makeBlock());
      changed = true;
    }
  }
  return changed ? normalizeScriptBlockStream(next) : blocks;
}

function isOnlyTextBlockInMarkerSegment(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (!block || isMarkerBlock(block)) return false;

  let start = index;
  while (start > 0) {
    const prev = blocks[start - 1];
    if (isMarkerBlock(prev)) break;
    start--;
  }

  let textCount = 0;
  for (let cursor = start; cursor < blocks.length; cursor++) {
    const current = blocks[cursor];
    if (cursor !== start && isMarkerBlock(current)) break;
    if (isTextBlock(current)) textCount++;
    if (textCount > 1) return false;
  }
  return textCount === 1;
}

function analyzeEmptyScriptCleanup(
  blocks: Block[],
  scenes: Scene[],
  sceneDetailById: Map<string, SceneDetail>
): EmptyScriptCleanupAnalysis {
  const textCountsBySceneId = new Map<string, number>();
  const textCountsByRehearsalBlockId = new Map<string, number>();
  const rehearsalTargetById = new Map<string, EmptyScriptCleanupTarget>();
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const chapterMarkerBlocks: Block[] = [];
  const sceneMarkerBlocks: Block[] = [];
  let hasEmptyTextBlock = false;
  let currentSceneId: string | null = null;
  let currentRehearsalBlockId: string | null = null;

  for (const block of blocks) {
    if (block.type === "chapter_marker") {
      chapterMarkerBlocks.push(block);
      currentSceneId = block.sceneId;
      currentRehearsalBlockId = null;
      continue;
    }
    if (block.type === "scene_marker") {
      sceneMarkerBlocks.push(block);
      currentSceneId = block.sceneId;
      currentRehearsalBlockId = null;
      continue;
    }
    if (block.type === "rehearsal_marker") {
      currentRehearsalBlockId = block.id;
      if (currentSceneId) {
        const parentScene = sceneById.get(currentSceneId) ?? null;
        const parentKind = parentScene?.parentId === null ? "chapter" : "scene";
        const parentKey = `${parentKind}:${currentSceneId}`;
        const rehearsalLabel = [
          parentScene?.number.trim(),
          block.rehearsalMark?.trim(),
        ].filter(Boolean).join("-");
        rehearsalTargetById.set(block.id, {
          id: block.id,
          key: `rehearsal:${block.id}`,
          label: rehearsalLabel || "未命名排练记号",
          kind: "rehearsal",
          parentKey,
          dividerKey: currentSceneId,
          chapterKey: parentScene?.parentId ?? currentSceneId,
        });
      }
      continue;
    }
    if (isMarkerBlock(block)) continue;
    if (isEmptyTextBlock(block)) {
      hasEmptyTextBlock = true;
      continue;
    }
    if (!currentSceneId) continue;
    textCountsBySceneId.set(currentSceneId, (textCountsBySceneId.get(currentSceneId) ?? 0) + 1);
    if (currentRehearsalBlockId) {
      textCountsByRehearsalBlockId.set(
        currentRehearsalBlockId,
        (textCountsByRehearsalBlockId.get(currentRehearsalBlockId) ?? 0) + 1
      );
    }
  }

  const removableSceneIds = new Set<string>();
  const removableChapterIds = new Set<string>();
  const childSceneIdsByChapter = new Map<string, string[]>();
  for (const scene of scenes) {
    if (!scene.parentId) continue;
    const childIds = childSceneIdsByChapter.get(scene.parentId);
    if (childIds) childIds.push(scene.id);
    else childSceneIdsByChapter.set(scene.parentId, [scene.id]);
  }

  for (const block of sceneMarkerBlocks) {
    if (!block.sceneId) continue;
    if ((textCountsBySceneId.get(block.sceneId) ?? 0) > 0) continue;
    removableSceneIds.add(block.sceneId);
  }

  for (const block of chapterMarkerBlocks) {
    if (!block.sceneId) continue;
    if (block.id === FIXED_INITIAL_CHAPTER_BLOCK_ID) continue;
    const chapterHasOwnText = (textCountsBySceneId.get(block.sceneId) ?? 0) > 0;
    const chapterHasRemainingScene = (childSceneIdsByChapter.get(block.sceneId) ?? [])
      .some((sceneId) => !removableSceneIds.has(sceneId));
    if (chapterHasOwnText || chapterHasRemainingScene) continue;
    removableChapterIds.add(block.sceneId);
  }

  const makeSectionTarget = (scene: Scene, markerMeta?: Block["markerMeta"]): EmptyScriptCleanupTarget => {
    const kind = scene.parentId === null ? "chapter" : "scene";
    const label = [scene.number.trim(), scene.name.trim()].filter(Boolean).join(" ") ||
      (kind === "chapter" ? "未命名章节" : "未命名段落");
    const hasDetails = hasNonNameSceneDetails(sceneDetailById.get(scene.id), markerMeta);
    return {
      id: scene.id,
      key: `${kind}:${scene.id}`,
      label,
      kind,
      parentKey: scene.parentId ? `chapter:${scene.parentId}` : null,
      dividerKey: scene.id,
      chapterKey: scene.parentId ?? scene.id,
      disabledReason: hasDetails ? (kind === "chapter" ? "章节详情不为空" : "段落详情不为空") : undefined,
    };
  };

  const targets: EmptyScriptCleanupTarget[] = [];
  const seenTargetKeys = new Set<string>();
  for (const block of blocks) {
    let target: EmptyScriptCleanupTarget | null = null;
    if (block.type === "chapter_marker" && block.sceneId && removableChapterIds.has(block.sceneId)) {
      const scene = sceneById.get(block.sceneId);
      if (scene) target = makeSectionTarget(scene, block.markerMeta);
    } else if (block.type === "scene_marker" && block.sceneId && removableSceneIds.has(block.sceneId)) {
      const scene = sceneById.get(block.sceneId);
      if (scene) target = makeSectionTarget(scene, block.markerMeta);
    } else if (block.type === "rehearsal_marker") {
      const rehearsalTarget = rehearsalTargetById.get(block.id) ?? null;
      target = rehearsalTarget && (textCountsByRehearsalBlockId.get(rehearsalTarget.id) ?? 0) === 0
        ? rehearsalTarget
        : null;
    }
    if (!target || seenTargetKeys.has(target.key)) continue;
    seenTargetKeys.add(target.key);
    targets.push(target);
  }
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const protectedChildSceneNumbersByChapter = new Map<string, string[]>();
  for (const target of targets) {
    if (target.kind !== "scene" || !target.disabledReason || !target.parentKey) continue;
    const childSceneNumbers = protectedChildSceneNumbersByChapter.get(target.parentKey) ?? [];
    childSceneNumbers.push(sceneById.get(target.id)?.number.trim() || target.label);
    protectedChildSceneNumbersByChapter.set(target.parentKey, childSceneNumbers);
  }
  for (const [chapterKey, childSceneNumbers] of protectedChildSceneNumbersByChapter) {
    const chapter = targetByKey.get(chapterKey);
    if (!chapter || chapter.disabledReason) continue;
    chapter.disabledReason = `子段落详情不为空：${childSceneNumbers.join("、")}`;
  }
  return { targets, hasEmptyTextBlock };
}

function findTocSceneBlockIndex(sceneId: string, scenes: Scene[], blocks: Block[]): number {
  const directIdx = blocks.findIndex((block) => block.sceneId === sceneId);
  if (directIdx >= 0) return directIdx;

  const scene = scenes.find((row) => row.id === sceneId);
  if (!scene || scene.parentId !== null) return -1;
  const childSceneIds = new Set(scenes.filter((row) => row.parentId === scene.id).map((row) => row.id));
  return blocks.findIndex((block) => !!block.sceneId && childSceneIds.has(block.sceneId));
}

function findSceneMarkerBlockIndex(sceneId: string, blocks: Block[]): number {
  return blocks.findIndex((block) => (
    (block.type === "chapter_marker" || block.type === "scene_marker") &&
    block.sceneId === sceneId
  ));
}

function clearTimeoutMap(timers: Map<string, ReturnType<typeof setTimeout>>) {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
}

function markProgrammaticScroll(
  suppressRef: React.MutableRefObject<boolean>,
  frameRef: React.MutableRefObject<number | null>,
) {
  suppressRef.current = true;
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current);
  }
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = null;
    suppressRef.current = false;
  });
}

function sameSceneRows(a: Scene[], b: Scene[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((scene, index) => {
    const other = b[index];
    return !!other &&
      scene.id === other.id &&
      scene.number === other.number &&
      scene.name === other.name &&
      scene.parentId === other.parentId;
  });
}

function sameSceneDetails(a: SceneDetail[], b: SceneDetail[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((scene, index) => {
    const other = b[index];
    return !!other &&
      scene.id === other.id &&
      scene.number === other.number &&
      scene.name === other.name &&
      scene.parentId === other.parentId &&
      scene.synopsis === other.synopsis &&
      scene.actionLine === other.actionLine &&
      scene.music === other.music &&
      scene.stageNotes === other.stageNotes &&
      scene.expectedDuration === other.expectedDuration;
  });
}

type DragTarget =
  | { kind: "block"; id: string; position: "before" | "after" }
  | { kind: "edge"; edge: "top" | "bottom" };
type BlockDragTarget = Extract<DragTarget, { kind: "block" }>;

function sameDragTarget(a: DragTarget | null, b: DragTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "edge" && b.kind === "edge") return a.edge === b.edge;
  if (a.kind === "block" && b.kind === "block") return a.id === b.id && a.position === b.position;
  return false;
}

function resolveDragTarget(target: DragTarget, blocks: Block[], windowRange: { start: number; end: number }): BlockDragTarget | null {
  if (target.kind === "block") return target;
  if (blocks.length === 0) return null;
  const targetIdx = target.edge === "top"
    ? Math.min(windowRange.start, blocks.length - 1)
    : Math.max(0, Math.min(windowRange.end - 1, blocks.length - 1));
  const anchor = blocks[targetIdx];
  if (!anchor) return null;
  return { kind: "block", id: anchor.id, position: target.edge === "top" ? "before" : "after" };
}

function getDragInsertIndex(target: BlockDragTarget, blocks: Block[]): number {
  const targetIdx = blocks.findIndex((b) => b.id === target.id);
  if (targetIdx === -1) return -1;
  return target.position === "before" ? targetIdx : targetIdx + 1;
}

// ─── TagPicker ────────────────────────────────────────────────────────────────

function TagPicker({
  tagGroups,
  blockTagValues,
  onTagChange,
  onCopy,
  onPaste,
  onClose,
}: {
  tagGroups: TagGroup[];
  blockTagValues: BlockTagValue[];
  onTagChange: (groupId: string, optionId: string | null, value: number | null, del: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 bottom-full z-50 mb-1 w-52 rounded-xl border border-zinc-200 bg-white p-2.5 shadow-lg"
      onMouseDown={e => e.stopPropagation()}
    >
      {tagGroups.map(group => {
        const tagVal = blockTagValues.find(t => t.groupId === group.id);
        return (
          <div key={group.id} className="mb-2.5 last:mb-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{group.name}</p>
            {group.type === "exclusive" ? (
              <div className="flex flex-wrap gap-1">
                {group.options.map(opt => {
                  const selected = tagVal?.optionId === opt.id;
                  const isDefault = !tagVal?.optionId && opt.id === group.defaultOptionId;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => selected
                        ? onTagChange(group.id, null, null, true)
                        : onTagChange(group.id, opt.id, null, false)
                      }
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium transition-all"
                      style={{
                        backgroundColor: (selected || isDefault) ? opt.color + "22" : "#f4f4f5",
                        color: (selected || isDefault) ? opt.color : "#a1a1aa",
                        outline: selected ? `1.5px solid ${opt.color}` : "none",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={group.rangeMin ?? 0}
                  max={group.rangeMax ?? 10}
                  step={group.rangeStep ?? 1}
                  value={tagVal?.value ?? group.rangeDefault ?? group.rangeMin ?? 0}
                  onChange={e => onTagChange(group.id, null, Number(e.target.value), false)}
                  className="flex-1 h-1 accent-zinc-600"
                />
                <span className="w-6 text-right text-[10px] text-zinc-500">
                  {tagVal?.value ?? group.rangeDefault ?? group.rangeMin ?? 0}
                </span>
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-2 flex items-center justify-end gap-3 border-t border-zinc-100 pt-2">
        <button onClick={() => { onCopy(); onClose(); }} className="text-[10px] text-zinc-400 hover:text-zinc-600">复制标签</button>
        <button onClick={() => { onPaste(); onClose(); }} className="text-[10px] text-zinc-400 hover:text-zinc-600">粘贴标签</button>
      </div>
    </div>
  );
}

// ─── ScriptBlock ──────────────────────────────────────────────────────────────

const COMPACT_STAGE_CONTROL_THRESHOLD_REM = 1.9;
const COMPACT_STAGE_DELETE_SHIFT_PX = -3;
const COMPACT_CONTENT_OPTICAL_OFFSET_PX = -2;
const IN_BLOCK_STAGE_COMMENT_MANUAL_OFFSET_PX = -2;
const REHEARSAL_NON_COMPACT_CHARACTER_BOTTOM_GAP_CLASS = "mb-[0.18rem]";

function getCompactFallbackLineHeightPx() {
  if (typeof window === "undefined") return 28;
  const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(rootFontSize) ? rootFontSize : 16) * 1.75;
}

function ScriptBlock({
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
  rightGutterCanShowComments,
  commentBubbleMaxWidth,
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
  index = 0,
  lineNum,
  lineIndexWidth,
  isSearchHighlight,
  showRehearsalMark = true,
  showReadOnlyRehearsalMark = false,
  readOnlyRehearsalMode = false,
  readOnlyScene = null,
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
  rightGutterCanShowComments: boolean;
  commentBubbleMaxWidth: number;
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
  index?: number;
  lineNum?: number;
  lineIndexWidth?: string;
  isSearchHighlight?: "match" | "focused";
  showRehearsalMark?: boolean;
  showReadOnlyRehearsalMark?: boolean;
  readOnlyRehearsalMode?: boolean;
  readOnlyScene?: Scene | null;
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
      : (index ?? 0) % 2 === 1
        ? "bg-zinc-50/60"
        : "";
  const movedGlowClass = isRecentlyMoved ? "script-block-moved-glow" : "";
  const compactDeleteStyle: React.CSSProperties | undefined = compactControlLayout?.deleteLeft !== null && compactControlLayout?.deleteLeft !== undefined
    ? { left: compactControlLayout.deleteLeft }
    : undefined;
  const displayScene = readOnlyScene ?? (block.sceneId ? scenes.find((scene) => scene.id === block.sceneId) ?? null : null);
  const hasSceneLabel = !!displayScene;
  const hasStageComment = !!block.stageComment?.trim();
  const showCompactStageCommentRow = hasStageComment || stageCommentEditing;
  const stageCommentManualOffsetYPx =
    isCompactTextLayout && (canEditText || readOnlyRehearsalMode) && (hasStageComment || stageCommentEditing)
      ? IN_BLOCK_STAGE_COMMENT_MANUAL_OFFSET_PX
      : 0;
  const characterBottomGapClassName =
    readOnlyRehearsalMode && !isCompactTextLayout && block.characterIds.length > 0
      ? REHEARSAL_NON_COMPACT_CHARACTER_BOTTOM_GAP_CLASS
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
  const compactControlHoverStyle: React.CSSProperties | undefined = isCompactHiddenCharacterLayout
    ? { width: compactControlLayout.hoverWidth }
    : undefined;
  const rightActionRowClass = `absolute z-20 flex items-center transition-opacity ${
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
  const commentBlockCaption = buildCommentBlockCaption(block, characters, index ?? 0);
  const lineIndexSlotStyle: React.CSSProperties = {
    width: lineIndexWidth
      ? lineIndexWidth
      : `${LINE_INDEX_CONTROL_MIN_WIDTH_REM}rem`,
  };

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
    const compactContentWidth = blockContentWidth - COMPACT_TEXT_SIDE_WIDTH_REM * remPx;
    const width = Math.round(compactContentWidth * COMPACT_STAGE_COMMENT_EDITOR_WIDTH_RATIO);
    return width > 0 ? width : null;
  }, []);

  useEffect(() => {
    if (!isCompactTextLayout) {
      setCompactCharacterColumnHeight(0);
      const fallbackLineHeight = getCompactFallbackLineHeightPx();
      setCompactCharacterLineHeight(fallbackLineHeight);
      setCompactContentLineHeight(fallbackLineHeight);
      return;
    }
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
              style={lineIndexSlotStyle}
              className={`pointer-events-none shrink-0 select-none text-left tabular-nums text-[9px] leading-none transition-colors ${lineNumberClass}`}
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
              className={`relative top-[1px] transition-opacity ${isMarkStart && block.rehearsalMark && showRehearsalMark ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
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
                className="absolute left-0 bottom-0 z-10 flex translate-x-5 items-center gap-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm"
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
                  onDeleteFocus();
                  if (canDeleteWithoutConfirmation) {
                    onRequestLargeSelectionOperation("delete", selectedCount, onDelete);
                  }
                  else { setConfirmDelete(true); onDeleteConfirmationChange(true); }
                }}
                style={compactDeleteStyle}
                className="relative flex h-4 w-4 items-center justify-center rounded text-[12px] leading-none text-zinc-300 opacity-0 transition-all hover:bg-red-100 hover:text-red-500 group-hover:opacity-100"
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
              onClick={onToggleSelected}
              className={`absolute left-0 top-[calc(50%-2px)] h-[max(1.5rem,calc(100%-3rem))] w-4 -translate-y-1/2 select-none rounded opacity-0 outline-none transition-all focus:outline-none focus-visible:outline-none group-hover:opacity-100 ${
                isReorderLocked
                  ? "cursor-not-allowed text-zinc-200 opacity-40"
                  : `cursor-grab hover:bg-[#dbe5f3] hover:text-[#91a8ca] active:cursor-grabbing ${
                      isSelected ? "bg-[#dbe5f3] text-[#91a8ca] opacity-100" : "text-zinc-200"
                    }`
              }`}
              title="拖动调整位置"
              aria-label="拖动调整位置"
            >
              <span className="pointer-events-none absolute bottom-1 left-1/2 top-1 w-0.5 -translate-x-1/2 rounded bg-current" />
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
        hasGutterSpace={rightGutterCanShowComments}
        maxWidth={commentBubbleMaxWidth}
        blockLabel={commentBlockCaption.label}
        captionBody={commentBlockCaption.body}
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
        <div className="grid grid-cols-[7.5rem_1rem_minmax(0,1fr)] items-start gap-x-2 text-left">
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
              data-placeholder="在此输入台词…"
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
        data-placeholder={isStage ? "舞台提示…" : "在此输入台词…"}
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

// ─── Block spacing / insertion ────────────────────────────────────────────────

function BlockGap() {
  return <div className="h-5" aria-hidden="true" />;
}

function InsertZone({ lineIndexWidth, onInsert }: { lineIndexWidth?: string; onInsert: () => void }) {
  const style: React.CSSProperties | undefined = lineIndexWidth
    ? { paddingLeft: `calc(${lineIndexWidth} + ${LINE_INDEX_GUTTER_OFFSET_REM}rem)` }
    : undefined;
  return (
    <div className="group flex h-5 items-center justify-center px-6" style={style}>
      <button
        onClick={onInsert}
        title="插入新块"
        className="flex h-5 w-5 items-center justify-center rounded-full text-[12px] leading-none text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-500 group-hover:opacity-100"
      >
        +
      </button>
    </div>
  );
}

// ─── CommentsPanel helpers ────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function SideBlockPanel({
  blockId,
  title,
  blockCaption,
  hasGutterSpace,
  gutterWidth,
  viewportWidth,
  navigation,
  onClose,
  children,
}: {
  blockId: string;
  title: string;
  blockCaption?: CommentBlockCaption | null;
  hasGutterSpace: boolean;
  gutterWidth: number;
  viewportWidth: number;
  navigation?: SideBlockPanelNavigation;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { pointerTop, pointerOffsetY } = useBlockSpeechTail(blockId);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  useLayoutEffect(() => {
    const updateHeaderHeight = () => setHeaderHeight(headerRef.current?.offsetHeight ?? 0);
    updateHeaderHeight();
    window.addEventListener("resize", updateHeaderHeight);
    return () => window.removeEventListener("resize", updateHeaderHeight);
  }, [title, blockCaption?.label, blockCaption?.body]);

  const tailUsesHeaderFill = pointerTop + SPEECH_TAIL_BASE_HALF_PX <= headerHeight;

  return (
    <div
      className="fixed right-0 bottom-0 isolate z-30 flex flex-col border-l border-zinc-200 bg-white shadow-xl"
      style={{
        top: SIDE_PANEL_TOP_PX,
        width: hasGutterSpace
          ? Math.min(SIDE_PANEL_MAX_WIDTH_PX, Math.max(SIDE_PANEL_MIN_WIDTH_PX, gutterWidth - SIDE_PANEL_GUTTER_PADDING_PX))
          : Math.min(SIDE_PANEL_MIN_WIDTH_PX, viewportWidth || SIDE_PANEL_MIN_WIDTH_PX),
      }}
    >
      <SpeechTail top={pointerTop} offsetY={pointerOffsetY} fillClassName={tailUsesHeaderFill ? "fill-zinc-100" : "fill-white"} />
      <div ref={headerRef} className="relative z-10 flex shrink-0 items-start justify-between gap-3 border-y border-emerald-600/80 bg-zinc-100 px-4 py-3">
        <div className="min-w-0">
          <span className="block text-sm font-semibold text-zinc-700">{title}</span>
          {blockCaption && (
            <p className="mt-1 line-clamp-1 text-xs leading-snug text-zinc-500" title={`${blockCaption.label} ${blockCaption.body}`}>
              <span className="font-bold text-zinc-700">{blockCaption.label}</span>{" "}
              <span>{blockCaption.body}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {navigation && (
            <>
              <button
                type="button"
                onClick={navigation.onPrevious}
                disabled={!navigation.hasPrevious}
                className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80 disabled:cursor-default disabled:opacity-25 disabled:hover:text-zinc-800"
                title="上一条"
              >
                <svg className="h-4 w-4" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <polyline points="3 7.5 6 4.5 9 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
                </svg>
              </button>
              <button
                type="button"
                onClick={navigation.onNext}
                disabled={!navigation.hasNext}
                className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80 disabled:cursor-default disabled:opacity-25 disabled:hover:text-zinc-800"
                title="下一条"
              >
                <svg className="h-4 w-4" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <polyline points="3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-5 w-5 items-center justify-center text-zinc-800 hover:text-emerald-600/80"
            title="关闭"
          >
            <span className="relative h-3 w-3" aria-hidden="true">
              <span className="absolute left-1/2 top-1/2 h-0.5 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
              <span className="absolute left-1/2 top-1/2 h-0.5 w-3 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
            </span>
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── CommentsPanel ────────────────────────────────────────────────────────────

function CommentsPanel({
  blockId, productionId, comments, currentOpenId, isAdmin,
  onAdd, onEdit, onDelete, onClose, onNavigate,
  hasGutterSpace,
  gutterWidth,
  viewportWidth,
  blockCaption,
  navigation,
}: {
  blockId: string; productionId: string; comments: Comment[];
  currentOpenId: string; isAdmin: boolean;
  onAdd: (c: Comment) => void; onEdit: (c: Comment) => void;
  onDelete: (id: string) => void; onClose: () => void;
  onNavigate?: () => void;
  hasGutterSpace: boolean;
  gutterWidth: number;
  viewportWidth: number;
  blockCaption?: CommentBlockCaption | null;
  navigation?: SideBlockPanelNavigation;
}) {
  const [members, setMembers] = useState<Mention[]>([]);
  const [newText, setNewText] = useState("");
  const [newMentions, setNewMentions] = useState<Mention[]>([]);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyMentions, setReplyMentions] = useState<Mention[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingNewAssets, setPendingNewAssets] = useState<PendingAsset[]>([]);
  const [pendingReplyAssets, setPendingReplyAssets] = useState<PendingAsset[]>([]);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/mention-users`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.users) setMembers(d.users); })
      .catch(() => {});
  }, [productionId]);

  const topLevel = useMemo(
    () => comments.filter(c => c.parentId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments],
  );
  const repliesFor = useCallback(
    (parentId: string) => comments.filter(c => c.parentId === parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments],
  );

  const postComment = async (opts: { parentId?: string; text: string; mentions: Mention[] }) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, body: opts.text, parentId: opts.parentId ?? null, mentions: opts.mentions }),
      });
      if (res.ok) return (await res.json()).comment as Comment;
    } finally { setSubmitting(false); }
    return null;
  };

  const mountAssets = (commentId: string, assetIds: PendingAsset[]) =>
    Promise.all(assetIds.map(({ id: assetId }) =>
      fetch(`${BASE_PATH}/api/production/${productionId}/assets/${assetId}/mounts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mountType: "comment", mountId: commentId }),
      })
    ));

  const submitNew = async () => {
    const text = newText.trim(); if (!text) return;
    const c = await postComment({ text, mentions: newMentions });
    if (c) {
      if (pendingNewAssets.length > 0) await mountAssets(c.id, pendingNewAssets);
      onAdd(c); setNewText(""); setNewMentions([]); setPendingNewAssets([]);
    }
  };

  const submitReply = async () => {
    const text = replyText.trim(); if (!text || !replyingTo) return;
    const c = await postComment({ parentId: replyingTo, text, mentions: replyMentions });
    if (c) {
      if (pendingReplyAssets.length > 0) await mountAssets(c.id, pendingReplyAssets);
      onAdd(c); setReplyText(""); setReplyMentions([]); setReplyingTo(null); setPendingReplyAssets([]);
    }
  };

  const saveEdit = async (id: string) => {
    const text = editText.trim(); if (!text) return;
    const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    if (res.ok) { onEdit((await res.json()).comment); setEditingId(null); }
  };

  const doDelete = async (id: string) => {
    const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${id}`, { method: "DELETE" });
    if (res.ok) onDelete(id);
  };

  const startReply = (parentId: string, authorOpenId: string, authorName: string) => {
    setReplyingTo(parentId);
    setReplyText(`@${authorName} `);
    setReplyMentions([{ openId: authorOpenId, name: authorName }]);
  };

  const taClass = "w-full resize-none rounded border border-zinc-200 px-2 py-1.5 text-sm text-zinc-700 outline-none focus:border-zinc-400";
  const replyThreadBorderClass = "border-emerald-600/30";

  // Shared: header row (author + timestamp + edit/delete)
  const commentHeader = (c: Comment) => (
    <div className="flex items-baseline justify-between">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-xs font-semibold text-zinc-700">{c.authorName}</span>
        <span className="shrink-0 text-[10px] text-zinc-500" title={new Date(c.createdAt).toLocaleString("zh-CN")}>
          {relativeTime(c.createdAt)}
        </span>
      </span>
      <div className="flex items-center gap-2">
        {editingId !== c.id && (
          <>
            {c.openId === currentOpenId && (
              <button onClick={() => { setEditingId(c.id); setEditText(c.body); }}
                className="text-[11px] text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-zinc-600">
                编辑
              </button>
            )}
            {(c.openId === currentOpenId || isAdmin) && (
              <button onClick={() => doDelete(c.id)}
                className="text-[11px] text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400">
                删除
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  // Shared: body or inline edit form
  const commentBody = (c: Comment, replyAction?: { label: string; onClick: () => void }) => (
    editingId === c.id ? (
      <div className="mt-1">
        <textarea value={editText} onChange={e => setEditText(e.target.value)} autoFocus rows={3} className={taClass} />
        <div className="mt-1.5 flex gap-2">
          <button onClick={() => setEditingId(null)} className="flex-1 rounded border border-zinc-200 py-1 text-xs text-zinc-500 hover:border-zinc-400">取消</button>
          <button onClick={() => saveEdit(c.id)} className="flex-1 rounded bg-zinc-800 py-1 text-xs text-white hover:bg-zinc-700">保存</button>
        </div>
      </div>
    ) : (
      <div className="mt-0.5">
        <SmartText content={c.body} memberMention={{ members: c.mentions }} className="inline whitespace-pre-wrap text-zinc-600" />
        {replyAction && (
          <button onClick={replyAction.onClick} className="ml-2 inline text-[11px] text-zinc-300 hover:text-zinc-500">
            {replyAction.label}
          </button>
        )}
      </div>
    )
  );

  return (
    <SideBlockPanel
      blockId={blockId}
      title="评论"
      blockCaption={blockCaption}
      hasGutterSpace={hasGutterSpace}
      gutterWidth={gutterWidth}
      viewportWidth={viewportWidth}
      navigation={navigation}
      onClose={onClose}
    >
      <div className="relative z-10 flex-1 overflow-y-auto bg-white px-4 py-3 space-y-4">
        {topLevel.length === 0 && <p className="py-4 text-center text-xs text-zinc-300">暂无评论</p>}
        {topLevel.map(topC => (
          <div key={topC.id}>
            {/* Top-level comment */}
            <div className="group">
              {commentHeader(topC)}
              {commentBody(topC, {
                label: replyingTo === topC.id ? "取消回复" : "回复",
                onClick: () => replyingTo === topC.id ? setReplyingTo(null) : startReply(topC.id, topC.openId, topC.authorName),
              })}
              <MountPointAssets
                productionId={productionId}
                mountType="comment"
                mountId={topC.id}
                label="评论附件"
                display="compact"
                onNavigate={onNavigate}
              />
            </div>

            {/* Replies */}
            {repliesFor(topC.id).map(r => (
              <div key={r.id} className={`group mt-2 ml-3 border-l-2 pl-3 ${replyThreadBorderClass}`}>
                <p className="mb-0.5 text-[10px] text-zinc-300">↳ 回复 {r.mentions[0]?.name ?? topC.authorName}</p>
                {commentHeader(r)}
                {commentBody(r, {
                  label: "回复",
                  onClick: () => startReply(topC.id, r.openId, r.authorName),
                })}
                <MountPointAssets
                  productionId={productionId}
                  mountType="comment"
                  mountId={r.id}
                  label="评论附件"
                  display="compact"
                  onNavigate={onNavigate}
                />
              </div>
            ))}

            {/* Reply compose */}
            {replyingTo === topC.id && (
              <div className={`mt-2 ml-3 border-l-2 pl-3 ${replyThreadBorderClass}`}>
                <SmartTextarea value={replyText} onChange={setReplyText}
                  memberMention={{ members, onMentionsChange: setReplyMentions }}
                  placeholder="回复… (⌘↵ 发布)" rows={2} autoFocus
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitReply(); }}
                  className={taClass} />
                <div className="mt-1 flex items-center justify-between">
                  <CommentAssetPicker productionId={productionId} selected={pendingReplyAssets} onSelect={setPendingReplyAssets} />
                  <div className="flex gap-2">
                    <button onClick={() => setReplyingTo(null)} className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-600">取消</button>
                    <button onClick={submitReply} disabled={!replyText.trim() || submitting}
                      className="rounded bg-zinc-800 px-3 py-1 text-xs text-white hover:bg-zinc-700 disabled:opacity-40">
                      {submitting ? "…" : "回复"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="relative z-10 shrink-0 border-t border-zinc-100 bg-white px-4 py-3">
        <SmartTextarea value={newText} onChange={setNewText}
          memberMention={{ members, onMentionsChange: setNewMentions }}
          placeholder="添加评论… (⌘↵ 发布)" rows={3}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitNew(); }}
          className="w-full resize-none rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-700 outline-none focus:border-zinc-400" />
        <div className="mt-2 flex items-center justify-between">
          <CommentAssetPicker productionId={productionId} selected={pendingNewAssets} onSelect={setPendingNewAssets} />
          <button onClick={submitNew} disabled={!newText.trim() || submitting}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
            {submitting ? "发布中…" : "发布"}
          </button>
        </div>
      </div>
    </SideBlockPanel>
  );
}

// ─── ScriptEditor ─────────────────────────────────────────────────────────────

export default function ScriptEditor({
  scriptId = "default",
  productionId,
  canEditText: canEditTextProp = true,
  canEditMetadata: canEditMetadataProp = true,
  canEditRehearsalMark = true,
  canImport = false,
  versionId: initialVersionId,
  canManageVersions = false,
}: {
  scriptId?: string;
  productionId?: string;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
  canImport?: boolean;
  versionId?: string | null;
  canManageVersions?: boolean;
}) {
  const effectiveScriptId = productionId ?? scriptId;

  // ── Version state ─────────────────────────────────────────────────────────────
  const [activeVersionId, setActiveVersionId] = useState<string | null>(initialVersionId ?? null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null);

  // Gate edit permissions by version status
  const baseCanEditText = canEditTextProp && (versionStatus === "editing" || versionStatus === null);
  const baseCanEditMetadata = canEditMetadataProp && (versionStatus === "editing" || versionStatus === "committed" || versionStatus === null);
  const baseCanEdit = baseCanEditText || baseCanEditMetadata || canEditRehearsalMark;
  const [manualLockedMode, setManualLockedMode] = useState(() => readDisplayCookie().rehearsalMode);
  const versionForcesLockedMode =
    versionStatus === "committed" || versionStatus === "frozen" || versionStatus === "archived";
  const isLockedMode = manualLockedMode || versionForcesLockedMode;
  const canEditText = baseCanEditText && !isLockedMode;
  const canEditMetadata = baseCanEditMetadata && !isLockedMode;
  const effectiveCanEditRehearsalMark = canEditRehearsalMark && !isLockedMode;

  const canEdit = canEditText || canEditMetadata || effectiveCanEditRehearsalMark;
  const [characters, setCharacters] = useState<Character[]>([]);
  const [focusedCharacterIds, setFocusedCharacterIds] = useState<Set<string>>(() => readStoredCharacterFocus(effectiveScriptId));
  const [pendingAggregateFocusPrompt, setPendingAggregateFocusPrompt] = useState<PendingAggregateFocusPrompt | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneDetails, setSceneDetails] = useState<SceneDetail[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([makeBlock()]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const dragCountBadgeRef = useRef<HTMLDivElement>(null);
  const [isScriptDragging, setIsScriptDragging] = useState(false);
  const [isReorderLocked, setIsReorderLocked] = useState(false);
  const [reorderNotice, setReorderNotice] = useState("");
  const [selectionChangeNotice, setSelectionChangeNotice] = useState("");
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(() => new Set());
  const selectedDetailBlockId = selectedBlockIds.size === 1
    ? selectedBlockIds.values().next().value as string | undefined
    : undefined;
  const selectionAnchorBlockIdRef = useRef<string | null>(null);
  const rangeSelectionActiveRef = useRef(false);
  const [shiftKeyDown, setShiftKeyDown] = useState(false);
  const [recentlyMovedBlockIds, setRecentlyMovedBlockIds] = useState<Set<string>>(() => new Set());
  const [tocHighlightedMarkerIds, setTocHighlightedMarkerIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmationRequest, setDeleteConfirmationRequest] = useState<{ anchorId: string; token: number } | null>(null);
  const [deleteConfirmingBlockIds, setDeleteConfirmingBlockIds] = useState<Set<string>>(() => new Set());
  const [markerDetailDeleteConfirmBlockId, setMarkerDetailDeleteConfirmBlockId] = useState<string | null>(null);
  const [dismissActionToken, setDismissActionToken] = useState(0);
  const [pendingLargeSelectionConfirmation, setPendingLargeSelectionConfirmation] =
    useState<PendingLargeSelectionConfirmation | null>(null);
  const [markerDetailDeleteBlockedKind, setMarkerDetailDeleteBlockedKind] =
    useState<MarkerDetailDeleteBlockedKind | null>(null);
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
  const lineIndexMeasureRef = useRef<HTMLSpanElement | null>(null);
  const lineIndexMinMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [lineIndexWidth, setLineIndexWidth] = useState(0);
  const [lineIndexMinWidth, setLineIndexMinWidth] = useState(0);

  // ── Block tags ───────────────────────────────────────────────────────────────
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [blockTagMap, setBlockTagMap] = useState<Map<string, BlockTagValue[]>>(new Map());
  const blockTagMapRef = useRef<Map<string, BlockTagValue[]>>(new Map());
  const tagClipboardRef = useRef<BlockTagValue[] | null>(null);

  // ── Script config (page layout, stage delimiters) ─────────────────────────
  const [scriptConfig, setScriptConfig] = useState<ScriptConfig>(DEFAULT_SCRIPT_CONFIG);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingLockedMode, setPendingLockedMode] = useState<boolean | null>(null);
  const [pendingStageDelimiterChange, setPendingStageDelimiterChange] =
    useState<PendingStageDelimiterChange | null>(null);

  const saveScriptConfig = useCallback(async (patch: Partial<ScriptConfig>) => {
    if (!baseCanEditMetadata) return;
    const next = { ...scriptConfig, ...patch };
    setScriptConfig(next);
    await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
  }, [baseCanEditMetadata, scriptConfig, effectiveScriptId]);

  const requestStageDelimiterChange = useCallback((open: string, close: string) => {
    if (scriptConfig.stageDelimOpen === open && scriptConfig.stageDelimClose === close) {
      setOpenMenu(null);
      return;
    }
    setPendingStageDelimiterChange({ open, close });
    setOpenMenu(null);
  }, [scriptConfig.stageDelimOpen, scriptConfig.stageDelimClose]);

  // ── Page map (computed client-side, deterministic) ──────────────────────────
  const ownershipCacheRef = useRef<{ blocks: Block[]; owned: Block[] } | null>(null);
  const ownershipDirtyRef = useRef<MarkerOwnershipDirty>("full");
  const pageMapCacheRef = useRef<EstimatedPageMapCache | null>(null);
  const pageMapDirtyRef = useRef<MarkerOwnershipDirty>("full");
  const markOwnershipDirty = useCallback((dirty: Exclude<MarkerOwnershipDirty, null>) => {
    const currentOwnership = ownershipDirtyRef.current;
    const currentPageMap = pageMapDirtyRef.current;
    if (currentOwnership === "full" || dirty === "full") ownershipDirtyRef.current = "full";
    else {
      const currentRanges = currentOwnership ? (Array.isArray(currentOwnership) ? currentOwnership : [currentOwnership]) : [];
      const nextRanges = Array.isArray(dirty) ? dirty : [dirty];
      ownershipDirtyRef.current = [...currentRanges, ...nextRanges];
    }
    if (currentPageMap === "full" || dirty === "full") {
      pageMapDirtyRef.current = "full";
      return;
    }
    const currentRanges = currentPageMap ? (Array.isArray(currentPageMap) ? currentPageMap : [currentPageMap]) : [];
    const nextRanges = Array.isArray(dirty) ? dirty : [dirty];
    pageMapDirtyRef.current = [...currentRanges, ...nextRanges];
  }, []);
  const ownedBlocks = useMemo(() => {
    const cache = ownershipCacheRef.current;
    const owned = updateMarkerOwnership(cache?.blocks ?? null, blocks, cache?.owned ?? null, ownershipDirtyRef.current);
    ownershipCacheRef.current = { blocks, owned };
    ownershipDirtyRef.current = null;
    return owned;
  }, [blocks]);
  const pageMap = useMemo(() => {
    const cache = updateEstimatedPageMap(
      pageMapCacheRef.current,
      ownedBlocks,
      scriptConfig.pageLayout,
      scriptConfig.textLayoutMode,
      true,
      pageMapDirtyRef.current,
    );
    pageMapCacheRef.current = cache;
    pageMapDirtyRef.current = null;
    return cache.pageMap;
  }, [ownedBlocks, scriptConfig.pageLayout, scriptConfig.textLayoutMode]);
  const [printDividerPageMap, setPrintDividerPageMap] = useState<Record<string, number> | null>(null);
  const [printPageMapMeasureEnabled, setPrintPageMapMeasureEnabled] = useState(false);
  const handlePrintPageMapChange = useCallback((nextPageMap: Record<string, number>) => {
    setPrintDividerPageMap((prev) => samePageMap(prev, nextPageMap) ? prev : nextPageMap);
  }, []);
  const reloadScriptState = useCallback(async () => {
    const vParam = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
    const response = await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}${vParam}`);
    if (response.status === 202) return;
    if (!response.ok) throw new Error("Failed to reload script state");
    const serverState = await response.json() as ScriptState;
    const expandedBlocks = expandLegacyMarkersToBlocks(serverState.blocks, serverState.scenes);
    const normalized = normalizeScriptMarkerInvariants(expandedBlocks, serverState.scenes);
    setBlocks(normalized.blocks);
    setCharacters(serverState.characters);
    setScenes(normalized.scenes);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
    syncedStateRef.current = { ...serverState, blocks: normalized.blocks, scenes: normalized.scenes };
  }, [activeVersionId, effectiveScriptId]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const sceneDetailById = useMemo(() => new Map(sceneDetails.map((scene) => [scene.id, scene])), [sceneDetails]);
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
  useEffect(() => {
    const expandedBlocks = expandLegacyMarkersToBlocks(blocks, scenes);
    const normalized = normalizeScriptMarkerInvariants(expandedBlocks, scenes);
    if (!sameBlocks(normalized.blocks, blocks)) {
      markOwnershipDirty("full");
      setBlocks(normalized.blocks);
    }
    if (!sameSceneRows(normalized.scenes, scenes)) {
      setScenes(normalized.scenes);
      setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
    }
  }, [blocks, markOwnershipDirty, scenes]);
  useEffect(() => {
    setFocusedCharacterIds(readStoredCharacterFocus(effectiveScriptId));
    setPendingAggregateFocusPrompt(null);
  }, [effectiveScriptId]);
  const setAndStoreFocusedCharacterIds = useCallback((ids: Set<string>) => {
    setFocusedCharacterIds(ids);
    writeStoredCharacterFocus(effectiveScriptId, ids);
  }, [effectiveScriptId]);
  const toggleCharacterFocus = useCallback((id: string) => {
    const ids = new Set(focusedCharacterIds);
    if (ids.has(id)) {
      ids.delete(id);
      setAndStoreFocusedCharacterIds(ids);
      setPendingAggregateFocusPrompt((prompt) => prompt?.characterId === id ? null : prompt);
      return;
    }

    ids.add(id);
    setAndStoreFocusedCharacterIds(ids);

    const aggregateIds = characters
      .filter((char) => char.isAggregate && (char.memberIds ?? []).includes(id) && !focusedCharacterIds.has(char.id))
      .map((char) => char.id);
    if (aggregateIds.length > 0) {
      setPendingAggregateFocusPrompt({
        characterId: id,
        aggregateIds,
        selectedIds: new Set(),
      });
    }
  }, [characters, focusedCharacterIds, setAndStoreFocusedCharacterIds]);
  const clearCharacterFocus = useCallback(() => {
    setAndStoreFocusedCharacterIds(new Set());
  }, [setAndStoreFocusedCharacterIds]);
  const confirmAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.selectedIds) ids.add(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const addAllAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.aggregateIds) ids.add(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const cancelAggregateFocusPrompt = useCallback(() => {
    if (!pendingAggregateFocusPrompt) return;
    const ids = new Set(focusedCharacterIds);
    ids.add(pendingAggregateFocusPrompt.characterId);
    for (const aggregateId of pendingAggregateFocusPrompt.aggregateIds) ids.delete(aggregateId);
    setAndStoreFocusedCharacterIds(ids);
    setPendingAggregateFocusPrompt(null);
  }, [focusedCharacterIds, pendingAggregateFocusPrompt, setAndStoreFocusedCharacterIds]);
  const togglePendingAggregateFocus = useCallback((id: string) => {
    setPendingAggregateFocusPrompt((prompt) => {
      if (!prompt) return prompt;
      const selectedIds = new Set(prompt.selectedIds);
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      return { ...prompt, selectedIds };
    });
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExact, setSearchExact] = useState(false);
  const [searchCurrentPage, setSearchCurrentPage] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  // ── Jump (line / page) ──────────────────────────────────────────────────────
  const [jumpTarget, setJumpTarget] = useState<"line" | "page" | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  // ── Toolbar dropdowns ────────────────────────────────────────────────────────
  type OpenMenu = "script" | "edit" | "display" | "export" | "scene" | "char" | "presence" | null;
  type ToolbarMode = "full" | "short" | "compact";
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>("full");
  const [toolbarMeasureTick, setToolbarMeasureTick] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fullToolbarWidthRef = useRef(0);
  const shortToolbarWidthRef = useRef(0);
  const toolbarCompact = toolbarMode === "compact";
  const toolbarShort = toolbarMode === "short";
  const toggleMenu = useCallback((name: Exclude<OpenMenu, null>) => {
    setMoreMenuOpen(false);
    setOpenMenu(prev => prev === name ? null : name);
  }, []);
  const toggleMoreMenu = useCallback(() => {
    setMoreMenuOpen(prev => {
      const next = !prev;
      if (!next) setOpenMenu(null);
      return next;
    });
  }, []);
  const openNestedMenu = useCallback((name: Exclude<OpenMenu, null>) => {
    setMoreMenuOpen(true);
    setOpenMenu(name);
  }, []);
  const handleCharacterPanelOpenChange = useCallback((open: boolean) => {
    if (!open && pendingAggregateFocusPrompt) return;
    setOpenMenu(open ? "char" : null);
  }, [pendingAggregateFocusPrompt]);
  const setToolbarElement = useCallback((el: HTMLDivElement | null) => {
    toolbarRef.current = el;
    if (el) setToolbarMeasureTick(tick => tick + 1);
  }, []);
  const resetToolbarMeasurement = useCallback((closeMenus = true) => {
    fullToolbarWidthRef.current = 0;
    shortToolbarWidthRef.current = 0;
    setToolbarMode("full");
    if (closeMenus) {
      setMoreMenuOpen(false);
      setOpenMenu(null);
    }
  }, []);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (navigatingAwayRef.current || openMenu || moreMenuOpen) return;
      const available = el.clientWidth;
      const required = el.scrollWidth;
      if (toolbarMode === "full") {
        fullToolbarWidthRef.current = required;
        if (required > available + 1) {
          setToolbarMode("short");
        }
        return;
      }
      if (toolbarMode === "short") {
        shortToolbarWidthRef.current = required;
        if (required > available + 1) {
          setToolbarMode("compact");
          return;
        }
        if (fullToolbarWidthRef.current > 0 && available >= fullToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
          setToolbarMode("full");
        }
        return;
      }
      if (fullToolbarWidthRef.current > 0 && available >= fullToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
        setToolbarMode("full");
        return;
      }
      if (shortToolbarWidthRef.current > 0 && available >= shortToolbarWidthRef.current + TOOLBAR_FOLD_HYSTERESIS_PX) {
        setToolbarMode("short");
      }
    };
    const scheduleMeasure = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [toolbarMode, openMenu, moreMenuOpen, toolbarMeasureTick]);

  useEffect(() => {
    resetToolbarMeasurement();
  }, [activeVersionId, versions.length, isLockedMode, canEditMetadata, resetToolbarMeasurement]);

  // ── Display settings (cookie-persisted) ──────────────────────────────────────
  const [display, setDisplay] = useState<DisplaySettings>(readDisplayCookie);
  useEffect(() => {
    setPrintDividerPageMap(null);
    setPrintPageMapMeasureEnabled(false);
    if (!display.pageBreaks) return;
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(
        () => setPrintPageMapMeasureEnabled(true),
        { timeout: 1000 },
      );
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = window.setTimeout(() => setPrintPageMapMeasureEnabled(true), 250);
    return () => window.clearTimeout(timer);
  }, [
    display.pageBreaks,
    blocks,
    characters,
    scenes,
    scriptConfig.pageLayout,
    scriptConfig.textLayoutMode,
    scriptConfig.stageDelimOpen,
    scriptConfig.stageDelimClose,
  ]);
  useLayoutEffect(() => {
    if (!display.lineNumbers) {
      setLineIndexWidth(0);
      setLineIndexMinWidth(0);
      return;
    }
    const el = lineIndexMeasureRef.current;
    const minEl = lineIndexMinMeasureRef.current;
    if (!el || !minEl) return;
    const measure = () => {
      const width = Math.ceil(el.getBoundingClientRect().width);
      const minWidth = Math.ceil(minEl.getBoundingClientRect().width);
      setLineIndexWidth((prev) => prev === width ? prev : width);
      setLineIndexMinWidth((prev) => prev === minWidth ? prev : minWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(minEl);
    return () => observer.disconnect();
  }, [display.lineNumbers, maxLineIndexText]);
  const lineIndexWidthStyle = display.lineNumbers && lineIndexWidth > 0
    ? `${lineIndexWidth}px`
    : undefined;
  const markerLineIndexWidthStyle = display.lineNumbers && (lineIndexWidth > 0 || lineIndexMinWidth > 0)
    ? `${Math.max(lineIndexWidth, lineIndexMinWidth)}px`
    : undefined;
  const toggleDisplay = useCallback((key: keyof DisplaySettings) => {
    setDisplay(prev => {
      const next = { ...prev, [key]: !prev[key] };
      writeDisplayCookie(next);
      return next;
    });
  }, []);

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
  }, []);

  const taRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFocus = useRef<{ id: string; textOffset?: number; atEnd?: boolean } | null>(null);
  const pendingCharOpen = useRef<string | null>(null);
  const draggingBlockId = useRef<string | null>(null);
  const draggingBlockIds = useRef<string[]>([]);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragInvalidReasonRef = useRef<string | null>(null);
  const dragButtonDownSeenRef = useRef(false);
  const dragButtonReleasedRef = useRef(false);
  const dropHandledRef = useRef(false);
  const isReorderLockedRef = useRef(false);
  const windowRangeFrameRef = useRef<number | null>(null);
  const reorderUnlockFrame = useRef<number | null>(null);
  const pendingReorderUnlockRef = useRef(false);
  const pendingMoveCenterRef = useRef<string | null>(null);
  const reorderNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionChangeNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedHighlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const tocMarkerGlowTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const suppressProgrammaticScrollRef = useRef(false);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const navigatingAwayRef = useRef(false);
  const blocksRef = useRef(blocks);
  const ownedBlocksRef = useRef(ownedBlocks);
  const scenesRef = useRef(scenes);
  const blockIndexByIdRef = useRef<Map<string, number>>(new Map(blocks.map((block, index) => [block.id, index])));
  const prevBlocksLengthRef = useRef(blocks.length);
  const clampWindowRange = useCallback((range: { start: number; end: number }, blockCount = blocksRef.current.length) => {
    if (blockCount <= 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.min(range.start, blockCount - 1));
    const end = Math.max(start + 1, Math.min(range.end, blockCount));
    return { start, end };
  }, []);
  useLayoutEffect(() => {
    blocksRef.current = blocks;
    blockIndexByIdRef.current = new Map(blocks.map((block, index) => [block.id, index]));
  }, [blocks]);
  useLayoutEffect(() => { ownedBlocksRef.current = ownedBlocks; }, [ownedBlocks]);
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);
  useEffect(() => { blockTagMapRef.current = blockTagMap; }, [blockTagMap]);
  const markBlockOwnershipDirty = useCallback((id: string) => {
    const idx = blockIndexByIdRef.current.get(id);
    if (idx !== undefined) markOwnershipDirty({ start: idx, end: idx + 1 });
  }, [markOwnershipDirty]);
  const markBlockIdsOwnershipDirty = useCallback((ids: Set<string>) => {
    markOwnershipDirty(Array.from(ids, (id) => {
      const index = blockIndexByIdRef.current.get(id);
      return index === undefined ? null : { start: index, end: index + 1 };
    }).filter((range): range is MarkerOwnershipRange => range !== null));
  }, [markOwnershipDirty]);
  useEffect(() => () => {
    if (reorderUnlockFrame.current !== null) cancelAnimationFrame(reorderUnlockFrame.current);
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    pendingWindowRangeRef.current = null;
    if (programmaticScrollFrameRef.current !== null) cancelAnimationFrame(programmaticScrollFrameRef.current);
    if (reorderNoticeTimer.current !== null) clearTimeout(reorderNoticeTimer.current);
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    clearTimeoutMap(movedHighlightTimersRef.current);
    clearTimeoutMap(tocMarkerGlowTimersRef.current);
  }, []);

  const clearDragCountBadge = useCallback(() => {
    dragButtonReleasedRef.current = true;
    dragButtonDownSeenRef.current = false;
    const badge = dragCountBadgeRef.current;
    if (badge) badge.hidden = true;
  }, []);

  useEffect(() => {
    const clearIfDragButtonReleased = (event: globalThis.DragEvent) => {
      if (event.buttons > 0) {
        dragButtonDownSeenRef.current = true;
        return;
      }
      if (!dragButtonDownSeenRef.current || event.buttons !== 0) return;
      clearDragCountBadge();
    };
    document.addEventListener("drag", clearIfDragButtonReleased, true);
    document.addEventListener("dragend", clearDragCountBadge, true);
    document.addEventListener("dragover", clearIfDragButtonReleased, true);
    document.addEventListener("drop", clearDragCountBadge, true);
    document.addEventListener("pointerup", clearDragCountBadge, true);
    document.addEventListener("mouseup", clearDragCountBadge, true);
    window.addEventListener("drag", clearIfDragButtonReleased, true);
    window.addEventListener("dragover", clearIfDragButtonReleased, true);
    window.addEventListener("pointerup", clearDragCountBadge, true);
    window.addEventListener("mouseup", clearDragCountBadge, true);
    return () => {
      document.removeEventListener("drag", clearIfDragButtonReleased, true);
      document.removeEventListener("dragend", clearDragCountBadge, true);
      document.removeEventListener("dragover", clearIfDragButtonReleased, true);
      document.removeEventListener("drop", clearDragCountBadge, true);
      document.removeEventListener("pointerup", clearDragCountBadge, true);
      document.removeEventListener("mouseup", clearDragCountBadge, true);
      window.removeEventListener("drag", clearIfDragButtonReleased, true);
      window.removeEventListener("dragover", clearIfDragButtonReleased, true);
      window.removeEventListener("pointerup", clearDragCountBadge, true);
      window.removeEventListener("mouseup", clearDragCountBadge, true);
    };
  }, [clearDragCountBadge]);

  const setScriptDragging = useCallback((dragging: boolean) => {
    setIsScriptDragging((current) => current === dragging ? current : dragging);
  }, []);

  const resetScriptInteractions = useCallback(() => {
    selectionAnchorBlockIdRef.current = null;
    rangeSelectionActiveRef.current = false;
    pendingFocus.current = null;
    pendingCharOpen.current = null;
    draggingBlockId.current = null;
    draggingBlockIds.current = [];
    dragTargetRef.current = null;
    dragInvalidReasonRef.current = null;
    dropHandledRef.current = false;
    setSelectedBlockIds((current) => current.size === 0 ? current : new Set());
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setDeleteConfirmationRequest(null);
    setMarkerDetailDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
    setDragTarget(null);
    setIsScriptDragging(false);
    clearDragCountBadge();
    window.getSelection()?.removeAllRanges();
  }, [clearDragCountBadge]);

  const toggleLockedMode = useCallback(() => {
    if (versionForcesLockedMode) return;
    setPendingLockedMode(!manualLockedMode);
    setOpenMenu(null);
  }, [manualLockedMode, versionForcesLockedMode]);

  const confirmLockedModeChange = useCallback(() => {
    if (pendingLockedMode === null) return;
    resetScriptInteractions();
    setOpenMenu(null);
    setManualLockedMode(pendingLockedMode);
    setDisplay(prev => {
      const next = { ...prev, rehearsalMode: pendingLockedMode };
      writeDisplayCookie(next);
      return next;
    });
    setPendingLockedMode(null);
  }, [pendingLockedMode, resetScriptInteractions]);

  const unlockReorder = useCallback(() => {
    if (reorderUnlockFrame.current !== null) cancelAnimationFrame(reorderUnlockFrame.current);
    reorderUnlockFrame.current = null;
    pendingReorderUnlockRef.current = false;
    isReorderLockedRef.current = false;
    setIsReorderLocked(false);
  }, []);

  const lockReorder = useCallback(() => {
    if (reorderUnlockFrame.current !== null) cancelAnimationFrame(reorderUnlockFrame.current);
    reorderUnlockFrame.current = null;
    isReorderLockedRef.current = true;
    setIsReorderLocked(true);
  }, []);

  const unlockReorderAfterCommit = useCallback(() => {
    pendingReorderUnlockRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!pendingReorderUnlockRef.current) return;
    reorderUnlockFrame.current = requestAnimationFrame(() => {
      reorderUnlockFrame.current = null;
      unlockReorder();
    });
  }, [blocks, unlockReorder]);

  const showReorderNotice = useCallback((message: string) => {
    if (reorderNoticeTimer.current !== null) clearTimeout(reorderNoticeTimer.current);
    setReorderNotice(message);
    reorderNoticeTimer.current = setTimeout(() => {
      reorderNoticeTimer.current = null;
      setReorderNotice("");
    }, 1800);
  }, []);

  const showSelectionChangeNotice = useCallback((message: string) => {
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    setSelectionChangeNotice(message);
    selectionChangeNoticeTimer.current = setTimeout(() => {
      selectionChangeNoticeTimer.current = null;
      setSelectionChangeNotice("");
    }, 1800);
  }, []);

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
  const VSCROLL_BUFFER = 80;
  const DEFAULT_BLOCK_H = 80;
  const INITIAL_WINDOW_SIZE = 200;
  const blocksContainerRef = useRef<HTMLDivElement>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const botSpacerRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const cumulativeHRef = useRef<number[]>([0]); // indexed 0..blocks.length
  const updateDragCountBadge = useCallback((clientX: number, clientY: number, count: number, buttons?: number) => {
    if (buttons !== undefined) {
      if (buttons > 0) dragButtonDownSeenRef.current = true;
      if (dragButtonDownSeenRef.current && buttons === 0) {
        clearDragCountBadge();
        return;
      }
    }
    if (dragButtonReleasedRef.current || count <= 1) {
      clearDragCountBadge();
      return;
    }
    const rect = blocksContainerRef.current?.getBoundingClientRect();
    const midpoint = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const side = clientX > midpoint ? "left" : "right";
    const badge = dragCountBadgeRef.current;
    if (!badge) return;
    badge.textContent = String(count);
    badge.style.left = `${side === "right" ? clientX + 16 : clientX - 16}px`;
    badge.style.top = `${clientY}px`;
    badge.style.transform = side === "right" ? "" : "translateX(-100%)";
    badge.hidden = false;
  }, [clearDragCountBadge]);
  const [windowRange, setWindowRange] = useState(() => ({ start: 0, end: Math.min(INITIAL_WINDOW_SIZE, blocks.length) }));
  const windowRangeRef = useRef(windowRange);
  useLayoutEffect(() => { windowRangeRef.current = windowRange; }, [windowRange]);
  const pendingWindowRangeRef = useRef<{ start: number; end: number } | null>(null);
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });
  // Pending navigation: set before windowRange update, consumed by useLayoutEffect after DOM commit
  const pendingNavigateRef = useRef<
    { kind: 'block'; id: string; align: ScrollLogicalPosition } | { kind: 'scene'; id: string } | null
  >(null);
  // After the initial estimated scroll, store the target for a precise correction after measurement
  const postNavCorrectionRef = useRef<
    { kind: 'block'; id: string; align: ScrollLogicalPosition } | { kind: 'scene'; id: string } | null
  >(null);
  // Incremented by the measurement effect to trigger the correction layout effect
  const [correctionTick, setCorrectionTick] = useState(0);

  const applyWindowRange = useCallback((next: { start: number; end: number }, sync = false) => {
    const targetRange = clampWindowRange(next);
    const pending = pendingWindowRangeRef.current;
    const current = pending ?? windowRangeRef.current;
    if (current.start === targetRange.start && current.end === targetRange.end) return;
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
    if (sync) commit();
    else windowRangeFrameRef.current = requestAnimationFrame(commit);
  }, [clampWindowRange]);

  // Rebuild cumulative heights from cache
  const rebuildCumulative = useCallback(() => {
    const bl = ownedBlocksRef.current;
    const measured = measuredHeightsRef.current;
    // Use measured average for unmeasured blocks — much more accurate than a fixed default
    let avgH = DEFAULT_BLOCK_H;
    if (measured.size > 0) {
      let sum = 0;
      measured.forEach(h => { sum += h; });
      avgH = sum / measured.size;
    }
    const arr = new Array(bl.length + 1);
    arr[0] = 0;
    for (let i = 0; i < bl.length; i++) {
      arr[i + 1] = arr[i] + (measured.get(bl[i].id) ?? avgH);
    }
    cumulativeHRef.current = arr;
  }, []);

  // Binary search: first block index whose top >= offset
  const blockAtOffset = useCallback((offset: number) => {
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
  }, []);

  const getBlockScrollElement = useCallback((blockId: string) => (
    document.getElementById(`block-content-${blockId}`) ?? document.getElementById(`block-${blockId}`)
  ), []);

  const updateActiveSceneFromScroll = useCallback(() => {
    const container = blocksContainerRef.current;
    const bl = blocksRef.current;
    const owned = ownedBlocksRef.current;
    if (!container || bl.length === 0) {
      if (activeSceneIdRef.current !== null) {
        activeSceneIdRef.current = null;
        setActiveSceneId(null);
        return true;
      }
      return false;
    }

    const anchorY = SCRIPT_TOC_ACTIVE_SCENE_TOP_ANCHOR_PX;
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
      const containerTop = container.getBoundingClientRect().top + window.scrollY;
      idx = blockAtOffset(Math.max(0, window.scrollY + anchorY - containerTop));
    }

    const nextSceneId = owned[idx]?.sceneId ?? bl[idx]?.sceneId ?? null;
    if (nextSceneId !== activeSceneIdRef.current) {
      activeSceneIdRef.current = nextSceneId;
      setActiveSceneId(nextSceneId);
      return true;
    }
    return false;
  }, [blockAtOffset]);

  const recomputeWindow = useCallback(() => {
    if (navigatingAwayRef.current) return false;
    if (draggingBlockId.current || isReorderLockedRef.current) return false;
    const container = blocksContainerRef.current;
    const bl = blocksRef.current;
    if (!container || bl.length === 0) return false;
    const containerTop = container.getBoundingClientRect().top + window.scrollY;
    const sy = window.scrollY;
    const viewStart = Math.max(0, sy - containerTop);
    const viewEnd = viewStart + window.innerHeight;

    let newStart = Math.max(0, blockAtOffset(viewStart) - VSCROLL_BUFFER);
    let newEnd = Math.min(bl.length, blockAtOffset(viewEnd) + VSCROLL_BUFFER + 1);

    // Always keep the focused block rendered
    const fi = focusedIdRef.current ? blockIndexByIdRef.current.get(focusedIdRef.current) ?? -1 : -1;
    if (fi >= 0) { newStart = Math.min(newStart, fi); newEnd = Math.max(newEnd, fi + 1); }
    const pfi = pendingFocus.current ? blockIndexByIdRef.current.get(pendingFocus.current.id) ?? -1 : -1;
    if (pfi >= 0) { newStart = Math.min(newStart, pfi); newEnd = Math.max(newEnd, pfi + 1); }

    applyWindowRange({ start: newStart, end: newEnd });
    return updateActiveSceneFromScroll();
  }, [applyWindowRange, blockAtOffset, updateActiveSceneFromScroll]);

  type LoadState = "loading" | "updating" | "ready" | "not-found" | "error";
  type MigrationProgress = {
    progress?: number;
    phase?: string;
    startedAt?: number | null;
    elapsedMs?: number;
    estimatedTotalMs?: number | null;
    estimatedRemainingMs?: number | null;
  };
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string>("");
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationNow, setMigrationNow] = useState(() => Date.now());
  const formatMigrationElapsed = (ms: number | null | undefined): string => {
    if (!ms || ms <= 0) return "已用时 0 秒";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `已用时 ${seconds} 秒`;
    return `已用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const formatMigrationRemaining = (ms: number | null | undefined): string | null => {
    if (!ms || ms <= 0) return null;
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `预计剩余约 ${seconds} 秒`;
    return `预计剩余约 ${Math.ceil(seconds / 60)} 分钟`;
  };

  useEffect(() => {
    if (loadState !== "updating") return;
    setMigrationNow(Date.now());
    const timer = setInterval(() => setMigrationNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loadState]);

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

  // Scroll listener + debounced position save
  useEffect(() => {
    let rafId = 0;
    let didCenterForScrollGesture = false;
    let scrollGestureTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (e: Event) => {
      if (navigatingAwayRef.current) return;
      const target = e.target;
      const isDocumentScroll =
        target === document ||
        target === document.documentElement ||
        target === document.scrollingElement ||
        target === window;
      if (!isDocumentScroll) return;
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
      if (!scrollLockedRef.current) postNavCorrectionRef.current = null;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    recomputeWindow();
    updateActiveSceneFromScroll();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(rafId); clearTimeout(scrollGestureTimer); };
  }, [recomputeWindow, updateActiveSceneFromScroll]);

  useEffect(() => {
    updateActiveSceneFromScroll();
  }, [blocks.length, windowRange.start, windowRange.end, spacerH.top, updateActiveSceneFromScroll]);

  // Clamp window when blocks list length changes (insert/delete)
  useLayoutEffect(() => {
    const bl = blocksRef.current;
    const prevLength = prevBlocksLengthRef.current;
    prevBlocksLengthRef.current = bl.length;
    const prev = windowRangeRef.current;
    if (bl.length === 0) {
      applyWindowRange({ start: 0, end: 0 }, true);
      return;
    }

    let start = Math.min(prev.start, Math.max(0, bl.length - 1));
    let end = Math.min(prev.end, bl.length);

    const addedCount = bl.length - prevLength;
    if (addedCount > 0 && addedCount <= 5 && prev.end >= prevLength) {
      end = Math.min(bl.length, end + addedCount);
    }

    const pendingFocusId = pendingFocus.current?.id;
    const pendingFocusIdx = pendingFocusId ? bl.findIndex((b) => b.id === pendingFocusId) : -1;
    if (pendingFocusIdx >= 0) {
      start = Math.min(start, pendingFocusIdx);
      end = Math.max(end, pendingFocusIdx + 1);
    }
    if (end <= start) end = Math.min(bl.length, start + 1);

    applyWindowRange({ start, end }, true);
  }, [blocks.length, applyWindowRange]);

  // Measure rendered block heights after each render pass
  useEffect(() => {
    if (navigatingAwayRef.current) return;
    const container = blocksContainerRef.current;
    if (!container) return;
    let changed = false;
    container.querySelectorAll<HTMLElement>('[data-bwrap]').forEach(el => {
      const id = el.dataset.bwrap;
      if (!id) return;
      const h = el.offsetHeight;
      if (h > 0 && measuredHeightsRef.current.get(id) !== h) {
        measuredHeightsRef.current.set(id, h);
        changed = true;
      }
    });
    if (changed) {
      rebuildCumulative();
      // If there's a pending navigation correction, trigger the layout effect that will re-scroll
      if (postNavCorrectionRef.current) {
        setCorrectionTick(t => t + 1);
      }
    }
  }, [blocks.length, windowRange.start, windowRange.end, spacerH.top, spacerH.bot, rebuildCumulative]);

  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const centerTarget = pendingMoveCenterRef.current;
    if (centerTarget === null) return;
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
    applyWindowRange(nextRange, true);
    if (!rangeChanged) {
      const el = document.getElementById(`block-${centerTarget}`);
      const scrollEl = getBlockScrollElement(centerTarget);
      if (scrollEl || el) {
        pendingNavigateRef.current = null;
        markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
        (scrollEl ?? el)?.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
  }, [blocks, applyWindowRange, getBlockScrollElement]);

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
    const cum = cumulativeHRef.current;
    const n = blocksRef.current.length;
    const range = clampWindowRange(windowRange, n);
    const newTop = cum[range.start] ?? range.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[range.end] ?? range.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    el.scrollIntoView({ behavior: 'instant', block: nav.kind === 'block' ? nav.align : 'center' });
    setScrollLocked(false);
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  // windowRange is intentionally in deps — ensures this captures the post-recomputeWindow value;
  // postNavCorrectionRef going null after the first correction prevents repeated firing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange, clampWindowRange, getBlockScrollElement, updateActiveSceneFromScroll]);

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

    // The spacerH state hasn't re-rendered yet — the spacer divs still hold the old window's
    // heights. Correct them synchronously in the DOM so scrollIntoView lands at the right place.
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocksRef.current.length;
    const range = clampWindowRange(windowRange, n);
    const newTop = cum[range.start] ?? range.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[range.end] ?? range.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;

    markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
    el.scrollIntoView({ behavior: 'instant', block: nav.kind === 'block' ? nav.align : 'center' });

    // Newly-rendered blocks haven't been measured yet so the cumulative heights are estimated.
    // Store the target so the measurement effect can trigger a precise correction pass.
    postNavCorrectionRef.current = nav;
    requestAnimationFrame(() => {
      updateActiveSceneFromScroll();
      window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
    });
  }, [windowRange, clampWindowRange, rebuildCumulative, getBlockScrollElement, updateActiveSceneFromScroll]);

  // Update spacer heights from cumulative cache after each render (safe: layoutEffect, not render)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const safeStart = n === 0 ? 0 : Math.min(windowRange.start, Math.max(0, n - 1));
    const safeEnd = Math.min(Math.max(windowRange.end, safeStart), n);
    const top = cum[safeStart] ?? safeStart * DEFAULT_BLOCK_H;
    const total = cum[n] ?? n * DEFAULT_BLOCK_H;
    const bot = Math.max(0, total - (cum[safeEnd] ?? safeEnd * DEFAULT_BLOCK_H));
    setSpacerH(prev => prev.top === top && prev.bot === bot ? prev : { top, bot });
  }, [windowRange, blocks.length]);

  // Teleport to a block: load target window, then instant-jump in the layout effect.
  const scrollToBlockIdx = useCallback((idx: number, align: ScrollLogicalPosition = 'center') => {
    if (idx < 0 || idx >= blocksRef.current.length) return;
    const block = blocksRef.current[idx];
    // If already rendered, jump immediately
    const el = getBlockScrollElement(block.id);
    if (el) {
      markProgrammaticScroll(suppressProgrammaticScrollRef, programmaticScrollFrameRef);
      el.scrollIntoView({ behavior: 'instant', block: align });
      requestAnimationFrame(() => {
        updateActiveSceneFromScroll();
        window.dispatchEvent(new Event(SCRIPT_TOC_CENTER_EVENT));
      });
      return;
    }
    // Otherwise shift the window and let useLayoutEffect land us there
    pendingNavigateRef.current = { kind: 'block', id: block.id, align };
    const nextRange = {
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocksRef.current.length, idx + VSCROLL_BUFFER + 1),
    };
    applyWindowRange(nextRange, true);
  }, [applyWindowRange, getBlockScrollElement, updateActiveSceneFromScroll]);

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
    return rect.bottom > 0 && rect.top < window.innerHeight;
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
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable ref to the push function so the debounce closure never goes stale.
  const pushPatchRef = useRef<(curr: ScriptState) => void>(() => {});

  useEffect(() => {
    pushPatchRef.current = async (curr: ScriptState) => {
      if (!canEdit || loadState !== "ready" || syncedStateRef.current === null) return;
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      try {
        const seq = ++clientSeqRef.current;
        const patch = diffState(syncedStateRef.current, curr, seq);

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

        if (!patch.blockOps.length && !patch.charOps.length && !patch.sceneOps.length) return;
        const vPatch = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
        const res = await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}${vPatch}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (res.status === 202) {
          if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
          syncTimerRef.current = setTimeout(() => {
            pushPatchRef.current(curr);
          }, 1200);
          return;
        }
        if (res.ok) {
          const body = await res.json() as { ok: boolean; serverSeq: number };
          serverSeqRef.current = body.serverSeq;
          syncedStateRef.current = curr;
          // Advance the synced tag baseline so the next diff starts fresh.
          syncedBlockTagMapRef.current = new Map(currTagMap);
          // Any pending inserts that were consumed above are already deleted;
          // clear whatever might remain (orphaned entries for blocks that were
          // deleted before the sync fired).
          pendingTagInsertsRef.current.clear();
        }
      } catch {
        // Sync failure is non-fatal — will retry on next state change.
      } finally {
        isSyncingRef.current = false;
        const waiters = syncIdleWaitersRef.current;
        syncIdleWaitersRef.current = [];
        for (const resolve of waiters) resolve();
      }
    };
  }, [effectiveScriptId, activeVersionId, canEdit, loadState]);

  useEffect(() => {
    setLoadState("loading");
    setLoadError("");
    setMigrationProgress(null);
    const placeholderBlock = makeBlock();
    measuredHeightsRef.current.clear();
    cumulativeHRef.current = [0, DEFAULT_BLOCK_H];
    setBlocks([placeholderBlock]);
    applyWindowRange({ start: 0, end: 1 }, true);
    setSpacerH({ top: 0, bot: 0 });
    setCharacters([]);
    setScenes([]);
    setSceneDetails([]);
    syncedStateRef.current = null;

    const vParam = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
    const loadUrl = productionId
      ? `${BASE_PATH}/api/production/${productionId}${vParam}`
      : `${BASE_PATH}/api/script/${effectiveScriptId}${vParam}`;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const r = await fetch(loadUrl);
        // Production route returns { state, versionId, versions }; script route returns ScriptState directly.
        type ProdResponse = { state: ScriptState; versionId: string; versions: Version[] };
        type ErrResponse = { error?: string };
        type UpdatingResponse = { status?: "updating"; migration?: MigrationProgress };
        const body = await r.json() as ProdResponse | ScriptState | ErrResponse | UpdatingResponse;
        if (cancelled) return;
        if (r.status === 202) {
          setMigrationProgress((body as UpdatingResponse).migration ?? null);
          setLoadState("updating");
          retryTimer = setTimeout(load, 1200);
          return;
        }
        if (r.status === 404) { setMigrationProgress(null); setLoadState("not-found"); return; }
        if (!r.ok) { setMigrationProgress(null); setLoadError((body as ErrResponse).error ?? "加载失败"); setLoadState("error"); return; }

        const isProdResponse = productionId && "state" in body;
        const state: ScriptState = isProdResponse
          ? (body as ProdResponse).state
          : (body as ScriptState);

        if (state.blocks.length > 0) {
          const expandedBlocks = expandLegacyMarkersToBlocks(state.blocks, state.scenes);
          const normalized = normalizeScriptMarkerInvariants(expandedBlocks, state.scenes);
          const initialWindowEnd = Math.min(INITIAL_WINDOW_SIZE, normalized.blocks.length);
          measuredHeightsRef.current.clear();
          cumulativeHRef.current = new Array(normalized.blocks.length + 1);
          cumulativeHRef.current[0] = 0;
          for (let i = 0; i < normalized.blocks.length; i++) {
            cumulativeHRef.current[i + 1] = cumulativeHRef.current[i] + DEFAULT_BLOCK_H;
          }
          blocksRef.current = normalized.blocks;
          blockIndexByIdRef.current = new Map(normalized.blocks.map((block, index) => [block.id, index]));
          applyWindowRange({ start: 0, end: initialWindowEnd }, true);
          setSpacerH({
            top: 0,
            bot: Math.max(0, (normalized.blocks.length - initialWindowEnd) * DEFAULT_BLOCK_H),
          });
          setBlocks(normalized.blocks);
          setCharacters(state.characters);
          setScenes(normalized.scenes);
          setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
          syncedStateRef.current = { ...state, blocks: normalized.blocks, scenes: normalized.scenes };
        }
        if (state.config) setScriptConfig({ ...DEFAULT_SCRIPT_CONFIG, ...state.config });

        // Capture version info from production route response
        if (isProdResponse) {
          const { versions: respVersions, versionId: respVid } = body as ProdResponse;
          setVersions(respVersions);
          const resolvedVid = respVid ?? activeVersionId;
          if (resolvedVid) {
            setActiveVersionId(resolvedVid);
            const ver = respVersions.find((v: Version) => v.id === resolvedVid);
            setVersionStatus(ver?.status ?? null);
          }
        }

        setLoadState("ready");
        setMigrationProgress(null);

        // Load tag groups and block tags in parallel (non-blocking)
        if (productionId) {
          Promise.all([
            fetch(`${BASE_PATH}/api/production/${productionId}/tag-groups`).then(r => r.ok ? r.json() : null),
            fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/block-tags`).then(r => r.ok ? r.json() : null),
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
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [effectiveScriptId, productionId, activeVersionId, applyWindowRange]);

  useEffect(() => {
    if (!productionId || !activeVersionId || loadState !== "ready") return;
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${encodeURIComponent(activeVersionId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setSceneDetails(syncSceneDetailsWithScenes(data as SceneDetail[], scenesRef.current));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [productionId, activeVersionId, loadState]);

  // ── Presence — must be declared before the SSE effect that closes over setPresenceMap ──

  const [clientId] = useState<string>(() =>
    typeof window !== "undefined" ? getOrCreateClientId() : ""
  );
  const [userName, setUserName] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const stored = localStorage.getItem("presence_name");
    return stored || anonymousName(getOrCreateClientId());
  });
  const [presenceMap, setPresenceMap] = useState<Map<string, RemotePresence>>(new Map());
  const presenceCountRef = useRef(0);
  const lastSentPresenceRef = useRef<{ versionId: string | null; blockId: string | null } | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [streamVisible, setStreamVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState === "visible"
  );

  useEffect(() => {
    const updateStreamVisibility = () => {
      setStreamVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", updateStreamVisibility);
    return () => document.removeEventListener("visibilitychange", updateStreamVisibility);
  }, []);

  // ── Hash-based deep link ─────────────────────────────────────────────────────
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
      }
      return () => clearTimeout(unlockTimer);
    }
    return () => clearTimeout(unlockTimer);
  }, [loadState, scrollToBlockIdx]);

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
          const vParam = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
          const r = await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}${vParam}`);
          if (r.status === 202) {
            streamDebounceTimerRef.current = setTimeout(() => {
              streamDebounceTimerRef.current = null;
              handleSeq(seq);
            }, 1200);
            return;
          }
          if (!r.ok) return;
          const serverState = await r.json() as ScriptState;

          const oldSynced = syncedStateRef.current;
          serverSeqRef.current = seq;

          const mergedBlocks = expandLegacyMarkersToBlocks(mergeServerBlocks(blocksRef.current, serverState.blocks, oldSynced), serverState.scenes);
          const normalized = normalizeScriptMarkerInvariants(mergedBlocks, serverState.scenes);
          setBlocks(normalized.blocks);
          setCharacters(serverState.characters);
          setScenes(normalized.scenes);
          setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, normalized.scenes));
          syncedStateRef.current = { ...serverState, blocks: normalized.blocks, scenes: normalized.scenes };
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
  }, [effectiveScriptId, loadState, clientId, activeVersionId, resetToolbarMeasurement, streamVisible]);

  const [comments, setComments] = useState<Comment[]>([]);
  const [blockAssetsByBlockId, setBlockAssetsByBlockId] = useState<Map<string, BlockAssetBubbleItem[]>>(new Map());
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
  const [activeAssetBlockId, setActiveAssetBlockId] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [meOpenId, setMeOpenId] = useState("");
  const [meIsAdmin, setMeIsAdmin] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  // Resolve Feishu display name and identity on mount
  useEffect(() => {
    fetch(`${BASE_PATH}/api/me`)
      .then(r => r.json())
      .then((data: { name: string | null; openId: string | null; isAdmin: boolean }) => {
        if (data.name) {
          setUserName(data.name);
          localStorage.setItem("presence_name", data.name);
        }
        if (data.openId) setMeOpenId(data.openId);
        setMeIsAdmin(data.isAdmin ?? false);
      })
      .catch(() => {});
  }, []);

  // Load comments for this production
  useEffect(() => {
    if (!productionId) return;
    fetch(`${BASE_PATH}/api/script/${productionId}/comments`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.comments) setComments(d.comments); })
      .catch(() => {});
  }, [productionId]);

  const loadBlockAssetBubbles = useCallback(() => {
    if (!productionId) {
      setBlockAssetsByBlockId(new Map());
      return;
    }
    const qs = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/block-summary${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { blocks?: Array<{ blockId: string; asset: BlockAssetBubbleItem }> } | null) => {
        const grouped = new Map<string, BlockAssetBubbleItem[]>();
        for (const item of data?.blocks ?? []) {
          const blockAssets = grouped.get(item.blockId);
          if (blockAssets) {
            if (!blockAssets.some(asset => asset.id === item.asset.id)) blockAssets.push(item.asset);
          }
          else grouped.set(item.blockId, [item.asset]);
        }
        setBlockAssetsByBlockId(grouped);
      })
      .catch(() => setBlockAssetsByBlockId(new Map()));
  }, [productionId, activeVersionId]);

  useEffect(() => {
    loadBlockAssetBubbles();
  }, [loadBlockAssetBubbles]);

  const commentsByBlockId = useMemo(() => {
    const grouped = new Map<string, Comment[]>();
    for (const comment of comments) {
      const blockComments = grouped.get(comment.contextId);
      if (blockComments) blockComments.push(comment);
      else grouped.set(comment.contextId, [comment]);
    }
    return grouped;
  }, [comments]);

  const sendPresence = useCallback((blockId: string | null) => {
    if (!clientId || !effectiveScriptId) return;
    const lastSent = lastSentPresenceRef.current;
    if (lastSent?.versionId === activeVersionId && lastSent.blockId === blockId) return;
    lastSentPresenceRef.current = { versionId: activeVersionId, blockId };
    if (presenceTimerRef.current) clearTimeout(presenceTimerRef.current);
    presenceTimerRef.current = setTimeout(() => {
      const presenceQuery = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
      fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/presence${presenceQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, userName, blockId }),
      }).catch(() => {});
    }, 200);
  }, [clientId, effectiveScriptId, userName, activeVersionId]);

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

  // Debounced sync: fires 1500 ms after the last state change.
  const charactersRef = useRef(characters);
  const scriptConfigRef = useRef(scriptConfig);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { scriptConfigRef.current = scriptConfig; }, [scriptConfig]);

  useEffect(() => {
    if (loadState !== "ready") return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const curr: ScriptState = {
        config: scriptConfigRef.current,
        blocks: normalizeScriptBlockStream(blocksRef.current),
        characters: charactersRef.current,
        scenes: scenesRef.current,
      };
      pushPatchRef.current(curr);
    }, 1500);
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  // blockTagMap included so tag-only changes (inherit, paste, manual edit)
  // also trigger the debounced sync and embed tags in the block op.
  }, [blocks, characters, scenes, blockTagMap, loadState]);

  const flushPendingPatch = useCallback(async () => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (isSyncingRef.current) {
      await new Promise<void>((resolve) => {
        syncIdleWaitersRef.current.push(resolve);
      });
    }
    const curr: ScriptState = {
      config: scriptConfigRef.current,
      blocks: normalizeScriptBlockStream(blocksRef.current),
      characters: charactersRef.current,
      scenes: scenesRef.current,
    };
    await pushPatchRef.current(curr);
  }, []);

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
        markOwnershipDirty("full");
        setBlocks(nextBlocks);
      }
    }
    await saveScriptConfig({ stageDelimOpen: pending.open, stageDelimClose: pending.close });
  }, [
    markOwnershipDirty,
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
    markOwnershipDirty("full");
    setBlocks(snapshot);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, [isLockedMode, markOwnershipDirty]);

  const redo = useCallback(() => {
    if (isLockedMode) return;
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = redoStack.current.pop();
    if (!snapshot) return;
    undoStack.current.push(blocksRef.current);
    markOwnershipDirty("full");
    setBlocks(snapshot);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, [isLockedMode, markOwnershipDirty]);

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
        markBlockOwnershipDirty(blockId);
        setBlocks(bs => bs.map(b => b.id === blockId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
      }
    }
  }, [blockTagMapRef, markBlockOwnershipDirty, tagGroups, isLockedMode]);

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
      markBlockOwnershipDirty(toId);
      setBlocks(bs => bs.map(b => b.id === toId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
    }
    // Tags (and the corrected lyric) are synced atomically via the debounced block op PATCH.
  }, [blockTagMap, markBlockOwnershipDirty, tagGroups]);

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
  }, [undo, redo, handleTagPaste]);

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

  const toggleBlockType = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    markBlockOwnershipDirty(id);
    setBlocks((prev) => prev.map((b) =>
      b.id === id
        ? { ...b, type: b.type === "dialogue" ? "stage" : "dialogue", characterIds: [] }
        : b
    ));
    glowAndFocusBlocks([id]);
  }, [glowAndFocusBlocks, markBlockOwnershipDirty, saveSnapshot, isLockedMode]);

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
    markBlockOwnershipDirty(id);
    setBlocks((prev) => prev.map((b) =>
      b.id === id ? { ...b, lyric: !b.lyric } : b
    ));
    glowAndFocusBlocks([id]);
  }, [glowAndFocusBlocks, markBlockOwnershipDirty, saveSnapshot, isLockedMode]);

  const setBlocksType = useCallback((ids: string[], type: BlockType) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    markBlockIdsOwnershipDirty(targetIds);
    setBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id)
        ? { ...b, type, characterIds: type === "stage" ? [] : b.characterIds }
        : b
    ));
    glowAndFocusBlocks(ids);
    rangeSelectionActiveRef.current = false;
  }, [glowAndFocusBlocks, markBlockIdsOwnershipDirty, saveSnapshot, isLockedMode]);

  const setBlocksLyric = useCallback((ids: string[], lyric: boolean) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    markBlockIdsOwnershipDirty(targetIds);
    setBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id) && b.type !== "stage"
        ? { ...b, lyric }
        : b
    ));
    glowAndFocusBlocks(ids);
    rangeSelectionActiveRef.current = false;
  }, [glowAndFocusBlocks, markBlockIdsOwnershipDirty, saveSnapshot, isLockedMode]);

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
      markBlockOwnershipDirty(id);
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
    },
    [markBlockOwnershipDirty, startTypingSession, isLockedMode]
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
    const scene: Scene = { id: uid(), number: "", name: "", parentId: null };
    const marker = makeMarkerBlock("chapter_marker", { sceneId: scene.id });
    saveSnapshot();
    setScenes((prev) => normalizeSceneRowsForMarkers([...prev, scene], [...blocksRef.current, marker]));
    setSceneDetails((prev) => {
      const nextScenes = normalizeSceneRowsForMarkers([...scenesRef.current, scene], [...blocksRef.current, marker]);
      return syncSceneDetailsWithScenes([...prev, toSceneDetail(scene)], nextScenes);
    });
    const currentIdx = blocksRef.current.findIndex((block) => block.id === blockId);
    const insertIdx = currentIdx === -1 ? blocksRef.current.length : currentIdx;
    markOwnershipDirty({ start: insertIdx, end: insertIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === blockId);
      const insertIndex = idx === -1 ? prev.length : idx;
      return insertMarkerWithEmptyBlockIfNeeded(prev, marker, insertIndex);
    });
  }, [canEditMetadata, isLockedMode, markOwnershipDirty, saveSnapshot]);

  const addSceneBeforeBlock = useCallback((blockId: string) => {
    if (isLockedMode || !canEditMetadata) return;
    const chapterId = findChapterIdForBlock(blockId);
    const parentId = chapterId ?? null;
    const scene: Scene = { id: uid(), number: "", name: "", parentId };
    const marker = makeMarkerBlock(parentId ? "scene_marker" : "chapter_marker", { sceneId: scene.id });
    saveSnapshot();
    setScenes((prev) => normalizeSceneRowsForMarkers([...prev, scene], [...blocksRef.current, marker]));
    setSceneDetails((prev) => {
      const nextScenes = normalizeSceneRowsForMarkers([...scenesRef.current, scene], [...blocksRef.current, marker]);
      return syncSceneDetailsWithScenes([...prev, toSceneDetail(scene)], nextScenes);
    });
    const currentIdx = blocksRef.current.findIndex((block) => block.id === blockId);
    const insertIdx = currentIdx === -1 ? blocksRef.current.length : currentIdx;
    markOwnershipDirty({ start: insertIdx, end: insertIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === blockId);
      const insertIndex = idx === -1 ? prev.length : idx;
      return insertMarkerWithEmptyBlockIfNeeded(prev, marker, insertIndex);
    });
  }, [canEditMetadata, findChapterIdForBlock, isLockedMode, markOwnershipDirty, saveSnapshot]);

  const addRehearsalBeforeBlock = useCallback((blockId: string) => {
    if (isLockedMode || !effectiveCanEditRehearsalMark) return;
    const marker = makeMarkerBlock("rehearsal_marker", { rehearsalMark: `__auto_rehearsal_${uid()}` });
    saveSnapshot();
    const currentIdx = blocksRef.current.findIndex((block) => block.id === blockId);
    const insertIdx = currentIdx === -1 ? blocksRef.current.length : currentIdx;
    markOwnershipDirty({ start: insertIdx, end: insertIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === blockId);
      const insertIndex = idx === -1 ? prev.length : idx;
      return insertMarkerWithEmptyBlockIfNeeded(prev, marker, insertIndex);
    });
  }, [effectiveCanEditRehearsalMark, isLockedMode, markOwnershipDirty, saveSnapshot]);

  const convertMarkerBlockType = useCallback((blockId: string, nextType: Extract<BlockType, "chapter_marker" | "scene_marker">) => {
    if (isLockedMode || !canEditMetadata) return;
    const currentIdx = blockIndexByIdRef.current.get(blockId);
    if (currentIdx === undefined) return;
    const currentBlock = blocksRef.current[currentIdx];
    if (!currentBlock) return;
    if (!isMarkerBlock(currentBlock)) return;
    if (currentBlock.type === nextType) return;
    if (currentBlock.id === FIXED_INITIAL_CHAPTER_BLOCK_ID) return;

    const sceneId = currentBlock.sceneId ?? uid();
    const nextScene: Scene = {
      id: sceneId,
      number: "",
      name: "",
      parentId: nextType === "chapter_marker" ? null : findChapterIdForBlock(blockId),
    };
    const sceneExists = scenesRef.current.some((scene) => scene.id === nextScene.id);
    const convertedBlocks = blocksRef.current.map((block) => (
      block.id === blockId
        ? { ...block, type: nextType, sceneId }
        : block
    ));
    const previousMarker = previousAdjacentMarker(convertedBlocks, currentIdx);
    const repairedBlocks = repairEmptyMarkerSegments(
      convertedBlocks,
      [previousMarker?.id, blockId].filter((id): id is string => !!id)
    );
    const nextBlocks = repairedBlocks === convertedBlocks ? normalizeScriptBlockStream(convertedBlocks) : repairedBlocks;
    const nextScenes = normalizeSceneRowsForMarkers(
      sceneExists ? scenesRef.current : [...scenesRef.current, nextScene],
      nextBlocks
    );

    saveSnapshot();
    markOwnershipDirty({ start: currentIdx, end: currentIdx + 1, affectsMarkers: true });
    setBlocks(nextBlocks);
    setScenes(nextScenes);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(
      sceneExists ? prev : [...prev, toSceneDetail(nextScene)],
      nextScenes
    ));
    selectionAnchorBlockIdRef.current = blockId;
    rangeSelectionActiveRef.current = false;
    setSelectedBlockIds(new Set([blockId]));
  }, [canEditMetadata, findChapterIdForBlock, isLockedMode, markOwnershipDirty, saveSnapshot]);

  const splitBlock = useCallback((id: string, before: string, after: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate the new block ID **outside** the setBlocks updater so the ID
    // is stable across React Strict Mode's double-invocation of the updater.
    // If makeBlock() were called inside the updater, each invocation would
    // produce a different uid(), causing nextId (from the 2nd call) to diverge
    // from the block actually committed to state (from the 1st call).
    const nextBlockId = uid();
    const currentIdx = blocksRef.current.findIndex((block) => block.id === id);
    if (currentIdx !== -1) markOwnershipDirty({ start: currentIdx, end: currentIdx + 2, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const cur = prev[idx];
      // New block inherits scene, rehearsal mark, and character from the block being split
      const next: Block = {
        ...makeBlock(after, cur.characterIds),
        id: nextBlockId,   // use the pre-generated stable ID
        sceneId: null,
        rehearsalMark: null,
        characterAnnotations: { ...cur.characterAnnotations },
      };
      const updated = [...prev];
      updated[idx] = { ...cur, content: before };
      updated.splice(idx + 1, 0, next);
      pendingFocus.current = { id: next.id, textOffset: 0 };
      // Don't auto-open character picker: character is already inherited
      return updated;
    });
    inheritTags(id, nextBlockId);
  }, [markOwnershipDirty, saveSnapshot, inheritTags, isLockedMode]);

  const mergeBlock = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    const currentIdx = blocksRef.current.findIndex((block) => block.id === id);
    if (currentIdx !== -1) markOwnershipDirty({ start: Math.max(0, currentIdx - 1), end: currentIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === 0) {
        // Delete empty first block if there are more blocks after it
        if (prev.length > 1 && !prev[0].content.trim()) {
          pendingFocus.current = { id: prev[1].id, atEnd: false };
          return prev.slice(1);
        }
        return prev;
      }
      const p = prev[idx - 1];
      const c = prev[idx];
      const mergedContent =
        p.content && c.content ? `${p.content}\n${c.content}` : p.content + c.content;
      const merged = { ...p, content: mergedContent };
      const updated = [...prev];
      updated[idx - 1] = merged;
      updated.splice(idx, 1);
      // Place cursor right after the \n separator (= start of the merged-in content).
      // When only one side is non-empty there's no \n, so offset = end of p.content.
      const pLen = getTextLength(mdToHtml(p.content));
      pendingFocus.current = {
        id: p.id,
        textOffset: p.content && c.content ? pLen + 1 : pLen,
      };
      return updated;
    });
  }, [markOwnershipDirty, saveSnapshot, isLockedMode]);

  const blockedDramaturgyMarkerKindForBlockIds = useCallback((ids: Iterable<string>): MarkerDetailDeleteBlockedKind | null => {
    const currentBlocks = blocksRef.current;
    const currentIndexById = blockIndexByIdRef.current;
    for (const id of ids) {
      const index = currentIndexById.get(id);
      const block = index === undefined ? undefined : currentBlocks[index];
      if (!block) continue;
      const detail = block.sceneId ? sceneDetailById.get(block.sceneId) ?? null : null;
      const blockedKind = markerBlockDramaturgyDeleteBlockedKind(block, detail);
      if (blockedKind) return blockedKind;
    }
    return null;
  }, [sceneDetailById]);

  const deleteBlock = useCallback((id: string) => {
    if (isLockedMode) return;
    if (id === FIXED_INITIAL_CHAPTER_BLOCK_ID) return;
    const currentIdx = blockIndexByIdRef.current.get(id);
    if (currentIdx === undefined) return;
    if (
      blocksRef.current[currentIdx].type === "rehearsal_marker" &&
      rehearsalMarkerDeleteIds(blocksRef.current, currentIdx).size === 0
    ) {
      return;
    }
    const blockedKind = blockedDramaturgyMarkerKindForBlockIds([id]);
    if (blockedKind) {
      setMarkerDetailDeleteBlockedKind(blockedKind);
      return;
    }
    saveSnapshot();
    // Pre-generate replacement block ID outside the updater (Strict Mode fix).
    const emptyBlockId = uid();
    markOwnershipDirty({ start: currentIdx, end: currentIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      if (prev.length <= 1) {
        const emptyBlock = { ...makeBlock(), id: emptyBlockId };
        pendingFocus.current = { id: emptyBlock.id, atEnd: false };
        return [emptyBlock];
      }
      const previousMarker = previousAdjacentMarker(prev, idx);
      const deleteIds = rehearsalMarkerDeleteIds(prev, idx);
      let nextFocus: Block | undefined;
      for (let cursor = idx + 1; cursor < prev.length; cursor++) {
        if (!deleteIds.has(prev[cursor].id)) {
          nextFocus = prev[cursor];
          break;
        }
      }
      for (let cursor = idx - 1; !nextFocus && cursor >= 0; cursor--) {
        if (!deleteIds.has(prev[cursor].id)) nextFocus = prev[cursor];
      }
      if (nextFocus) pendingFocus.current = { id: nextFocus.id, atEnd: false };
      const remaining = prev.filter((b) => !deleteIds.has(b.id));
      return repairEmptyMarkerSegments(remaining, [previousMarker?.id].filter((markerId): markerId is string => !!markerId));
    });
    setSelectedBlockIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (selectionAnchorBlockIdRef.current === id) {
      selectionAnchorBlockIdRef.current = null;
      rangeSelectionActiveRef.current = false;
    }
  }, [blockedDramaturgyMarkerKindForBlockIds, markOwnershipDirty, saveSnapshot, isLockedMode]);

  const deleteBlocks = useCallback((ids: string[]) => {
    if (isLockedMode) return;
    const deleteIds = new Set<string>();
    for (const id of ids) {
      if (id === FIXED_INITIAL_CHAPTER_BLOCK_ID) continue;
      const index = blockIndexByIdRef.current.get(id);
      if (
        ids.length === 1 &&
        index !== undefined &&
        blocksRef.current[index]?.type === "rehearsal_marker" &&
        rehearsalMarkerDeleteIds(blocksRef.current, index).size === 0
      ) {
        continue;
      }
      deleteIds.add(id);
    }
    if (deleteIds.size === 0) return;
    const blockedKind = blockedDramaturgyMarkerKindForBlockIds(deleteIds);
    if (blockedKind) {
      setMarkerDetailDeleteBlockedKind(blockedKind);
      return;
    }
    saveSnapshot();
    const emptyBlockId2 = uid(); // pre-generated for the case where all blocks are deleted
    const firstDeletedIdx = blocksRef.current.findIndex((block) => deleteIds.has(block.id));
    if (firstDeletedIdx !== -1) markOwnershipDirty({ start: firstDeletedIdx, end: firstDeletedIdx + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const remaining: Block[] = [];
      const markersToRepair = new Set<string>();
      let firstDeletedIdx = -1;
      for (let index = 0; index < prev.length; index++) {
        const block = prev[index];
        if (!deleteIds.has(block.id)) {
          remaining.push(block);
          continue;
        }
        if (firstDeletedIdx === -1) firstDeletedIdx = index;
        const previousMarker = previousAdjacentMarker(prev, index);
        if (previousMarker) markersToRepair.add(previousMarker.id);
      }
      if (remaining.length === prev.length) return prev;
      if (remaining.length === 0) {
        const emptyBlock = { ...makeBlock(), id: emptyBlockId2 };
        pendingFocus.current = { id: emptyBlock.id, atEnd: false };
        return [emptyBlock];
      }
      const focusIdx = Math.min(firstDeletedIdx, remaining.length - 1);
      pendingFocus.current = { id: remaining[focusIdx].id, atEnd: false };
      return repairEmptyMarkerSegments(remaining, markersToRepair, { includeTerminal: true });
    });
    setSelectedBlockIds((current) => {
      const next = new Set(current);
      for (const id of deleteIds) next.delete(id);
      return next;
    });
    if (selectionAnchorBlockIdRef.current && deleteIds.has(selectionAnchorBlockIdRef.current)) {
      selectionAnchorBlockIdRef.current = null;
      rangeSelectionActiveRef.current = false;
    }
  }, [blockedDramaturgyMarkerKindForBlockIds, markOwnershipDirty, saveSnapshot, isLockedMode]);

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
    const cleanupAnalysis = analyzeEmptyScriptCleanup(blocksRef.current, scenesRef.current, sceneDetailById);
    if (!cleanupAnalysis.hasEmptyTextBlock && cleanupAnalysis.targets.length === 0) {
      showReorderNotice("没有可清除的空白内容。");
      setOpenMenu(null);
      return;
    }
    setEmptyScriptCleanupDialog(cleanupAnalysis.targets);
    setOpenMenu(null);
  }, [canEditText, isLockedMode, sceneDetailById, setEmptyScriptCleanupDialog, showReorderNotice]);

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
    const selectedSceneIds = new Set(
      selectedTargets
        .filter((target) => target.kind === "chapter" || target.kind === "scene")
        .map((target) => target.id)
    );
    const selectedRehearsalBlockIds = new Set(
      selectedTargets
        .filter((target) => target.kind === "rehearsal")
        .map((target) => target.id)
    );
    const deleteBlockIds = new Set<string>(emptyTextBlockIds);
    const markersToRepair = new Set<string>();
    let currentSectionSelected = false;
    let currentRehearsalSelected = false;
    let currentMarkerId: string | null = null;
    for (const block of currentBlocks) {
      if (block.type === "chapter_marker") {
        currentSectionSelected = !!block.sceneId && selectedSceneIds.has(block.sceneId);
        currentRehearsalSelected = false;
        currentMarkerId = block.id;
        if (
          block.sceneId &&
          selectedSceneIds.has(block.sceneId) &&
          block.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID
        ) {
          deleteBlockIds.add(block.id);
        }
        continue;
      }
      if (block.type === "scene_marker") {
        currentSectionSelected = !!block.sceneId && selectedSceneIds.has(block.sceneId);
        currentRehearsalSelected = false;
        currentMarkerId = block.id;
        if (block.sceneId && selectedSceneIds.has(block.sceneId)) {
          deleteBlockIds.add(block.id);
        }
        continue;
      }
      if (block.type === "rehearsal_marker") {
        currentRehearsalSelected = currentSectionSelected || selectedRehearsalBlockIds.has(block.id);
        if (currentRehearsalSelected) {
          deleteBlockIds.add(block.id);
          if (currentMarkerId) markersToRepair.add(currentMarkerId);
        } else {
          currentMarkerId = block.id;
        }
        continue;
      }
      if (currentSectionSelected || currentRehearsalSelected) {
        deleteBlockIds.add(block.id);
      } else if (currentMarkerId && isEmptyTextBlock(block)) {
        markersToRepair.add(currentMarkerId);
      }
    }

    const remainingBlocks = currentBlocks.filter((block) => !deleteBlockIds.has(block.id));
    const remainingScenes = scenesRef.current.filter((scene) => !selectedSceneIds.has(scene.id));
    const repairedBlocks = repairEmptyMarkerSegments(remainingBlocks, markersToRepair);
    const normalized = normalizeScriptMarkerInvariants(
      repairedBlocks.length > 0 ? repairedBlocks : [makeBlock()],
      remainingScenes
    );

    saveSnapshot();
    markOwnershipDirty("full");
    resetScriptInteractions();
    setEmptyScriptCleanupDialog(null);
    setBlocks(normalized.blocks);
    setScenes(normalized.scenes);
    setSceneDetails((prev) => syncSceneDetailsWithScenes(
      prev.filter((scene) => !selectedSceneIds.has(scene.id)),
      normalized.scenes
    ));
    showReorderNotice("已清除选中空白内容。");
  }, [canEditText, deleteBlocks, isLockedMode, markOwnershipDirty, pendingEmptyScriptCleanup, resetScriptInteractions, saveSnapshot, setEmptyScriptCleanupDialog, showReorderNotice]);

  const blockIdsRequireNonEmptySceneConfirm = useCallback((ids: string[]) => ids.some((id) => {
    const index = blockIndexByIdRef.current.get(id);
    if (index === undefined) return false;
    const block = blocks[index];
    return !!block && isBlockEmptyForDelete(block) && isOnlyTextBlockInMarkerSegment(ownedBlocks, index);
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
  }, [blocks, deleteBlocks, requestLargeSelectionOperation, selectedBlockIds, selectedBlockIdsArray, selectedBlocksAreEmptyForDelete, selectedBlocksRequireNonEmptySceneConfirm, windowRange.end, windowRange.start, isLockedMode]);

  const dismissBlockConfirmations = useCallback(() => {
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
    setMarkerDetailDeleteConfirmBlockId(null);
    setDismissActionToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (draggingBlockId.current || isReorderLockedRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("a[href]")) return;
      const docEl = document.documentElement;
      const isViewportScrollbar = e.clientX >= docEl.clientWidth || e.clientY >= docEl.clientHeight;
      if (isViewportScrollbar) return;
      if (target.closest("[data-script-scene-detail='true']")) return;
      if (target.closest("[data-script-confirmation='true']")) return;
      if (target.closest("[data-script-block-bar='true']") || target.closest("[data-script-marker-bar='true']") || target.closest("[data-script-selection-action='true']")) {
        dismissBlockConfirmations();
        return;
      }
      if (selectedBlockIds.size > 0) {
        selectionAnchorBlockIdRef.current = null;
        rangeSelectionActiveRef.current = false;
        setSelectedBlockIds((current) => current.size === 0 ? current : new Set());
      }
      dismissBlockConfirmations();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [dismissBlockConfirmations, selectedBlockIds.size]);

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
    const movingIds = new Set(fromIds.filter((id) => id !== FIXED_INITIAL_CHAPTER_BLOCK_ID));
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
    const markersToRepair = new Set<string>();
    const previousMarkerAtSource = previousAdjacentMarker(prev, prev.indexOf(moving[0]));
    if (previousMarkerAtSource) markersToRepair.add(previousMarkerAtSource.id);
    const next = [...remaining];
    next.splice(insertIdx, 0, ...moving);
    const previousMarkerAtTarget = previousAdjacentMarker(next, insertIdx);
    if (previousMarkerAtTarget) markersToRepair.add(previousMarkerAtTarget.id);
    const firstMoved = moving[0];
    if (firstMoved && isMarkerBlock(firstMoved)) markersToRepair.add(firstMoved.id);
    const lastMoved = moving[moving.length - 1];
    if (lastMoved && isMarkerBlock(lastMoved)) markersToRepair.add(lastMoved.id);
    if (next.every((b, i) => b.id === prev[i]?.id)) {
      showReorderNotice("移动未执行：目标位置与当前位置相同。");
      return false;
    }
    const repairedNext = repairEmptyMarkerSegments(next, markersToRepair);
    const normalizedNext = repairedNext === next ? normalizeScriptBlockStream(next) : repairedNext;
    const movedStartIndex = normalizedNext.findIndex((block) => movingIds.has(block.id));
    let movingHasMarker = false;
    let movedTextCount = 0;
    for (const block of moving) {
      if (isMarkerBlock(block)) movingHasMarker = true;
      else movedTextCount += 1;
    }
    let movedTextOwnershipChanged = false;
    let firstMovedTextOwned: Pick<Block, "sceneId" | "rehearsalMark"> | undefined;
    if (!movingHasMarker && movedTextCount > 0 && movedStartIndex >= 0) {
      const movedOwnership = markerOwnershipRange(normalizedNext, movedStartIndex, movedStartIndex + moving.length);
      movedTextOwnershipChanged = moving.some((block, offset) => {
        if (isMarkerBlock(block)) return false;
        firstMovedTextOwned ??= movedOwnership[offset];
        const beforeIdx = blockIndexByIdRef.current.get(block.id);
        const before = beforeIdx === undefined ? null : ownedBlocksRef.current[beforeIdx];
        const after = movedOwnership[offset];
        return before?.sceneId !== after?.sceneId || before?.rehearsalMark !== after?.rehearsalMark;
      });
    }

    requestLargeSelectionOperation("move", moving.length, () => {
      saveSnapshot();
      markOwnershipDirty("full");
      pendingMoveCenterRef.current = moving[0].id;
      if (movingHasMarker) {
        const nextScenes = normalizeSceneRowsForMarkers(scenesRef.current, normalizedNext);
        setScenes(nextScenes);
        setSceneDetails((prev) => syncSceneDetailsWithScenes(prev, nextScenes));
      }
      setBlocks(normalizedNext);
      glowChangedBlocks(moving.map((b) => b.id));
      selectionAnchorBlockIdRef.current = moving[0]?.id ?? null;
      rangeSelectionActiveRef.current = false;
      setSelectedBlockIds(new Set(moving.map((b) => b.id)));
      if (movingHasMarker) {
        showSelectionChangeNotice("章节标记/段落标记/排练记号已更新。");
      } else if (movedTextOwnershipChanged) {
        const scene = firstMovedTextOwned?.sceneId ? sceneById.get(firstMovedTextOwned.sceneId) : null;
        const sceneLabel = scene
          ? [scene.number.trim(), scene.name.trim()].filter(Boolean).join("-") || "（未命名）"
          : "（无章节）";
        const markLabel = firstMovedTextOwned?.rehearsalMark?.trim() || "(空)";
        showSelectionChangeNotice(`当前 ${movedTextCount} 行的章节与排练记号已更改为：${sceneLabel}-${markLabel}`);
      }
      unlockReorderAfterCommit();
    }, unlockReorder);
    return true;
  }, [glowChangedBlocks, markOwnershipDirty, requestLargeSelectionOperation, saveSnapshot, sceneById, showReorderNotice, showSelectionChangeNotice, unlockReorder, unlockReorderAfterCommit, isLockedMode]);

  const isNoopDragTarget = useCallback((fromIds: string[], target: DragTarget): boolean => {
    const movingIds = new Set(fromIds.filter((id) => id !== FIXED_INITIAL_CHAPTER_BLOCK_ID));
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
  }, [setEdgeDragTarget, isLockedMode]);

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
  }, [clearDragCountBadge, clearDragTarget, lockReorder, moveDraggedBlocks, setScriptDragging, unlockReorder, isLockedMode]);

  const insertBlockAt = useCallback((index: number) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate the new block ID outside the updater (Strict Mode double-invocation fix).
    const newBlockId = uid();
    // refId must also be determined outside the updater; read it from blocksRef.
    const refId = index > 0 ? (blocksRef.current[index - 1]?.id ?? null) : null;
    markOwnershipDirty({ start: index, end: index + 1, affectsMarkers: true });
    setBlocks((prev) => {
      const newBlock: Block = {
        ...makeBlock(),
        id: newBlockId,  // use the pre-generated stable ID
        sceneId: null,
        rehearsalMark: null,
      };
      const updated = [...prev];
      updated.splice(index, 0, newBlock);
      pendingCharOpen.current = newBlock.id;
      return normalizeScriptBlockStream(updated);
    });
    if (refId) inheritTags(refId, newBlockId);
  }, [markOwnershipDirty, saveSnapshot, inheritTags, isLockedMode]);

  const addChar = (name: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => [...prev, { id: uid(), name, isAggregate: false }]);
  };

  const removeChar = (charId: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    markOwnershipDirty("full");
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
      await flushPendingPatch();
      const response = await request();
      if (!response.ok || response.status === 202) throw new Error(failureMessage);
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
      () => fetch(`${BASE_PATH}/api/production/${productionId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      "添加章节失败，请稍后重试。"
    );
  };

  const updateScene = async (id: string, name: string) => {
    if (isLockedMode || !productionId || !canEditMetadata) return;
    await runSceneMenuMutation(
      () => fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activeVersionId ? { name, versionId: activeVersionId } : { name }),
      }),
      "更新章节失败，请稍后重试。"
    );
  };

  const removeScene = async (id: string) => {
    if (isLockedMode || !productionId || !canEditMetadata) return;
    if (id === FIXED_INITIAL_CHAPTER_BLOCK_ID) return;
    await runSceneMenuMutation(
      () => fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activeVersionId ? { versionId: activeVersionId } : {}),
      }),
      "删除章节失败，请稍后重试。"
    );
  };

  const patchSceneMeta = async (id: string, fields: Partial<SceneMetaFields>) => {
    if (!productionId || !canEditMetadata) return;
    const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activeVersionId ? { ...fields, versionId: activeVersionId } : fields),
    });
    if (response.status === 202) {
      const body = await response.json().catch(() => null) as { migration?: MigrationProgress } | null;
      setMigrationProgress(body?.migration ?? null);
      setLoadState("updating");
      return;
    }
    if (!response.ok) throw new Error("Failed to update scene metadata");
    setSceneDetails((prev) => prev.map((scene) => (scene.id === id ? { ...scene, ...fields } : scene)));
  };

  const [printPreview, setPrintPreview] = useState(false);
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

    if (kind === "comment") {
      setActiveAssetBlockId(null);
      setActiveCommentBlockId(nextBlockId);
    } else {
      setActiveCommentBlockId(null);
      setActiveAssetBlockId(nextBlockId);
    }

    const blockIndex = blocksRef.current.findIndex(block => block.id === nextBlockId);
    if (blockIndex >= 0) scrollToBlockIdx(blockIndex, "center");
  }, [
    assetPanelNavigationTargets,
    commentPanelNavigationTargets,
    scrollToBlockIdx,
  ]);

  if (printPreview) {
    return (
      <PrintPreview
        blocks={ownedBlocks}
        characters={characters}
        scenes={scenes}
        pageLayout={scriptConfig.pageLayout}
        stageDelimOpen={scriptConfig.stageDelimOpen}
        stageDelimClose={scriptConfig.stageDelimClose}
        textLayoutMode={scriptConfig.textLayoutMode}
        canEditTextLayout={baseCanEditMetadata}
        onTextLayoutModeChange={(mode) => saveScriptConfig({ textLayoutMode: mode })}
        onClose={() => setPrintPreview(false)}
      />
    );
  }

  if (loadState === "loading" || loadState === "updating") {
    const localElapsedMs = migrationProgress?.startedAt
      ? Math.max(0, migrationNow - migrationProgress.startedAt)
      : migrationProgress?.elapsedMs ?? 0;
    const baseProgress = Math.max(1, Math.min(99, Math.round(migrationProgress?.progress ?? 8)));
    const estimatedProgress = migrationProgress?.estimatedTotalMs
      ? Math.min(94, Math.max(baseProgress, Math.round((localElapsedMs / migrationProgress.estimatedTotalMs) * 94)))
      : baseProgress;
    const progress = Math.max(1, Math.min(99, estimatedProgress));
    const localRemainingMs = migrationProgress?.estimatedTotalMs
      ? Math.max(1000, migrationProgress.estimatedTotalMs - localElapsedMs)
      : migrationProgress?.estimatedRemainingMs ?? null;
    const elapsedText = formatMigrationElapsed(localElapsedMs);
    const remainingText = formatMigrationRemaining(localRemainingMs);
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100">
        {loadState === "updating" ? (
          <div className="w-[min(22rem,calc(100vw-2rem))]">
            <div className="mb-3 flex items-center justify-between text-sm text-zinc-500">
              <span className="font-medium">数据更新中...</span>
              <span className="tabular-nums">{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200">
              <div
                className="h-full rounded-full bg-[#2f6fed] transition-[width] duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-zinc-400">
              <span className="truncate">{migrationProgress?.phase ?? "正在更新数据"}</span>
              {remainingText ? <span className="shrink-0">{remainingText}</span> : null}
            </div>
            <div className="mt-1 text-xs text-zinc-400">{elapsedText}</div>
          </div>
        ) : (
          <span className="text-sm text-zinc-400">加载中...</span>
        )}
      </div>
    );
  }

  if (loadState === "not-found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-100">
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
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-100">
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
  const forcedLockedModeSwitchClass = versionForcesLockedMode ? "bg-[#91a8ca]/50" : undefined;
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
  const effectiveViewportWidth = viewportWidth || (typeof window === "undefined" ? 0 : window.innerWidth);
  const rootFontSizePx = typeof window === "undefined"
    ? 16
    : parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const scriptSideGutterWidth = Math.max(0, (effectiveViewportWidth - SCRIPT_EDITOR_MAX_WIDTH_PX) / 2);
  const scriptTocRailGapPx = SCRIPT_TOC_RAIL_GAP_REM * rootFontSizePx;
  const scriptTocRailLayout = measureScriptTocRailLayout(scenes, rootFontSizePx);
  const scriptTocRailFullWidthPx = scriptTocRailLayout.railWidthPx;
  const scriptTocRailCompactWidthPx =
    (SCRIPT_TOC_RAIL_COMPACT_WIDTH_REM + SCRIPT_TOC_RAIL_SCROLLBAR_WIDTH_REM) * rootFontSizePx;
  const scriptLeftPanelLeftPx = rootFontSizePx;
  const scriptContentsMenuRightPx = scriptSideGutterWidth - scriptTocRailGapPx;
  const scriptSceneDetailWidthPx = Math.max(0, scriptSideGutterWidth - scriptLeftPanelLeftPx);
  const scriptSceneDetailRailMinWidthPx = SCRIPT_SCENE_DETAIL_RAIL_MIN_WIDTH_REM * rootFontSizePx;
  const scriptTocRailMode: "full" | "compact" | null =
    effectiveViewportWidth <= 0
      ? null
      : scriptSideGutterWidth >= scriptTocRailFullWidthPx
        ? "full"
        : scriptSideGutterWidth >= scriptTocRailCompactWidthPx
          ? "compact"
          : null;
  const scriptContentsMenuWidthPx = scriptTocRailMode === "compact"
    ? scriptTocRailCompactWidthPx
    : scriptTocRailFullWidthPx;
  const showSceneDetailRail =
    scriptTocRailMode === "full" &&
    !!productionId &&
    scriptSceneDetailWidthPx >= scriptSceneDetailRailMinWidthPx;
  const scriptRailContainerWidthPx = showSceneDetailRail
    ? scriptSceneDetailWidthPx
    : scriptContentsMenuWidthPx;
  const scriptRailContainerLeftPx = showSceneDetailRail
    ? scriptLeftPanelLeftPx
    : Math.max(scriptLeftPanelLeftPx, scriptContentsMenuRightPx - scriptContentsMenuWidthPx);
  const scriptContentsMenuLeftPx = Math.max(scriptLeftPanelLeftPx, scriptContentsMenuRightPx - scriptContentsMenuWidthPx);
  const scriptContentsMenuOffsetPx = showSceneDetailRail
    ? scriptContentsMenuLeftPx - scriptRailContainerLeftPx
    : 0;
  const scriptSceneDetailScrollbarOffsetPx = showSceneDetailRail
    ? Math.max(0, scriptContentsMenuRightPx - 0.875 * rootFontSizePx - scriptSideGutterWidth)
    : 0;
  const sceneIdForBlockAtIndex = (block: Block, index: number): string | null => {
    if ((block.type === "chapter_marker" || block.type === "scene_marker") && block.sceneId) {
      return block.sceneId;
    }
    return ownedBlocks[index]?.sceneId ?? block.sceneId ?? null;
  };
  const sceneIdForBlockId = (blockId: string | null | undefined): string | null => {
    if (!blockId) return null;
    const blockIndex = blockIndexByIdRef.current.get(blockId) ?? -1;
    return blockIndex >= 0 ? sceneIdForBlockAtIndex(blocks[blockIndex], blockIndex) : null;
  };
  const selectedDetailSceneId = selectedBlockIds.size === 1
    ? (detailBlockVisibility.selected ? sceneIdForBlockId(selectedDetailBlockId) : null)
    : null;
  const focusedDetailSceneId = detailBlockVisibility.focused ? sceneIdForBlockId(focusedId) : null;
  const markerDeleteConfirmDetailSceneId = sceneIdForBlockId(markerDetailDeleteConfirmBlockId);
  const detailSceneId = markerDeleteConfirmDetailSceneId ?? (
    selectedBlockIds.size > 1
      ? null
      : selectedDetailSceneId ?? focusedDetailSceneId ?? activeSceneId
  );
  const activeScene = detailSceneId ? sceneById.get(detailSceneId) ?? null : null;
  const activeSceneDetail = activeScene
    ? sceneDetailById.get(activeScene.id) ?? toSceneDetail(activeScene)
    : null;
  const rightGutterCanShowComments = scriptSideGutterWidth >= COMMENT_BUBBLE_MIN_GUTTER_PX;
  const commentBubbleMaxWidth = Math.max(COMMENT_BUBBLE_MIN_WIDTH_PX, scriptSideGutterWidth - 24);
  const activeCommentBlockIndex = activeCommentBlockId
    ? blocks.findIndex(block => block.id === activeCommentBlockId)
    : -1;
  const activeCommentBlockCaption = activeCommentBlockIndex >= 0
    ? buildCommentBlockCaption(blocks[activeCommentBlockIndex], characters, activeCommentBlockIndex)
    : null;
  const activeAssetBlockIndex = activeAssetBlockId
    ? blocks.findIndex(block => block.id === activeAssetBlockId)
    : -1;
  const activeAssetBlockCaption = activeAssetBlockIndex >= 0
    ? buildCommentBlockCaption(blocks[activeAssetBlockIndex], characters, activeAssetBlockIndex)
    : null;
  const dragInstructionNotice = !edgeDragNotice && (isScriptDragging || isReorderLocked)
      ? "拖拽当前剧本块至指定位置松开以调整位置"
      : "";
  const rightMenuClass = `${
    moreMenuOpen
      ? "fixed right-2 top-64"
      : toolbarCompact
        ? "fixed right-2 top-14"
        : "absolute right-0 top-full"
  } z-30 mt-1 rounded-xl border border-zinc-100 bg-white py-1 shadow-md`;

  return (
    <div className="min-h-screen bg-zinc-100">
      {/* Toolbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-100 bg-white shadow-sm">
        <div
          ref={setToolbarElement}
          className="relative mx-auto flex h-14 flex-nowrap items-center gap-1 px-4"
          style={{ maxWidth: SCRIPT_EDITOR_MAX_WIDTH_PX }}
        >
          <Link
            href={productionId ? `/production/${productionId}` : "/"}
            onNavigate={prepareForNavigation}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回
          </Link>
          {!isLockedMode && (
            <>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />

              {/* 剧本▼ — 关于 + 元数据设置 */}
              <div className="relative shrink-0">
                <button
                  onClick={() => toggleMenu("script")}
                  className="flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
                >
                  剧本 <Chevron />
                </button>
                {openMenu === "script" && (
                  <div
                    className={`${toolbarCompact ? "fixed left-2 top-14" : "absolute left-0 top-full"} z-30 mt-1 w-52 rounded-xl border border-zinc-100 bg-white py-1 shadow-md`}
                    onMouseLeave={() => setOpenMenu(null)}
                  >
                    <button
                      onClick={() => { setAboutOpen(true); setOpenMenu(null); }}
                      className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      关于
                    </button>
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
                      ] as [import("@/lib/script-types").PageLayout, string][]
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
                          onClick={() => { setTagEditorOpen(true); setOpenMenu(null); }}
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
                        {canImport && (
                          <>
                            <Link
                              href={`/production/${productionId}/import-script`}
                              onNavigate={prepareForNavigation}
                              className="block w-full px-3 py-1.5 text-left text-sm text-blue-600 hover:bg-zinc-50"
                            >
                              导入
                            </Link>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {versions.length > 0 && productionId && (
              <>
                <div className="h-4 w-px shrink-0 bg-zinc-100" />
                <VersionSelector
                  productionId={productionId}
                  versions={versions}
                  currentVersionId={activeVersionId}
                  canManage={canManageVersions}
                  onNavigate={prepareForNavigation}
                  onChange={(vid) => {
                    setActiveVersionId(vid);
                    const ver = versions.find(v => v.id === vid);
                    setVersionStatus(ver?.status ?? null);
                  }}
                />
              </>
            )}
          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-400">
              {canEdit ? "可编辑" : "只读"}
            </span>
          </div>
          {!baseCanEdit && (
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-400">
              只读
            </span>
          )}
          {baseCanEdit && isLockedMode && (
            <div
              className="flex flex-1 justify-center"
            >
              <button
                onClick={toggleLockedMode}
                aria-pressed={isLockedMode}
                disabled={versionForcesLockedMode}
                title={versionForcesLockedMode ? "该版本仅可使用排练模式" : "退出排练模式"}
                className={`flex shrink-0 items-center gap-2 rounded px-2 py-1 text-sm font-medium transition-colors ${
                  versionForcesLockedMode
                    ? "cursor-default text-[#91a8ca]"
                    : "text-teal-600 hover:bg-teal-50 hover:text-teal-700"
                } whitespace-nowrap`}
              >
                <ModeSwitch active={isLockedMode} activeClassName={forcedLockedModeSwitchClass} />
                <span>{(toolbarShort || toolbarCompact) ? "排练" : "排练模式"}</span>
              </button>
            </div>
          )}
          <div className="ml-auto h-4 w-px shrink-0 bg-zinc-100" />
          {(canEditMetadata || isLockedMode) && (
            <>
              {canEditMetadata && (
                <>
                  <ScenePanel
                    scenes={scenes}
                    productionId={productionId ?? ""}
                    onAdd={(parentId) => addScene(parentId)}
                    onUpdate={updateScene}
                    onRemove={removeScene}
                    open={openMenu === "scene"}
                    onOpenChange={(v) => setOpenMenu(v ? "scene" : null)}
                    canImport={canImport}
                    onNavigate={prepareForNavigation}
                    triggerClassName={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
                    nestedFromMore={moreMenuOpen}
                    label={toolbarShort ? "章" : "章节"}
                  />
                  <div className={`${toolbarCompact ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
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
                nestedFromMore={moreMenuOpen}
                label={toolbarShort ? "角" : "角色"}
              />
              <div className={`${toolbarCompact ? "hidden" : "block"} h-4 w-px shrink-0 bg-zinc-100`} />
            </>
          )}

          {/* 编辑▼ — undo/redo + 格式 + 搜索/跳转 */}
          <div className="relative shrink-0">
            <button
              onClick={() => toggleMenu("edit")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              {toolbarShort ? (isLockedMode ? "找" : "编") : (isLockedMode ? "查找" : "编辑")} <Chevron />
            </button>
            {openMenu === "edit" && (
              <div
                className={`${rightMenuClass} w-44`}
                onMouseLeave={() => setOpenMenu(null)}
              >
                {canEdit && (
                  <>
                    <button
                      onClick={() => { undo(); setOpenMenu(null); }}
                      disabled={!canUndo}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${canUndo ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"}`}
                    >
                      <span>撤销</span>
                      <kbd className="text-[10px] text-zinc-300">⌘Z</kbd>
                    </button>
                    <button
                      onClick={() => { redo(); setOpenMenu(null); }}
                      disabled={!canRedo}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${canRedo ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"}`}
                    >
                      <span>重做</span>
                      <kbd className="text-[10px] text-zinc-300">⌘⇧Z</kbd>
                    </button>
                    <div className="my-1 border-t border-zinc-50" />
                    <button
                      onMouseDown={e => { e.preventDefault(); applyFormatToFocused("b"); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="font-bold">粗体</span>
                      <kbd className="text-[10px] text-zinc-300">⌘B</kbd>
                    </button>
                    <button
                      onMouseDown={e => { e.preventDefault(); applyFormatToFocused("u"); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="underline">下划线</span>
                      <kbd className="text-[10px] text-zinc-300">⌘U</kbd>
                    </button>
                    <button
                      onMouseDown={e => { e.preventDefault(); toggleStageCueToFocused(); }}
                      onClick={() => setOpenMenu(null)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                    >
                      <span className="italic text-zinc-400">切换舞台提示</span>
                      <kbd className="text-[10px] text-zinc-300">⌘I</kbd>
                    </button>
                    <div className="my-1 border-t border-zinc-50" />
                  </>
                )}
                <button
                  onClick={() => { setSearchOpen(true); setOpenMenu(null); }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  <span>搜索</span>
                  <kbd className="text-[10px] text-zinc-300">⌘F</kbd>
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

          {/* 显示▼ */}
          <div className="relative shrink-0">
            <button
              onClick={() => toggleMenu("display")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              {toolbarShort ? "显" : "显示"} <Chevron />
            </button>
            {openMenu === "display" && (
              <div
                className={`${rightMenuClass} w-44`}
                onMouseLeave={() => setOpenMenu(null)}
              >
                {(
                  [
                    ["pageBreaks",     "分页线"],
                    ["lineNumbers",    "行号"],
                    ["rehearsalMarks", "排练记号"],
                    ["blockTags",      "Block 标签"],
                  ] as [keyof Pick<DisplaySettings, "pageBreaks" | "lineNumbers" | "rehearsalMarks" | "blockTags">, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => toggleDisplay(key)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                  >
                    <span>{label}</span>
                    <span className={`h-4 w-4 rounded border text-[10px] leading-none flex items-center justify-center transition-colors ${display[key] ? "border-zinc-800 bg-zinc-800 text-white" : "border-zinc-300 text-transparent"}`}>✓</span>
                  </button>
                ))}
                <button
                  onClick={() => { if (isLockedMode) toggleDisplay("rehearsalBlockScenes"); }}
                  disabled={!isLockedMode}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                    isLockedMode ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"
                  }`}
                  title="排练模式开启时显示每行所属章节"
                >
                  <span>逐行章节</span>
                  <span className={`h-4 w-4 rounded border text-[10px] leading-none flex items-center justify-center transition-colors ${
                    display.rehearsalBlockScenes && isLockedMode ? "border-zinc-800 bg-zinc-800 text-white" : "border-zinc-300 text-transparent"
                  }`}>✓</span>
                </button>
                <div className="my-1 border-t border-zinc-50" />
                <button
                  onClick={() => {
                    if (!baseCanEditMetadata) return;
                    saveScriptConfig({
                      textLayoutMode: scriptConfig.textLayoutMode === "compact" ? "center" : "compact",
                    });
                  }}
                  disabled={!baseCanEditMetadata}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                    baseCanEditMetadata ? "text-zinc-600 hover:bg-zinc-50" : "cursor-not-allowed text-zinc-300"
                  }`}
                  title={baseCanEditMetadata ? "保存为所有人共用的剧本排版模式" : "无权修改剧本排版模式"}
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
                      disabled={versionForcesLockedMode}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${
                        versionForcesLockedMode
                          ? "cursor-not-allowed text-[#91a8ca]"
                          : "text-zinc-600 hover:bg-zinc-50"
                      }`}
                      title={versionForcesLockedMode ? "该版本仅可使用排练模式" : undefined}
                    >
                      <span>排练模式</span>
                      <span className="flex items-center">
                        <ModeSwitch active={isLockedMode} activeClassName={forcedLockedModeSwitchClass} />
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Online users: self (dimmed) + overflow menu */}
          <div className="relative shrink-0">
            {(() => {
              const selfPresence: RemotePresence | null = clientId
                ? {
                    clientId,
                    userName: userName || "?",
                    color: presenceColor(clientId),
                    blockId: null,
                  }
                : null;
              const onlineUsers = [
                ...Array.from(presenceMap.values()).filter(p => p.clientId !== clientId),
                ...(selfPresence ? [selfPresence] : []),
              ];
              const maxVisibleAvatars = (toolbarShort || toolbarCompact)
                ? 2
                : isLockedMode
                  ? REHEARSAL_MODE_VISIBLE_PRESENCE_AVATARS
                  : EDITABLE_MODE_VISIBLE_PRESENCE_AVATARS;
              const overflowCount = onlineUsers.length > maxVisibleAvatars
                ? onlineUsers.length - maxVisibleAvatars + 1
                : 0;
              const visibleUsers = overflowCount > 0
                ? onlineUsers.slice(0, maxVisibleAvatars - 1)
                : onlineUsers;

              if (onlineUsers.length === 0) return null;

              const avatarStack = (
                <div className="flex items-center">
                  {visibleUsers.map(p => (
                    <div key={p.clientId} className={`-ml-1 first:ml-0 ${p.clientId === clientId ? "opacity-40" : ""}`}>
                      <PresenceAvatar
                        name={p.userName}
                        color={p.color}
                        title={p.clientId === clientId ? `${p.userName}（你）` : p.userName}
                      />
                    </div>
                  ))}
                  {overflowCount > 0 && (
                    <div className="-ml-1 first:ml-0">
                      <div
                        title={`展开 ${overflowCount} 位在线人员`}
                        className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1 text-[10px] font-bold text-zinc-500"
                      >
                        +{overflowCount}
                      </div>
                    </div>
                  )}
                </div>
              );

              if (overflowCount === 0) return avatarStack;

              return (
                <>
                  <button
                    type="button"
                    onClick={() => toggleMenu("presence")}
                    className="flex items-center rounded px-1 py-1 transition-colors hover:bg-zinc-100"
                    aria-label={`在线人员：${onlineUsers.length} 人`}
                    title={`在线人员：${onlineUsers.map(p => p.clientId === clientId ? `${p.userName}（你）` : p.userName).join("、")}`}
                  >
                    {avatarStack}
                  </button>
                  {openMenu === "presence" && (
                    <div
                      className={`${rightMenuClass} w-44`}
                      onMouseLeave={() => setOpenMenu(null)}
                    >
                      <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">在线人员</p>
                      {onlineUsers.map(p => (
                        <div key={p.clientId} className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-600">
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: p.color }}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {p.userName}{p.clientId === clientId ? "（你）" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* 导出▼ */}
          <div className="relative shrink-0">
            <button
              onClick={() => toggleMenu("export")}
              className={`${toolbarCompact ? "hidden" : "flex"} items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800`}
            >
              导出 <Chevron />
            </button>
            {openMenu === "export" && (
              <div
                className={`${rightMenuClass} w-36`}
                onMouseLeave={() => setOpenMenu(null)}
              >
                <button
                  onClick={() => { setPrintPreview(true); setOpenMenu(null); }}
                  className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  打印预览
                </button>
              </div>
            )}
          </div>
          <div className={`${toolbarCompact ? "relative shrink-0" : "hidden"}`}>
            <button
              type="button"
              aria-label="更多工具"
              onClick={toggleMoreMenu}
              className="flex h-8 w-8 items-center justify-center rounded text-lg leading-none text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              ⋮
            </button>
            {moreMenuOpen && (
              <div
                className="fixed right-2 top-14 z-40 mt-1 w-40 rounded-xl border border-zinc-100 bg-white py-1 shadow-md"
              >
                {canEditMetadata && (
                  <button
                    onClick={() => openNestedMenu("scene")}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                  >
                    <span>章节</span>
                    <Chevron />
                  </button>
                )}
                {(canEditMetadata || isLockedMode) && (
                  <button
                    onClick={() => openNestedMenu("char")}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                  >
                    <span>角色</span>
                    <Chevron />
                  </button>
                )}
                <button
                  onClick={() => openNestedMenu("edit")}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  <span>{isLockedMode ? "查找" : "编辑"}</span>
                  <Chevron />
                </button>
                <button
                  onClick={() => openNestedMenu("display")}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  <span>显示</span>
                  <Chevron />
                </button>
                <button
                  onClick={() => openNestedMenu("export")}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
                >
                  <span>导出</span>
                  <Chevron />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 搜索栏 */}
        {searchOpen && (
          <div className="border-t border-zinc-100 bg-white px-6 py-2 flex items-center gap-3">
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
            >▲</button>
            <button
              onClick={() => setSearchIdx(i => (i + 1) % searchMatches.length)}
              disabled={searchMatches.length === 0}
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
            >▼</button>
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
          <div className="border-t border-zinc-100 bg-white px-6 py-2 flex items-center gap-3">
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
            dragTarget?.kind === "edge" && dragTarget.edge === "top" ? "top-24" : "bottom-12"
          }`}
        >
          {edgeDragNotice}
        </div>
      )}

      {(dragInstructionNotice || reorderNotice || shiftSelectionNotice || selectionNotice || largeSelectionNotice || selectionChangeNotice) && (
        <div className="pointer-events-none fixed left-1/2 top-20 z-50 flex -translate-x-1/2 flex-col items-center gap-1">
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

        .script-toc-rail-scrollbar {
          scrollbar-color: transparent transparent;
          scrollbar-width: thin;
        }

        .script-toc-rail-scrollbar:hover {
          scrollbar-color: rgba(161, 161, 170, 0.45) transparent;
        }

        .script-toc-rail-scrollbar::-webkit-scrollbar {
          width: 8px;
        }

        .script-toc-rail-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .script-toc-rail-scrollbar::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 9999px;
        }

        .script-toc-rail-scrollbar:hover::-webkit-scrollbar-thumb {
          background: rgba(161, 161, 170, 0.45);
        }

        .script-toc-rail-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(113, 113, 122, 0.55);
        }
      `}</style>

      {printPageMapMeasureEnabled && display.pageBreaks && (
        <PrintPaginationMeasure
          blocks={ownedBlocks}
          characters={characters}
          scenes={scenes}
          pageLayout={scriptConfig.pageLayout}
          stageDelimOpen={scriptConfig.stageDelimOpen}
          stageDelimClose={scriptConfig.stageDelimClose}
          textLayoutMode={scriptConfig.textLayoutMode}
          onPageMapChange={handlePrintPageMapChange}
        />
      )}

      {/* Document */}
      {scriptTocRailMode && (
        <aside
          className={`fixed top-20 z-20 ${showSceneDetailRail ? "bottom-6 flex min-h-0 flex-col" : "h-[calc((100vh-5rem)/3)] min-h-44 max-h-96"}`}
          style={{
            left: `${scriptRailContainerLeftPx}px`,
            width: `${scriptRailContainerWidthPx}px`,
          }}
        >
          <div className={showSceneDetailRail ? "h-[calc((100vh-5rem)/3)] min-h-44 max-h-96 shrink-0" : "h-full"}>
            <div
              className="h-full"
              style={showSceneDetailRail
                ? { width: `${scriptContentsMenuWidthPx}px`, marginLeft: `${scriptContentsMenuOffsetPx}px` }
                : undefined}
            >
              <TableOfContents
                scenes={scenes}
                blocks={ownedBlocks}
                onScrollToScene={scrollToScene}
                activeSceneId={activeSceneId}
                placement={scriptTocRailMode === "compact" ? "rail-compact" : "rail"}
                chapterNumberSlotWidthPx={scriptTocRailLayout.chapterNumberSlotWidthPx}
                sceneNumberSlotWidthPx={scriptTocRailLayout.sceneNumberSlotWidthPx}
              />
            </div>
          </div>
          {showSceneDetailRail && (
            <div className="my-3 h-px w-full shrink-0 bg-zinc-300" />
          )}
          {showSceneDetailRail && productionId && (
            <div className="min-h-0 flex-[2_1_67%]">
              <ScriptSceneDetailRail
                scene={activeSceneDetail}
                productionId={productionId}
                versionId={activeVersionId ?? null}
                canEdit={canEditMetadata}
                isDeleteConfirmHighlighted={!!markerDeleteConfirmDetailSceneId}
                scrollbarOffsetPx={scriptSceneDetailScrollbarOffsetPx}
                onUpdateIdentity={updateScene}
                onPatchMeta={patchSceneMeta}
              />
            </div>
          )}
        </aside>
      )}
      <main className="mx-auto px-4 py-8" style={{ maxWidth: SCRIPT_EDITOR_MAX_WIDTH_PX }}>
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
          <TableOfContents scenes={scenes} blocks={ownedBlocks} onScrollToScene={scrollToScene} />
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
            const commentBubbleOffsets = new Map<string, number>();
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
            const isProtectedChapterSceneGap = !!(
              prev?.type === "chapter_marker" &&
              block.type === "scene_marker" &&
              prev.sceneId &&
              block.sceneId &&
              sceneById.get(block.sceneId)?.parentId === prev.sceneId
            );
            const showSceneEndGap = isLockedMode && shouldShowSceneEndGap(prev, block);
            if (isMarkerBlock(block)) {
              const isFixedInitialChapter = block.id === FIXED_INITIAL_CHAPTER_BLOCK_ID;
              const markerScene = block.sceneId ? sceneById.get(block.sceneId) ?? null : null;
              const markerNode: ScriptMarkerNode | null =
                block.type === "chapter_marker" && markerScene
                  ? { kind: "chapter", id: block.id, scene: markerScene }
                  : block.type === "scene_marker" && markerScene
                    ? { kind: "scene", id: block.id, scene: markerScene }
                    : block.type === "rehearsal_marker"
                      ? { kind: "rehearsal", id: block.id, mark: block.rehearsalMark ?? "" }
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
                    isReorderLocked={isReorderLocked}
                    isScriptDragging={isScriptDragging}
                    dragTarget={dragTarget?.kind === "block" && dragTarget.id === block.id ? dragTarget : null}
                    isFixed={isFixedInitialChapter}
                    isRecentlyMoved={recentlyMovedBlockIds.has(block.id)}
                    isTocHighlighted={tocHighlightedMarkerIds.has(block.id)}
                    onRemove={() => deleteBlock(block.id)}
                    canAddChapterScene={!isFixedInitialChapter && canEditMetadata}
                    canAddRehearsal={!isFixedInitialChapter && effectiveCanEditRehearsalMark}
                    onAddChapterBefore={() => addChapterBeforeBlock(block.id)}
                    onAddSceneBefore={() => addSceneBeforeBlock(block.id)}
                    onAddRehearsalBefore={() => addRehearsalBeforeBlock(block.id)}
                    onConvertToChapter={!isFixedInitialChapter && canEditMetadata ? () => convertMarkerBlockType(block.id, "chapter_marker") : undefined}
                    onConvertToScene={!isFixedInitialChapter && canEditMetadata ? () => convertMarkerBlockType(block.id, "scene_marker") : undefined}
                    onDeleteConfirmChange={(confirming) => setMarkerDetailDeleteConfirmBlockId(confirming ? block.id : null)}
                    dismissToken={dismissActionToken}
                    onSelect={() => {
                      selectionAnchorBlockIdRef.current = block.id;
                      rangeSelectionActiveRef.current = false;
                      setSelectedBlockIds(new Set([block.id]));
                    }}
                    onSceneNameChange={updateScene}
                    onDragStart={(e) => {
                      if (isFixedInitialChapter || isReorderLockedRef.current) {
                        e.preventDefault();
                        return;
                      }
                      const isDraggingSelection = selectedBlockIds.has(block.id);
                      const ids = isDraggingSelection ? Array.from(selectedBlockIds) : [block.id];
                      dismissBlockConfirmations();
                      if (!isDraggingSelection && selectedBlockIds.size > 0) {
                        selectionAnchorBlockIdRef.current = null;
                        rangeSelectionActiveRef.current = false;
                        setSelectedBlockIds(new Set());
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
                        rangeSelectionActiveRef.current = false;
                        setSelectedBlockIds(new Set([block.id]));
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
                  />
                </div>
              ) : null;
              if (!markerEl) return [];
              return bIdx > 0
                ? [
                    canEditText && !isProtectedChapterSceneGap
                      ? <InsertZone key={`iz-${bIdx}`} lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(bIdx)} />
                      : showSceneEndGap
                        ? <BlockGap key={`iz-${bIdx}`} />
                      : null,
                    markerEl,
                  ]
                : [markerEl];
            }
            const ownedBlock = ownedBlocks[bIdx] ?? block;
            const ownedPrev = bIdx > 0 ? ownedBlocks[bIdx - 1] ?? null : null;
            const displayBlock = block.sceneId === ownedBlock.sceneId && block.rehearsalMark === ownedBlock.rehearsalMark
              ? block
              : { ...block, sceneId: ownedBlock.sceneId, rehearsalMark: ownedBlock.rehearsalMark };

            const sceneStart = ownedBlock.sceneId !== null && ownedBlock.sceneId !== ownedPrev?.sceneId;
            const isMarkStart = !!ownedBlock.rehearsalMark && ownedBlock.rehearsalMark !== (ownedPrev?.rehearsalMark ?? null);
            const dividerPage = printDividerPageMap?.[block.id];
            const prevDividerPage = prev ? printDividerPageMap?.[prev.id] : undefined;
            const pageBreak = !!(
              display.pageBreaks &&
              bIdx > 0 &&
              dividerPage !== undefined &&
              prevDividerPage !== undefined &&
              dividerPage !== prevDividerPage
            );
            const isBlockFocused = !isLockedMode && focusedId === block.id;
            const hideCharSelector =
              isBlockFocused || pageBreak ? false : shouldHideCharacterLabel(ownedPrev, ownedBlock);
            const showCharacterGap = isLockedMode && shouldShowCharacterGap(ownedPrev, ownedBlock, hideCharSelector);
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
              _sameCharacters(prev.characterIds, block.characterIds)
            );

            const blockEl = (
              <div
                key={block.id}
                id={`block-${block.id}`}
                data-bwrap={block.id}
                data-scene-anchor={sceneStart ? ownedBlock.sceneId ?? undefined : undefined}
                className={`min-w-0 scroll-mt-20 transition-[outline] duration-150${highlightedBlockId === block.id ? " outline outline-2 outline-amber-400 rounded-lg" : ""}`}
              >
                {/* Scene anchor for TableOfContents links */}
                {sceneStart && ownedBlock.sceneId && <span id={`scene-block-${ownedBlock.sceneId}`} className="pointer-events-none absolute" />}
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
                  index={bIdx}
                  lineNum={display.lineNumbers ? scriptLineNumberByBlockId.get(block.id) : undefined}
                  lineIndexWidth={lineIndexWidthStyle}
                  isSearchHighlight={searchHighlight}
                  showRehearsalMark={display.rehearsalMarks}
                  readOnlyRehearsalMode={isLockedMode}
                  readOnlyScene={isLockedMode && display.rehearsalBlockScenes && ownedBlock.sceneId ? sceneById.get(ownedBlock.sceneId) ?? null : null}
                  stageDelimOpen={scriptConfig.stageDelimOpen}
                  stageDelimClose={scriptConfig.stageDelimClose}
                  textLayoutMode={scriptConfig.textLayoutMode}
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
                    else deleteBlock(block.id);
                  }}
                  onFocus={() => markBlockFocused(block.id)}
                  onDeleteFocus={() => focusBlockContent(block.id, false)}
                  onRequestLargeSelectionOperation={requestLargeSelectionOperation}
                  onToggleType={() => {
                    if (isSelected && selectedDeleteIds.length > 1) {
                      setBlocksType(selectedDeleteIds, block.type === "stage" ? "dialogue" : "stage");
                    } else {
                      toggleBlockType(block.id);
                    }
                  }}
                  onToggleLyric={() => {
                    if (isSelected && selectedDeleteIds.length > 1) {
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
                    const isAdditiveSelection = e.ctrlKey || e.metaKey;
                    if (e.shiftKey) {
                      const anchorId = selectionAnchorBlockIdRef.current;
                      const anchorIdx = anchorId ? blocks.findIndex((b) => b.id === anchorId) : -1;
                      const start = anchorIdx === -1 ? bIdx : Math.min(anchorIdx, bIdx);
                      const end = anchorIdx === -1 ? bIdx : Math.max(anchorIdx, bIdx);
                      const rangeIds = blocks.slice(start, end + 1).map((b) => b.id);
                      if (anchorIdx === -1) selectionAnchorBlockIdRef.current = block.id;
                      rangeSelectionActiveRef.current = true;
                      if (isAdditiveSelection) {
                        setSelectedBlockIds((current) => {
                          const next = new Set(current);
                          for (const id of rangeIds) next.add(id);
                          return next;
                        });
                      } else {
                        setSelectedBlockIds(new Set(rangeIds));
                      }
                      return;
                    }
                    if (isAdditiveSelection) {
                      selectionAnchorBlockIdRef.current = block.id;
                      setSelectedBlockIds((current) => {
                        if (current.has(block.id)) return current;
                        const next = new Set(current);
                        next.add(block.id);
                        return next;
                      });
                      return;
                    }
                    if (rangeSelectionActiveRef.current) {
                      rangeSelectionActiveRef.current = false;
                      selectionAnchorBlockIdRef.current = block.id;
                      setSelectedBlockIds(new Set([block.id]));
                    } else {
                      setSelectedBlockIds((current) => {
                        const next = new Set(current);
                        if (next.has(block.id)) {
                          next.delete(block.id);
                          if (selectionAnchorBlockIdRef.current === block.id) {
                            selectionAnchorBlockIdRef.current = next.values().next().value ?? null;
                          }
                        } else {
                          next.add(block.id);
                          selectionAnchorBlockIdRef.current = block.id;
                        }
                        return next;
                      });
                    }
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
                    dismissBlockConfirmations();
                    if (!isDraggingSelection && selectedBlockIds.size > 0) {
                      const emptySelection = new Set<string>();
                      selectionAnchorBlockIdRef.current = null;
                      rangeSelectionActiveRef.current = false;
                      setSelectedBlockIds(emptySelection);
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
                  commentBubbleOffsetY={commentBubbleOffsets.get(block.id) ?? 0}
                  rightGutterCanShowComments={rightGutterCanShowComments}
                  commentBubbleMaxWidth={commentBubbleMaxWidth}
                  onCommentClick={() => { setActiveAssetBlockId(null); setActiveCommentBlockId(block.id); }}
                  onAssetClick={() => { setActiveCommentBlockId(null); setActiveAssetBlockId(block.id); }}
                  canEditText={canEditText}
                  canEditMetadata={canEditMetadata}
                  canEditRehearsalMark={effectiveCanEditRehearsalMark}
                  canMergeWithPrevious={canMergeWithPrevious}
                  tagGroups={tagGroups}
                  blockTagValues={blockTagMap.get(block.id) ?? []}
                  showBlockTags={display.blockTags && tagGroups.length > 0}
                  hasLyricConfig={tagGroups.some(g => !!g.lyricSplitAfterOptionId)}
                  onTagChange={(groupId, optionId, value, del) => handleTagChange(block.id, groupId, optionId, value, del)}
                  onTagCopyClick={() => handleTagCopy(block.id)}
                  onTagPasteClick={() => handleTagPaste(block.id)}
                />
              </div>
            );
            return bIdx > 0
              ? [
                  canEditText && !isProtectedChapterSceneGap ? <InsertZone key={`iz-${bIdx}`} lineIndexWidth={lineIndexWidthStyle} onInsert={() => insertBlockAt(bIdx)} /> :
                    showSceneEndGap ? <BlockGap key={`iz-${bIdx}`} /> :
                    isLockedMode && showCharacterGap ? <BlockGap key={`iz-${bIdx}`} /> :
                    null,
                  blockEl,
                ]
              : [blockEl];
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

      {tagEditorOpen && productionId && (
        <div className="fixed right-0 top-14 bottom-0 z-30 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
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
      )}

      {activeAssetBlockId && productionId && (
        <SideBlockPanel
          blockId={activeAssetBlockId}
          title="附件"
          blockCaption={activeAssetBlockCaption}
          hasGutterSpace={rightGutterCanShowComments}
          gutterWidth={scriptSideGutterWidth}
          viewportWidth={effectiveViewportWidth}
          navigation={{
            hasPrevious: assetPanelNavigationTargets.previousBlockId !== null,
            hasNext: assetPanelNavigationTargets.nextBlockId !== null,
            onPrevious: () => navigateSidePanelBlock("asset", -1),
            onNext: () => navigateSidePanelBlock("asset", 1),
          }}
          onClose={() => setActiveAssetBlockId(null)}
        >
          <div className="relative z-10 flex-1 overflow-y-auto bg-white px-4 py-3">
            <BlockMountAssets
              productionId={productionId}
              blockId={activeAssetBlockId}
              versionId={activeVersionId ?? null}
              label="Block 附件"
              canEdit={true}
              display="panel"
              onNavigate={prepareForNavigation}
              onChange={loadBlockAssetBubbles}
            />
          </div>
        </SideBlockPanel>
      )}

      {activeCommentBlockId && productionId && (
        <CommentsPanel
          blockId={activeCommentBlockId}
          productionId={productionId}
          comments={commentsByBlockId.get(activeCommentBlockId) ?? EMPTY_COMMENTS}
          currentOpenId={meOpenId}
          isAdmin={meIsAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentBlockId(null)}
          onNavigate={prepareForNavigation}
          hasGutterSpace={rightGutterCanShowComments}
          gutterWidth={scriptSideGutterWidth}
          viewportWidth={effectiveViewportWidth}
          blockCaption={activeCommentBlockCaption}
          navigation={{
            hasPrevious: commentPanelNavigationTargets.previousBlockId !== null,
            hasNext: commentPanelNavigationTargets.nextBlockId !== null,
            onPrevious: () => navigateSidePanelBlock("comment", -1),
            onNext: () => navigateSidePanelBlock("comment", 1),
          }}
        />
      )}

      {pendingLockedMode !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setPendingLockedMode(null)}
        >
          <div
            className="w-[360px] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
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
          </div>
        </div>
      )}

      {pendingAggregateFocusPrompt && (() => {
        const currentCharacter = characters.find((char) => char.id === pendingAggregateFocusPrompt.characterId);
        const aggregateCharacters = pendingAggregateFocusPrompt.aggregateIds
          .map((id) => characters.find((char) => char.id === id))
          .filter((char): char is Character => Boolean(char));
        if (!currentCharacter || aggregateCharacters.length === 0) return null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={cancelAggregateFocusPrompt}
            role="dialog"
            aria-modal="true"
          >
            <div
              className="w-[420px] rounded-2xl bg-white p-5 shadow-xl"
              onClick={e => e.stopPropagation()}
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
            </div>
          </div>
        );
      })()}

      {markerDetailDeleteBlockedKind && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setMarkerDetailDeleteBlockedKind(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[380px] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
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
          </div>
        </div>
      )}

      {pendingLargeSelectionConfirmation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => {
            pendingLargeSelectionConfirmation.onCancel?.();
            setPendingLargeSelectionConfirmation(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[380px] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
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
          </div>
        </div>
      )}

      {pendingEmptyScriptCleanup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setEmptyScriptCleanupDialog(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[560px] max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
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
                className="rounded border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              >
                取消
              </button>
              <button
                onClick={() => applyEmptyScriptCleanup(selectedEmptyScriptCleanupKeys)}
                className={`rounded px-3 py-1.5 text-sm font-medium text-white transition-colors ${
                  selectedEmptyScriptCleanupKeys.size === 0
                    ? "bg-[#637ca1] hover:bg-[#536b8e]"
                    : "bg-zinc-900 hover:bg-zinc-800"
                }`}
              >
                {selectedEmptyScriptCleanupKeys.size === 0 ? "仅清除空白剧本块" : "清除选中空白内容"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingStageDelimiterChange && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setPendingStageDelimiterChange(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[420px] rounded-2xl bg-white p-5 shadow-xl"
            onClick={e => e.stopPropagation()}
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
          </div>
        </div>
      )}

      {/* 关于 modal */}
      {aboutOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setAboutOpen(false)}
        >
          <div
            className="w-[420px] rounded-2xl bg-white p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-zinc-800">关于 · 快捷键</h2>
              <button onClick={() => setAboutOpen(false)} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">✕</button>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-50">
                {[
                  ["⌘Z", "撤销"],
                  ["⌘⇧Z", "重做"],
                  ["⌘F", "搜索"],
                  ["⌘B", "粗体（选中文字）"],
                  ["⌘U", "下划线（选中文字）"],
                  ["⌘I", "切换舞台提示 / 段内括注"],
                  ["Enter", "新建块（行尾）"],
                  ["⇧Enter", "块内换行"],
                  ["Backspace", "对行首：合并至上一块（如类型、角色相同）\n对选中块：删除所选行"],
                  ["⌘⇧L", "切换歌词模式"],
                  ["⌘⇧C", "复制当前块标签"],
                  ["⌘⇧V", "粘贴标签到当前块"],
                ].map(([key, desc]) => (
                  <tr key={key}>
                    <td className="py-1.5 pr-4 font-mono text-[13px] text-zinc-400 whitespace-nowrap">{key}</td>
                    <td className="py-1.5 whitespace-pre-line text-zinc-600">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
