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
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, BlockType, Character, Scene, ScriptState, ScriptConfig } from "@/lib/script-types";
import type { TagGroup, BlockTagValue, Version, VersionStatus } from "@/lib/db";
import TagGroupEditor from "@/components/TagGroupEditor";
import VersionSelector from "@/components/VersionSelector";
import BlockMountAssets from "@/components/assets/BlockMountAssets";
import MountPointAssets from "@/components/assets/MountPointAssets";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { diffState, type TagEntry } from "@/lib/script-ops";
import { computePageMap, DEFAULT_PAGE_CONFIG } from "@/lib/script-page";
import type { PageConfig } from "@/lib/script-page";
import SmartTextarea from "@/components/SmartTextarea";
import SmartText from "@/components/SmartText";
import CommentAssetPicker, { type PendingAsset } from "@/components/assets/CommentAssetPicker";

let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;
const LARGE_SELECTION_BLOCK_THRESHOLD = 500;
const TOOLBAR_FOLD_HYSTERESIS_PX = 16;

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

const isBlockEmptyForDelete = (block: Block) =>
  block.content.trim() === "" &&
  !(block.stageComment ?? "").trim() &&
  block.characterIds.length === 0 &&
  Object.values(block.characterAnnotations).every((ann) => ann.trim() === "");

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
        return `<span data-stage-inline="" style="font-style:italic;color:#a1a1aa">${inner}</span>`;
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
// Stage-inline cues are stored as plain (…) / （…） brackets — no span markup.

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

function mdToHtml(md: string): string {
  let s = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Collapse 3+ consecutive * or _ to exactly 2, so nested markers from old
  // double-bold bugs render as a single level instead of mis-parsing.
  s = s.replace(/\*{3,}/g, "**").replace(/_{3,}/g, "__");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => `<b>${inner}</b>`);
  s = s.replace(/__([\s\S]+?)__/g, (_, inner) => `<u>${inner}</u>`);
  s = s.replace(/\n/g, "<br>");
  return s;
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

function wrapSelectionAsInlineStageCue(range: Range): void {
  const frag = range.extractContents();
  const span = document.createElement("span");
  span.setAttribute("data-stage-inline", "");
  span.style.fontStyle = "italic";
  span.style.color = "#a1a1aa";
  span.appendChild(document.createTextNode("("));
  span.appendChild(frag);
  span.appendChild(document.createTextNode(")"));
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

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const validStageText = (text: string) =>
    ((text.startsWith("(") && text.endsWith(")")) ||
     (text.startsWith(delimOpen) && text.endsWith(delimClose))) &&
    text.length >= 2;

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

  const escapedOpen = esc(delimOpen);
  const escapedClose = esc(delimClose);
  const innerExclude = delimOpen === "（" ? "[^()（）\n]" : `[^${esc("()")}${esc(delimOpen + delimClose)}\n]`;
  const pairRegex = new RegExp(
    `\\([^()（）\n]*\\)|${escapedOpen}${innerExclude}*${escapedClose}`, "g"
  );

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

function TableOfContents({
  scenes,
  blocks,
  onScrollToScene,
}: {
  scenes: Scene[];
  blocks: Block[];
  onScrollToScene?: (sceneId: string) => void;
}) {
  // Build ordered scene list matching the render: used scenes in block order,
  // with unused scenes inserted at their correct position between used ones.
  const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter(Boolean));
  const usedOrdered: Scene[] = [];
  for (const b of blocks) {
    if (b.sceneId) {
      const scene = scenes.find((s) => s.id === b.sceneId);
      if (scene && !usedOrdered.some((s) => s.id === scene.id)) {
        usedOrdered.push(scene);
      }
    }
  }
  if (usedOrdered.length === 0 && usedSceneIds.size === 0) return null;

  // Merge unused scenes into their correct position between used scenes.
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
  // Append any unused scenes that come after the last used scene.
  const lastIdx = usedOrdered.length
    ? scenes.findIndex((s) => s.id === usedOrdered[usedOrdered.length - 1].id)
    : -1;
  for (let j = lastIdx + 1; j < scenes.length; j++) {
    if (!usedSceneIds.has(scenes[j].id)) pushOrderedScene(scenes[j]);
  }

  if (orderedScenes.length === 0) return null;

  const scrollTo = (sceneId: string) => {
    if (onScrollToScene) { onScrollToScene(sceneId); return; }
    document.getElementById(`scene-block-${sceneId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="px-8 pt-6 pb-5 border-b border-zinc-100">
      <p className="mb-3 text-[10px] font-bold tracking-widest text-zinc-300 uppercase">目录</p>
      <nav className="flex flex-col gap-0.5">
        {orderedScenes.map((scene) => {
          const isSubScene = scene.parentId !== null;
          return (
            <button
              key={scene.id}
              onClick={() => scrollTo(scene.id)}
              className={`flex items-baseline gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-zinc-50 group${isSubScene ? " pl-6" : ""}`}
            >
              <span className={`min-w-[3rem] text-xs tracking-wider ${isSubScene ? "font-medium text-zinc-300 group-hover:text-zinc-400" : "font-bold text-zinc-400 group-hover:text-zinc-600"}`}>
                {scene.number || "—"}
              </span>
              <span className={`${isSubScene ? "text-xs text-zinc-300 group-hover:text-zinc-500" : "text-sm font-medium text-zinc-500 group-hover:text-zinc-700"}`}>
                {scene.name || <span className="italic text-zinc-200">未命名</span>}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ─── ScenePanel ───────────────────────────────────────────────────────────────

function SceneRow({
  scene,
  onUpdate,
  onRemove,
  indent = false,
}: {
  scene: Scene;
  onUpdate: (id: string, number: string, name: string) => void;
  onRemove: (id: string) => void;
  indent?: boolean;
}) {
  const [number, setNumber] = useState(scene.number);
  const [name, setName] = useState(scene.name);
  const [lastSeenNumber, setLastSeenNumber] = useState(scene.number);
  const [lastSeenName, setLastSeenName] = useState(scene.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (lastSeenNumber !== scene.number) { setLastSeenNumber(scene.number); setNumber(scene.number); }
  if (lastSeenName !== scene.name) { setLastSeenName(scene.name); setName(scene.name); }

  const commit = () => {
    if (number.trim() !== scene.number || name.trim() !== scene.name) {
      onUpdate(scene.id, number.trim(), name.trim());
    }
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className={`py-1 pr-2 align-middle${indent ? " pl-4" : ""}`}>
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          className={`w-14 rounded border border-transparent px-1 py-0.5 text-sm outline-none focus:border-zinc-300${indent ? " text-zinc-400" : ""}`}
          placeholder="编号"
        />
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
        {confirmDelete ? (
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
  onAdd: (parentId?: string) => void;
  onUpdate: (id: string, number: string, name: string) => void;
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
                        <SceneRow scene={s} onUpdate={onUpdate} onRemove={onRemove} indent={isSubScene} />
                        {/* After each act row, show an inline "add sub-scene" row */}
                        {!isSubScene && (
                          <tr>
                            <td colSpan={3} className="pt-0 pb-1 pl-5">
                              <button
                                onClick={() => onAdd(s.id)}
                                className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors"
                              >
                                + 添加场景
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
              onClick={() => onAdd()}
              className="w-full rounded-lg border border-dashed border-zinc-200 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600"
            >
              + 添加幕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SceneHeader({ scene }: { scene: Scene }) {
  if (scene.parentId === null) {
    // Act-level: prominent, full-width dividers
    return (
      <div className="flex select-none items-center gap-3 px-8 py-4">
        <div className="h-px flex-1 bg-zinc-300" />
        <div className="flex items-baseline gap-2.5">
          <span className="text-xs font-extrabold tracking-widest text-zinc-500">{scene.number}</span>
          {scene.name && <span className="text-base font-semibold text-zinc-600">{scene.name}</span>}
        </div>
        <div className="h-px flex-1 bg-zinc-300" />
      </div>
    );
  }
  // Sub-scene: centered like act but smaller and lighter
  return (
    <div className="flex select-none items-center gap-2 px-8 py-2">
      <div className="h-px flex-1 bg-zinc-100" />
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-xs text-zinc-400">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-100" />
    </div>
  );
}

// ─── Per-block scene picker ────────────────────────────────────────────────────

function ScenePicker({
  scenes,
  availableScenes,
  sceneId,
  onChange,
  onOpenChange,
}: {
  scenes: Scene[];
  availableScenes: Scene[];
  sceneId: string | null;
  onChange: (id: string | null) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onOpenChange]);

  const current = scenes.find((s) => s.id === sceneId);

  return (
    <div ref={wrapRef} className={`relative ${open ? "z-40" : ""}`}>
      <button
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
        title="设置章节起点"
        className={`rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
          current
            ? "text-zinc-500 hover:text-zinc-700"
            : "text-zinc-200 hover:text-zinc-400"
        }`}
      >
        {current ? current.number : "章"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[9rem] rounded-xl border border-zinc-100 bg-white py-1 shadow-xl overflow-y-auto" style={{ maxHeight: "min(20rem, calc(100vh - 12rem))" }}>
          <button
            onMouseDown={(e) => { e.preventDefault(); onChange(null); setOpen(false); onOpenChange?.(false); }}
            className="w-full px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-50"
          >
            — 无
          </button>
          {availableScenes.map((s) => (
            <button
              key={s.id}
              onMouseDown={(e) => { e.preventDefault(); onChange(s.id); setOpen(false); onOpenChange?.(false); }}
              className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-50 ${
                s.id === sceneId ? "font-bold text-zinc-800" : "text-zinc-600"
              }`}
            >
              {s.number}{s.name ? `  ${s.name}` : ""}
            </button>
          ))}
        </div>
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
  mark,
  onChange,
}: {
  mark: string | null;
  onChange: (mark: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mark ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    const val = draft.trim().toUpperCase();
    onChange(val || null);
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="flex items-start gap-1">
        <button
          onMouseDown={(e) => e.preventDefault()}
          title="设置排练记号"
          data-rehearsal-triangle="true"
          className="rounded px-0.5 py-0 text-[8px] font-bold leading-none tracking-wide text-zinc-400"
        >
          ▶
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { setDraft(mark ?? ""); setEditing(false); }
          }}
          placeholder="A1"
          className="w-10 rounded border border-zinc-300 bg-white/90 px-1 py-0.5 text-center text-[11px] font-bold uppercase outline-none"
        />
      </span>
    );
  }

  return (
    <span className="flex items-start gap-1">
      <button
        onClick={() => { setDraft(mark ?? ""); setEditing(true); }}
        title="设置排练记号"
        data-rehearsal-triangle="true"
        className={`rounded px-0.5 py-0 text-[8px] font-bold leading-none tracking-wide transition-colors ${
          mark
            ? "text-zinc-500 hover:text-zinc-700"
            : "text-zinc-200 hover:text-zinc-400"
        }`}
      >
        ▶
      </button>
      {mark && (
        <span className="text-[9px] font-bold leading-none tracking-wide text-zinc-500">
          {mark}
        </span>
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
          <ModeSwitch active={focused} activeClassName="bg-purple-400" />
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
          className={`${nestedFromMore ? "fixed right-2 top-64" : "absolute right-0 top-full"} z-30 mt-2 flex w-56 flex-col rounded-xl border border-zinc-100 bg-white shadow-xl`}
          style={{ maxHeight: nestedFromMore ? "min(28rem, calc(100vh - 18rem))" : "min(28rem, calc(100vh - 8rem))" }}
        >
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">角色管理</span>
            {!readOnly && (
              <Link href={`/production/${productionId}/characters`} onNavigate={onNavigate} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
                管理页 →
              </Link>
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [editing]);

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

  if (!editing) {
    return (
      <div className="mb-2 flex justify-center">
        {readOnly ? (
          <span className={`text-sm font-bold tracking-[0.12em] ${selected.length ? "text-zinc-800" : "text-zinc-300"}`}>
            {selected.length ? selected.map(charLabel).join("、") : "无角色"}
          </span>
        ) : (
          <button
            onClick={() => setEditingWithNotify(true)}
            className={`text-sm font-bold tracking-[0.12em] transition-colors ${
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
    <div ref={wrapRef} className="relative z-30 mb-2">
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
}: {
  value?: string | null;
  onChange: (value: string | null) => void;
  showAddButton?: boolean;
  topGap?: "compact" | "leading";
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const skipBlurCommitRef = useRef(false);
  const text = value?.trim() ?? "";

  const commit = () => {
    const next = draft.trim();
    onChange(next || null);
    skipBlurCommitRef.current = false;
    setEditing(false);
  };
  const openEditor = () => {
    skipBlurCommitRef.current = false;
    setDraft(value ?? "");
    setEditing(true);
  };
  const topGapClass = topGap === "leading" ? "mt-2 " : topGap === "compact" ? "-mt-1 " : "";

  if (editing && !readOnly) {
    return (
      <div className={`${topGapClass}mb-0.5 flex justify-center`}>
        <input
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
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") {
              e.preventDefault();
              skipBlurCommitRef.current = true;
              setDraft(value ?? "");
              setEditing(false);
            }
          }}
          placeholder="在此输入补充舞台提示"
          className="w-full max-w-xs border-b border-zinc-200 bg-transparent px-1 text-center font-stage text-sm italic text-zinc-500 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
        />
      </div>
    );
  }

  if (text) {
    const label = `（${text}）`;
    return (
      <div className={`${topGapClass}mb-0.5 flex justify-center`}>
        {readOnly ? (
          <span className="font-stage text-sm italic text-zinc-400">{label}</span>
        ) : (
          <button
            type="button"
            onClick={openEditor}
            className="font-stage text-sm italic text-zinc-400 transition-colors hover:text-zinc-600"
          >
            {label}
          </button>
        )}
      </div>
    );
  }

  if (readOnly || !showAddButton) return null;
  return (
    <div className="mb-1 flex justify-center">
      <button
        type="button"
        onClick={openEditor}
        className="flex h-4 w-4 items-center justify-center rounded-full text-xs leading-none text-zinc-200 transition-colors hover:bg-zinc-100 hover:text-zinc-500"
        title="添加舞台备注"
        aria-label="添加舞台备注"
      >
        +
      </button>
    </div>
  );
}

// ─── Print ────────────────────────────────────────────────────────────────────

// PageConfig and DEFAULT_PAGE_CONFIG imported from @/lib/script-page

type PrintItem =
  | { kind: "sceneHeader"; scene: Scene }
  | { kind: "block"; block: Block; hideChar: boolean; leadingCharacterGap: boolean };

const PRINT_CHAR_NAME_HEIGHT = 22;
const PRINT_CHARACTER_GAP_HEIGHT = 10;

type PrintPageData = {
  items: PrintItem[];
  sceneLabel: string;
  pageNum: number;
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
  let pageNum = 1;
  let curHasBlock = false;

  const flush = () => {
    if (curItems.length === 0) return;
    pages.push({ items: [...curItems], sceneLabel: curLabel, pageNum });
    pageNum++;
    curItems = [];
    curH = 0;
    curHasBlock = false;
  };

  const addItem = (item: PrintItem, h: number) => {
    const forcedCharHeight = item.kind === "block" && item.hideChar && item.block.characterIds.length > 0
      ? PRINT_CHAR_NAME_HEIGHT
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
    if (item.kind === "block") curHasBlock = true;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const prev = i > 0 ? blocks[i - 1] : null;
    const hideChar = shouldHideCharacterLabel(prev, block);
    const leadingCharacterGap = shouldShowCharacterGap(prev, block, hideChar);

    if (block.sceneId && block.sceneId !== prev?.sceneId) {
      const scene = scenes.find((s) => s.id === block.sceneId);
      if (scene) {
        addItem({ kind: "sceneHeader", scene }, heights[`sh-${block.sceneId}`] ?? 52);
        curLabel = scene.number;
        if (!(scene.id in scenePageNums)) scenePageNums[scene.id] = pageNum;
      }
    }

    addItem({ kind: "block", block, hideChar, leadingCharacterGap }, heights[`b-${block.id}`] ?? 60);
  }

  flush();
  return { pages, scenePageNums };
}

function PrintPage({
  cfg,
  header,
  pageNum,
  isToc,
  children,
}: {
  cfg: PageConfig;
  header: string;
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
        className="absolute flex items-center border-b border-zinc-100"
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

function PrintPreview({
  blocks,
  characters,
  scenes,
  onClose,
}: {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  onClose: () => void;
}) {
  const cfg = DEFAULT_PAGE_CONFIG;
  const contentW = cfg.width - cfg.marginX * 2;
  const contentH = cfg.height - cfg.marginTop - cfg.marginBottom;

  const measureRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{
    pages: PrintPageData[];
    scenePageNums: Record<string, number>;
  } | null>(null);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const heights: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
      if (node.dataset.mid) heights[node.dataset.mid] = node.offsetHeight;
    });
    setData(computePrintPages(blocks, scenes, heights, contentH));
  }, [blocks, scenes, contentH]);

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

  const renderBlock = (block: Block, hideChar: boolean, leadingCharacterGap = false) => {
    const isStage = block.type === "stage";
    const sel = characters.filter((c) => block.characterIds.includes(c.id));
    return (
      <div key={block.id} className="w-full py-1">
        {leadingCharacterGap && <div className="h-2.5" aria-hidden="true" />}
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {sel.map((c) => { const ann = block.characterAnnotations[c.id]; return ann ? `${c.name}（${ann}）` : c.name; }).join("、")}
          </div>
        )}
        {!isStage && sel.length > 0 && block.stageComment?.trim() && (
          <div className="mb-0.5 w-full text-center font-stage text-sm italic text-zinc-500">
            （{block.stageComment.trim()}）
          </div>
        )}
        <div
          className={`w-full break-words text-sm leading-7 ${
            isStage
              ? "font-stage text-left italic text-zinc-500"
              : block.lyric
              ? "font-lyric text-center font-bold uppercase text-zinc-800"
              : "font-script text-center text-zinc-800"
          }`}
          dangerouslySetInnerHTML={{ __html: mdToHtml(block.content) || "　" }}
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
      <div className="flex-1 overflow-auto print:overflow-visible print:h-auto">
        <div className="mx-auto flex flex-col items-center gap-6 py-8 print:gap-0 print:py-0">
          {/* Hidden measurement container — off-screen, rendered at print content width */}
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
            {blocks.map((block, i) => {
              const prev = i > 0 ? blocks[i - 1] : null;
              const hideChar = shouldHideCharacterLabel(prev, block);
              const sceneStart = block.sceneId !== null && block.sceneId !== prev?.sceneId;
              return (
                <div key={block.id}>
                  {sceneStart && (() => {
                    const scene = scenes.find((s) => s.id === block.sceneId);
                    return scene ? (
                      <div data-mid={`sh-${block.sceneId}`}>
                        {renderSceneHeader(scene, `m-sh-${block.sceneId}`)}
                      </div>
                    ) : null;
                  })()}
                  <div data-mid={`b-${block.id}`}>{renderBlock(block, hideChar)}</div>
                </div>
              );
            })}
          </div>

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
          {data?.pages.map((page, idx) => (
            <PrintPage key={idx} cfg={cfg} header={page.sceneLabel} pageNum={page.pageNum}>
              {page.items.map((item, iIdx) =>
                item.kind === "sceneHeader"
                  ? renderSceneHeader(item.scene, `sh-${item.scene.id}-${iIdx}`)
                  : renderBlock(item.block, item.hideChar, item.leadingCharacterGap)
              )}
            </PrintPage>
          ))}
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
  const syncedBlocks = synced?.blocks ?? [];
  const localOrderDirty = !!synced && (
    local.length !== syncedBlocks.length ||
    local.some((b, i) => b.id !== syncedBlocks[i]?.id)
  );

  const isDirty = (b: Block): boolean => {
    const s = syncedMap.get(b.id);
    if (!s) return true;
    return (
      b.content !== s.content ||
      (b.stageComment ?? "") !== (s.stageComment ?? "") ||
      b.type !== s.type ||
      b.lyric !== s.lyric ||
      (b.forceShowCharacterName ?? false) !== (s.forceShowCharacterName ?? false) ||
      b.rehearsalMark !== s.rehearsalMark ||
      b.sceneId !== s.sceneId ||
      b.characterIds.length !== s.characterIds.length ||
      b.characterIds.some((id, i) => id !== s.characterIds[i]) ||
      b.characterIds.some((id) => (b.characterAnnotations[id] ?? "") !== (s.characterAnnotations[id] ?? ""))
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
  if (block.characterIds.length === 0) return false;
  return _sameCharacters(prev.characterIds, block.characterIds);
}

function shouldShowCharacterGap(prev: Block | null, block: Block, hideChar: boolean): boolean {
  if (!prev) return false;
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
const COMPACT_STAGE_CONTENT_GAP_PX = 4;

function ScriptBlock({
  block,
  characters,
  scenes,
  availableScenes,
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
  onSceneChange,
  onMarkChange,
  onDragStartBlock,
  onDragEndBlock,
  onDragOverBlock,
  onDropBlock,
  onToggleSelected,
  onDeleteConfirmationChange,
  isMarkStart,
  commentCount,
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
  isReorderLocked = false,
  isScriptDragging = false,
  index = 0,
  lineNum,
  isSearchHighlight,
  showRehearsalMark = true,
  showReadOnlyRehearsalMark = false,
  readOnlyRehearsalMode = false,
  readOnlyScene = null,
  stageDelimOpen = "（",
  stageDelimClose = "）",
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
  availableScenes: Scene[];
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
  onSceneChange: (sceneId: string | null) => void;
  onMarkChange: (mark: string | null) => void;
  onDragStartBlock: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEndBlock: () => void;
  onDragOverBlock: (e: DragEvent<HTMLDivElement>) => void;
  onDropBlock: (e: DragEvent<HTMLDivElement>) => void;
  onToggleSelected: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDeleteConfirmationChange: (active: boolean) => void;
  isMarkStart: boolean;
  commentCount: number;
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
  isReorderLocked?: boolean;
  isScriptDragging?: boolean;
  index?: number;
  lineNum?: number;
  isSearchHighlight?: "match" | "focused";
  showRehearsalMark?: boolean;
  showReadOnlyRehearsalMark?: boolean;
  readOnlyRehearsalMode?: boolean;
  readOnlyScene?: Scene | null;
  stageDelimOpen?: string;
  stageDelimClose?: string;
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
  const divRef = useRef<HTMLDivElement | null>(null);
  const localContentRef = useRef<string | null>(null);
  const localTypeRef = useRef<BlockType | null>(null);
  const composingRef = useRef(false);
  const compactControlLayoutActiveRef = useRef(false);
  const [charSelectorOpen, setCharSelectorOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTypeAction, setConfirmTypeAction] = useState<"type" | "lyric" | null>(null);
  const [unfoldForCompactControls, setUnfoldForCompactControls] = useState(false);
  const [compactControlLayout, setCompactControlLayout] = useState<{
    deleteLeft: number | null;
    contentPaddingLeft: number | null;
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

  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      divRef.current = el;
      onRegisterRef(block.id, el);
    },
    [block.id, onRegisterRef]
  );

  const isStage = block.type === "stage";
  const hasBlockTags = !isStage && showBlockTags && !!tagGroups?.length;
  const isEditingLocked = isSelected || confirmDelete || isDeleteConfirmHighlighted;
  const hiddenCharacterCollapsed = !isStage && hideCharSelector && !isFocused && !isSelected;
  const effectiveHideCharSelector = hideCharSelector && !(hiddenCharacterCollapsed && unfoldForCompactControls);
  const shouldMeasureCompactControls = canEditText && (isStage || hiddenCharacterCollapsed && !unfoldForCompactControls);
  const isCompactHiddenCharacterLayout = !!(
    compactControlLayout?.compact && compactControlLayout.mode === "hidden-character"
  );
  const unfoldCompactControls = () => {
    if (hiddenCharacterCollapsed && isCompactHiddenCharacterLayout && !unfoldForCompactControls) {
      setUnfoldForCompactControls(true);
    }
  };
  const resetCompactControlHover = () => {
    if (unfoldForCompactControls) setUnfoldForCompactControls(false);
  };

  useLayoutEffect(() => {
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
      const contentEl = mode === "stage" ? divRef.current : null;
      const blockRect = blockEl.getBoundingClientRect();
      const tagRect = hasBlockTags
        ? blockTagsRef.current?.getBoundingClientRect()
        : null;
      const measuredBlockHeight = tagRect
        ? Math.max(blockRect.height, tagRect.bottom - blockRect.top)
        : blockRect.height;
      const isCompactBlock = measuredBlockHeight < compactControlThreshold;

      if (isCompactBlock) compactControlLayoutActiveRef.current = true;

      if (!compactControlLayoutActiveRef.current || !railEl || !triangleEl || (mode === "stage" && !contentEl)) {
        setCompactControlLayout(null);
        return;
      }

      const railRect = railEl.getBoundingClientRect();
      const triangleRect = triangleEl.getBoundingClientRect();
      const measuredDeleteLeft = triangleRect.left - railRect.left + COMPACT_STAGE_DELETE_SHIFT_PX;
      const deleteLeft = isCompactBlock ? measuredDeleteLeft : null;
      const controlRight = Math.max(triangleRect.right, railRect.left + measuredDeleteLeft + 16);
      const hoverWidth = Math.max(16, Math.ceil(controlRight - railRect.left));
      const contentPaddingLeft = (() => {
        if (mode !== "stage" || !contentEl) return null;
        const contentRect = contentEl.getBoundingClientRect();
        return Math.max(4, Math.ceil(controlRight - contentRect.left + COMPACT_STAGE_CONTENT_GAP_PX));
      })();

      setCompactControlLayout((prev) => {
        if (
          prev &&
          prev.compact === isCompactBlock &&
          prev.mode === mode &&
          Math.abs(prev.hoverWidth - hoverWidth) < 0.5 &&
          (prev.deleteLeft === null && deleteLeft === null ||
            prev.deleteLeft !== null && deleteLeft !== null && Math.abs(prev.deleteLeft - deleteLeft) < 0.5) &&
          (prev.contentPaddingLeft === null && contentPaddingLeft === null ||
            prev.contentPaddingLeft !== null && contentPaddingLeft !== null &&
              Math.abs(prev.contentPaddingLeft - contentPaddingLeft) < 0.5)
        ) {
          return prev;
        }
        return { deleteLeft, contentPaddingLeft, compact: isCompactBlock, hoverWidth, mode };
      });
    };

    updateCompactControls();
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
    if (block.content !== localContentRef.current || block.type !== localTypeRef.current) {
      localContentRef.current = block.content;
      localTypeRef.current = block.type;
      div.innerHTML = mdToHtml(block.content);
      if (block.type !== "stage") applyInlineStageStyling(div, stageDelimOpen, stageDelimClose);
    }
  }, [block.content, block.type]);

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
          wrapSelectionAsInlineStageCue(range);
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
  const blockBgClass = isDeleteConfirmHighlighted
    ? "bg-red-100"
    : isSelected
      ? "bg-[#eef3fa]"
    : isCharacterFocusHighlighted
      ? "bg-purple-50"
      : isFocused
      ? "bg-zinc-100/70"
      : (index ?? 0) % 2 === 1
        ? "bg-zinc-50/60"
        : "";
  const movedGlowClass = isRecentlyMoved
    ? isSelected
      ? "script-block-moved-glow"
      : isCharacterFocusHighlighted
        ? "script-block-updated-focus-glow"
        : "script-block-updated-glow"
    : "";
  const compactDeleteStyle: React.CSSProperties | undefined = compactControlLayout?.deleteLeft !== null && compactControlLayout?.deleteLeft !== undefined
    ? { left: compactControlLayout.deleteLeft }
    : undefined;
  const compactContentStyle: React.CSSProperties | undefined = compactControlLayout?.contentPaddingLeft !== null && compactControlLayout?.contentPaddingLeft !== undefined
    ? { paddingLeft: compactControlLayout.contentPaddingLeft }
    : undefined;
  const hasReadOnlySceneLabel = !canEditMetadata && !!readOnlyScene;
  const hasStageComment = !!block.stageComment?.trim();
  const showStageCommentAddButton = isFocused || isSelected || (hideCharSelector && !effectiveHideCharSelector);
  const showCharacterSelector = !effectiveHideCharSelector || isFocused || isSelected;
  const compactControlHoverStyle: React.CSSProperties | undefined = isCompactHiddenCharacterLayout
    ? { width: compactControlLayout.hoverWidth }
    : undefined;
  const rightActionRowClass = `absolute ${scenePickerOpen ? "z-40" : "z-20"} flex items-center transition-opacity ${
    isStage || isCompactHiddenCharacterLayout ? "-top-5" : "top-1"
  } ${hasReadOnlySceneLabel ? "right-8" : "right-2"}`;
  const readOnlySceneLabelClass = `absolute right-1.5 z-10 leading-none ${
    isStage || isCompactHiddenCharacterLayout ? "-top-5" : "top-1"
  }`;
  const lineNumberClass = isFocused
    ? "text-zinc-600"
    : readOnlyRehearsalMode
      ? "text-zinc-300 group-hover:text-zinc-500"
      : "text-zinc-400 group-hover:text-zinc-600";
  return (
    <div
      ref={blockRootRef}
      onDragOver={onDragOverBlock}
      onDrop={onDropBlock}
      onMouseLeave={resetCompactControlHover}
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

      {(lineNum !== undefined || canEditRehearsalMark || (showReadOnlyRehearsalMark && isMarkStart && block.rehearsalMark)) && (
        <span className="absolute left-1.5 top-[3px] z-20 flex items-start gap-1 leading-none">
          {lineNum !== undefined && (
            <span className={`pointer-events-none select-none tabular-nums text-[9px] leading-none transition-colors ${lineNumberClass}`}>
              {lineNum}
            </span>
          )}
          {canEditRehearsalMark && (
            <span
              onMouseEnter={unfoldCompactControls}
              className={`relative top-[1px] transition-opacity ${isMarkStart && block.rehearsalMark && showRehearsalMark ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            >
              <RehearsalMarkInput
                mark={block.rehearsalMark}
                onChange={onMarkChange}
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
                  {selectedCount > 1 ? `确认删除所选 ${selectedCount} 行？` : "确认删除此行？"}
                </span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
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
        {canEditMetadata && (
          <div className={`transition-opacity ${block.sceneId ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            <ScenePicker
              scenes={scenes}
              availableScenes={availableScenes}
              sceneId={block.sceneId}
              onChange={onSceneChange}
              onOpenChange={setScenePickerOpen}
            />
          </div>
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
      {hasReadOnlySceneLabel && (
        <span className={readOnlySceneLabelClass}>
          <SceneLabel scene={readOnlyScene} focused={isFocused} />
        </span>
      )}

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
        />
      )}

      {!isStage && block.characterIds.length > 0 && (hasStageComment || !effectiveHideCharSelector || isFocused || isSelected) && (
        <BlockStageComment
          value={block.stageComment}
          onChange={(stageComment) => onUpdate({ stageComment })}
          showAddButton={showStageCommentAddButton}
          topGap={readOnlyRehearsalMode && hideCharSelector ? "leading" : showCharacterSelector ? "compact" : undefined}
          readOnly={!canEditText || isEditingLocked}
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
        style={compactContentStyle}
        className={`w-full min-h-[1.75rem] pl-1 outline-none text-base leading-7 break-words ${isScriptDragging || isEditingLocked ? "caret-transparent" : ""} ${
          isStage ? "font-stage italic text-zinc-400 text-left" :
          block.lyric ? "font-lyric font-bold text-zinc-700 text-center uppercase" :
          "font-script text-zinc-700 text-center"
        }`}
      />

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

function InsertZone({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="group flex h-5 items-center justify-center">
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

// ─── CommentsPanel ────────────────────────────────────────────────────────────

function CommentsPanel({
  blockId, productionId, versionId, comments, currentOpenId, isAdmin,
  onAdd, onEdit, onDelete, onClose, onNavigate,
}: {
  blockId: string; productionId: string; versionId?: string | null; comments: Comment[];
  currentOpenId: string; isAdmin: boolean;
  onAdd: (c: Comment) => void; onEdit: (c: Comment) => void;
  onDelete: (id: string) => void; onClose: () => void;
  onNavigate?: () => void;
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
    () => comments.filter(c => c.contextId === blockId && c.parentId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments, blockId],
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

  // Shared: header row (author + timestamp + edit/delete)
  const commentHeader = (c: Comment) => (
    <div className="flex items-baseline justify-between">
      <span className="text-xs font-semibold text-zinc-700">{c.authorName}</span>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-300" title={new Date(c.createdAt).toLocaleString("zh-CN")}>
          {relativeTime(c.createdAt)}
        </span>
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
        <SmartText content={c.body} memberMention={{ members: c.mentions }} className="whitespace-pre-wrap text-zinc-600" />
        {replyAction && (
          <button onClick={replyAction.onClick} className="mt-0.5 text-[11px] text-zinc-300 hover:text-zinc-500">
            {replyAction.label}
          </button>
        )}
      </div>
    )
  );

  return (
    <div className="fixed right-0 top-14 bottom-0 z-30 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-700">评论</span>
        <button onClick={onClose} className="text-lg leading-none text-zinc-300 hover:text-zinc-500">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
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
              <div key={r.id} className="group mt-2 ml-3 border-l-2 border-zinc-200 pl-3">
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
              <div className="mt-2 ml-3 border-l-2 border-zinc-200 pl-3">
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

      <div className="shrink-0 border-t border-zinc-100 px-4 py-3">
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
    </div>
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
  const [scenes, setScenes] = useState<Scene[]>([]);
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
  const selectionAnchorBlockIdRef = useRef<string | null>(null);
  const rangeSelectionActiveRef = useRef(false);
  const [shiftKeyDown, setShiftKeyDown] = useState(false);
  const [recentlyMovedBlockIds, setRecentlyMovedBlockIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmationRequest, setDeleteConfirmationRequest] = useState<{ anchorId: string; token: number } | null>(null);
  const [deleteConfirmingBlockIds, setDeleteConfirmingBlockIds] = useState<Set<string>>(() => new Set());
  const [dismissActionToken, setDismissActionToken] = useState(0);
  const [pendingLargeSelectionConfirmation, setPendingLargeSelectionConfirmation] =
    useState<PendingLargeSelectionConfirmation | null>(null);
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollLockedRef = useRef(true);
  const [charEditTokens, setCharEditTokens] = useState<Record<string, number>>({});

  // ── Block tags ───────────────────────────────────────────────────────────────
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [blockTagMap, setBlockTagMap] = useState<Map<string, BlockTagValue[]>>(new Map());
  const blockTagMapRef = useRef<Map<string, BlockTagValue[]>>(new Map());
  const tagClipboardRef = useRef<BlockTagValue[] | null>(null);

  // ── Script config (page layout, stage delimiters) ─────────────────────────
  const [scriptConfig, setScriptConfig] = useState<ScriptConfig>(DEFAULT_SCRIPT_CONFIG);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingLockedMode, setPendingLockedMode] = useState<boolean | null>(null);

  const saveScriptConfig = useCallback(async (patch: Partial<ScriptConfig>) => {
    if (isLockedMode) return;
    const next = { ...scriptConfig, ...patch };
    setScriptConfig(next);
    await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
  }, [scriptConfig, effectiveScriptId, isLockedMode]);

  // ── Page map (computed client-side, deterministic) ──────────────────────────
  const pageMap = useMemo(() => computePageMap(blocks, scriptConfig.pageLayout), [blocks, scriptConfig.pageLayout]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  useEffect(() => {
    setFocusedCharacterIds(readStoredCharacterFocus(effectiveScriptId));
  }, [effectiveScriptId]);
  const toggleCharacterFocus = useCallback((id: string) => {
    setFocusedCharacterIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStoredCharacterFocus(effectiveScriptId, next);
      return next;
    });
  }, [effectiveScriptId]);

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
    if (movedHighlightTimer.current !== null) {
      clearTimeout(movedHighlightTimer.current);
      movedHighlightTimer.current = null;
    }
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
  const pendingMoveCenterRef = useRef<{ id: string; index: number } | null>(null);
  const reorderNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionChangeNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigatingAwayRef = useRef(false);
  const blocksRef = useRef(blocks);
  const prevBlocksLengthRef = useRef(blocks.length);
  useLayoutEffect(() => { blocksRef.current = blocks; }, [blocks]);
  useEffect(() => { blockTagMapRef.current = blockTagMap; }, [blockTagMap]);
  useEffect(() => () => {
    if (reorderUnlockFrame.current !== null) cancelAnimationFrame(reorderUnlockFrame.current);
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    if (reorderNoticeTimer.current !== null) clearTimeout(reorderNoticeTimer.current);
    if (selectionChangeNoticeTimer.current !== null) clearTimeout(selectionChangeNoticeTimer.current);
    if (movedHighlightTimer.current !== null) clearTimeout(movedHighlightTimer.current);
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
    const next = new Set(ids.filter(Boolean));
    if (next.size === 0) return;
    if (movedHighlightTimer.current !== null) clearTimeout(movedHighlightTimer.current);
    setRecentlyMovedBlockIds(next);
    movedHighlightTimer.current = setTimeout(() => {
      movedHighlightTimer.current = null;
      setRecentlyMovedBlockIds(new Set());
    }, 1000);
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
    const current = windowRangeRef.current;
    if (current.start === next.start && current.end === next.end) return;
    windowRangeRef.current = next;
    if (windowRangeFrameRef.current !== null) cancelAnimationFrame(windowRangeFrameRef.current);
    const commit = () => {
      windowRangeFrameRef.current = null;
      setWindowRange((currentRange) => (
        currentRange.start === next.start && currentRange.end === next.end
          ? currentRange
          : next
      ));
    };
    if (sync) commit();
    else windowRangeFrameRef.current = requestAnimationFrame(commit);
  }, []);

  // Rebuild cumulative heights from cache
  const rebuildCumulative = useCallback(() => {
    const bl = blocksRef.current;
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
    if (navigatingAwayRef.current) return;
    if (draggingBlockId.current || isReorderLockedRef.current) return;
    const container = blocksContainerRef.current;
    const bl = blocksRef.current;
    if (!container || bl.length === 0) return;
    const containerTop = container.getBoundingClientRect().top + window.scrollY;
    const sy = window.scrollY;
    const viewStart = Math.max(0, sy - containerTop);
    const viewEnd = viewStart + window.innerHeight;

    let newStart = Math.max(0, blockAtOffset(viewStart) - VSCROLL_BUFFER);
    let newEnd = Math.min(bl.length, blockAtOffset(viewEnd) + VSCROLL_BUFFER + 1);

    // Always keep the focused block rendered
    const fi = focusedIdRef.current ? bl.findIndex(b => b.id === focusedIdRef.current) : -1;
    if (fi >= 0) { newStart = Math.min(newStart, fi); newEnd = Math.max(newEnd, fi + 1); }
    const pfi = pendingFocus.current ? bl.findIndex(b => b.id === pendingFocus.current?.id) : -1;
    if (pfi >= 0) { newStart = Math.min(newStart, pfi); newEnd = Math.max(newEnd, pfi + 1); }

    applyWindowRange({ start: newStart, end: newEnd });
  }, [applyWindowRange]);

  // Always-fresh scroll-position saver (reads DOM directly; avoids stale cumulative-height estimates)
  const saveScrollPosRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveScrollPosRef.current = () => {
      if (loadState !== "ready" || !productionId) return;
      const container = blocksContainerRef.current;
      if (!container) return;
      // Find the last rendered block whose top edge is at or above the viewport top (y=0).
      // This is DOM-accurate and does not depend on cumulativeHRef estimates.
      let savedId: string | null = null;
      for (const el of container.querySelectorAll<HTMLElement>("[data-bwrap]")) {
        if (el.getBoundingClientRect().top <= 0) savedId = el.dataset.bwrap ?? null;
        else break;
      }
      if (savedId) document.cookie = `script_pos_${productionId}=${encodeURIComponent(savedId)}; path=/; max-age=31536000; SameSite=Lax`;
    };
  });

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
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (navigatingAwayRef.current) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recomputeWindow);
      if (!scrollLockedRef.current) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveScrollPosRef.current(), 400);
        // User took control of scroll — abandon any pending post-navigation correction
        postNavCorrectionRef.current = null;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    recomputeWindow();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(rafId); clearTimeout(saveTimer); };
  }, [recomputeWindow]);

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
  });

  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const centerTarget = pendingMoveCenterRef.current;
    if (centerTarget === null) return;
    if (blocks.length === 0) {
      pendingMoveCenterRef.current = null;
      return;
    }
    const windowSize = Math.min(INITIAL_WINDOW_SIZE, blocks.length);
    const centerIdx = Math.max(0, Math.min(blocks.length - 1, centerTarget.index));
    let start = Math.max(0, centerIdx - Math.floor(windowSize / 2));
    const end = Math.min(blocks.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    pendingMoveCenterRef.current = null;
    const nextRange = { start, end };
    const currentRange = windowRangeRef.current;
    const rangeChanged = currentRange.start !== nextRange.start || currentRange.end !== nextRange.end;
    pendingNavigateRef.current = { kind: "block", id: centerTarget.id, align: "center" };
    applyWindowRange(nextRange, true);
    if (!rangeChanged) {
      const el = document.getElementById(`block-${centerTarget.id}`);
      if (el) {
        pendingNavigateRef.current = null;
        el.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
  }, [blocks, applyWindowRange]);

  // Precise correction pass: fires after newly-rendered blocks are measured (before next paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    if (correctionTick === 0) return;
    const nav = postNavCorrectionRef.current;
    if (!nav) return;
    postNavCorrectionRef.current = null;
    const el = nav.kind === 'block'
      ? document.getElementById(`block-${nav.id}`)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    // Measurements are now fresh — rebuild and re-correct spacers before scrollIntoView
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocksRef.current.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    el.scrollIntoView({ behavior: 'instant', block: nav.kind === 'block' ? nav.align : 'start' });
    setScrollLocked(false);
  // windowRange is intentionally in deps — ensures this captures the post-recomputeWindow value;
  // postNavCorrectionRef going null after the first correction prevents repeated firing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange]);

  // After each window-changing render, execute any pending navigation (fires before paint)
  useLayoutEffect(() => {
    if (navigatingAwayRef.current) return;
    const nav = pendingNavigateRef.current;
    if (!nav) return;
    const el = nav.kind === 'block'
      ? document.getElementById(`block-${nav.id}`)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    pendingNavigateRef.current = null;

    // The spacerH state hasn't re-rendered yet — the spacer divs still hold the old window's
    // heights. Correct them synchronously in the DOM so scrollIntoView lands at the right place.
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocksRef.current.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;

    el.scrollIntoView({ behavior: 'instant', block: nav.kind === 'block' ? nav.align : 'start' });

    // Newly-rendered blocks haven't been measured yet so the cumulative heights are estimated.
    // Store the target so the measurement effect can trigger a precise correction pass.
    postNavCorrectionRef.current = nav;
  }, [windowRange, rebuildCumulative]);

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
    const el = document.getElementById(`block-${block.id}`);
    if (el) { el.scrollIntoView({ behavior: 'instant', block: align }); return; }
    // Otherwise shift the window and let useLayoutEffect land us there
    pendingNavigateRef.current = { kind: 'block', id: block.id, align };
    const nextRange = {
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocksRef.current.length, idx + VSCROLL_BUFFER + 1),
    };
    applyWindowRange(nextRange, true);
  }, [applyWindowRange]);

  const scrollToScene = useCallback((sceneId: string) => {
    const existing = document.getElementById(`scene-block-${sceneId}`);
    if (existing) { existing.scrollIntoView({ behavior: 'instant', block: 'start' }); return; }
    const idx = blocksRef.current.findIndex(b => b.sceneId === sceneId);
    if (idx < 0) return;
    pendingNavigateRef.current = { kind: 'scene', id: sceneId };
    const nextRange = {
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocksRef.current.length, idx + VSCROLL_BUFFER + 1),
    };
    applyWindowRange(nextRange, true);
  }, [applyWindowRange]);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);

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
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable ref to the push function so the debounce closure never goes stale.
  const pushPatchRef = useRef<(curr: ScriptState) => void>(() => {});

  useEffect(() => {
    pushPatchRef.current = async (curr: ScriptState) => {
      if (!canEdit) return;
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
      }
    };
  }, [effectiveScriptId, activeVersionId, canEdit]);

  type LoadState = "loading" | "ready" | "not-found" | "error";
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string>("");

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoadState("loading");
    setLoadError("");
    setBlocks([makeBlock()]);
    setCharacters([]);
    setScenes([]);
    /* eslint-enable react-hooks/set-state-in-effect */
    syncedStateRef.current = null;

    const vParam = activeVersionId ? `?v=${encodeURIComponent(activeVersionId)}` : "";
    const loadUrl = productionId
      ? `${BASE_PATH}/api/production/${productionId}${vParam}`
      : `${BASE_PATH}/api/script/${effectiveScriptId}${vParam}`;

    fetch(loadUrl)
      .then(async (r) => {
        // Production route returns { state, versionId, versions }; script route returns ScriptState directly.
        type ProdResponse = { state: ScriptState; versionId: string; versions: Version[] };
        type ErrResponse = { error?: string };
        const body = await r.json() as ProdResponse | ScriptState | ErrResponse;
        if (r.status === 404) { setLoadState("not-found"); return; }
        if (!r.ok) { setLoadError((body as ErrResponse).error ?? "加载失败"); setLoadState("error"); return; }

        const isProdResponse = productionId && "state" in body;
        const state: ScriptState = isProdResponse
          ? (body as ProdResponse).state
          : (body as ScriptState);

        if (state.blocks.length > 0) {
          setBlocks(state.blocks);
          setCharacters(state.characters);
          setScenes(state.scenes);
          syncedStateRef.current = state;
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
      })
      .catch(() => { setLoadError("网络错误，请稍后重试"); setLoadState("error"); });
  }, [effectiveScriptId, productionId, activeVersionId]);

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

  // ── Hash-based deep link + position restore ──────────────────────────────────
  useEffect(() => {
    if (loadState !== "ready") return;
    // Fallback: unlock scroll 300ms after ready (covers immediate restore and no-save cases;
    // the correction useLayoutEffect unlocks earlier for the off-screen path)
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
    // Restore last scroll position from cookie
    if (productionId) {
      try {
        const m = document.cookie.match(new RegExp(`(?:^|;\\s*)script_pos_${productionId}=([^;]*)`));
        if (m) {
          const idx = blocksRef.current.findIndex(b => b.id === decodeURIComponent(m[1]));
          if (idx >= 0) scrollToBlockIdx(idx, "start");
        }
      } catch { /* ignore */ }
    }
    return () => clearTimeout(unlockTimer);
  }, [loadState, productionId, scrollToBlockIdx]);

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
          if (!r.ok) return;
          const serverState = await r.json() as ScriptState;

          const oldSynced = syncedStateRef.current;
          serverSeqRef.current = seq;

          setBlocks(prev => mergeServerBlocks(prev, serverState.blocks, oldSynced));
          setCharacters(serverState.characters);
          setScenes(serverState.scenes);
          syncedStateRef.current = serverState;
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
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
  const [activeAssetBlockId, setActiveAssetBlockId] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [meOpenId, setMeOpenId] = useState("");
  const [meIsAdmin, setMeIsAdmin] = useState(false);

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
  }, [sendPresence]);

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
  const scenesRef = useRef(scenes);
  const scriptConfigRef = useRef(scriptConfig);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);
  useEffect(() => { scriptConfigRef.current = scriptConfig; }, [scriptConfig]);

  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const curr: ScriptState = {
        config: scriptConfigRef.current,
        blocks: blocksRef.current,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, characters, scenes, blockTagMap]);

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
    setBlocks(snapshot);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, [isLockedMode]);

  const redo = useCallback(() => {
    if (isLockedMode) return;
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = redoStack.current.pop();
    if (!snapshot) return;
    undoStack.current.push(blocksRef.current);
    setBlocks(snapshot);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, [isLockedMode]);

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
        setBlocks(bs => bs.map(b => b.id === blockId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
      }
    }
  }, [blockTagMapRef, tagGroups, isLockedMode]);

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
      setBlocks(bs => bs.map(b => b.id === toId && b.lyric !== newLyric ? { ...b, lyric: newLyric } : b));
    }
    // Tags (and the corrected lyric) are synced atomically via the debounced block op PATCH.
  }, [blockTagMap, tagGroups]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
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
    scrollToBlockIdx(Math.max(0, Math.min(n - 1, blocks.length - 1)), 'center');
  }, [blocks.length, scrollToBlockIdx]);

  const jumpToPage = useCallback((n: number) => {
    const idx = blocks.findIndex(b => pageMap[b.id] === n);
    if (idx >= 0) scrollToBlockIdx(idx, 'start');
  }, [blocks, pageMap, scrollToBlockIdx]);

  const toggleBlockType = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      b.id === id
        ? { ...b, type: b.type === "dialogue" ? "stage" : "dialogue", characterIds: [] }
        : b
    ));
    glowAndFocusBlocks([id]);
  }, [glowAndFocusBlocks, saveSnapshot, isLockedMode]);

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
      wrapSelectionAsInlineStageCue(range);
      editableEl.focus();
      editableEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    toggleBlockType(id);
  }, [toggleBlockType]);

  const toggleBlockLyric = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      b.id === id ? { ...b, lyric: !b.lyric } : b
    ));
    glowAndFocusBlocks([id]);
  }, [glowAndFocusBlocks, saveSnapshot, isLockedMode]);

  const setBlocksType = useCallback((ids: string[], type: BlockType) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id)
        ? { ...b, type, characterIds: type === "stage" ? [] : b.characterIds }
        : b
    ));
    glowAndFocusBlocks(ids);
    rangeSelectionActiveRef.current = false;
  }, [glowAndFocusBlocks, saveSnapshot, isLockedMode]);

  const setBlocksLyric = useCallback((ids: string[], lyric: boolean) => {
    if (isLockedMode) return;
    const targetIds = new Set(ids);
    if (targetIds.size === 0) return;
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      targetIds.has(b.id) && b.type !== "stage"
        ? { ...b, lyric }
        : b
    ));
    glowAndFocusBlocks(ids);
    rangeSelectionActiveRef.current = false;
  }, [glowAndFocusBlocks, saveSnapshot, isLockedMode]);

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
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
    },
    [startTypingSession, isLockedMode]
  );

  // Cascade a scene boundary change, preserving monotonic scene order.
  // null is treated as order -1 (before all named scenes).
  // Moving to a later scene  → cascade the tail of the current run forward.
  // Moving to an earlier scene → cascade the head of the current run backward.
  const updateBlockScene = useCallback((id: string, newSceneId: string | null) => {
    if (isLockedMode) return;
    const ord = (sid: string | null) =>
      sid === null ? -1 : scenes.findIndex((s) => s.id === sid);

    saveSnapshot();
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const oldSceneId = prev[idx].sceneId;
      if (oldSceneId === newSceneId) return prev;

      if (ord(newSceneId) >= ord(oldSceneId)) {
        // Forward: idx → end of same-scene run
        let end = idx;
        while (end + 1 < prev.length && prev[end + 1].sceneId === oldSceneId) end++;
        return prev.map((b, i) => (i >= idx && i <= end ? { ...b, sceneId: newSceneId } : b));
      } else {
        // Backward: start of same-scene run → idx
        let start = idx;
        while (start > 0 && prev[start - 1].sceneId === oldSceneId) start--;
        return prev.map((b, i) => (i >= start && i <= idx ? { ...b, sceneId: newSceneId } : b));
      }
    });
  }, [saveSnapshot, scenes, isLockedMode]);

  // Same cascade logic for rehearsal marks.
  const updateBlockMark = useCallback((id: string, newMark: string | null) => {
    if (isLockedMode) return;
    saveSnapshot();
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const oldMark = prev[idx].rehearsalMark;
      if (oldMark === newMark) return prev;
      let end = idx;
      while (end + 1 < prev.length && prev[end + 1].rehearsalMark === oldMark) end++;
      return prev.map((b, i) => (i >= idx && i <= end ? { ...b, rehearsalMark: newMark } : b));
    });
  }, [saveSnapshot, isLockedMode]);

  const splitBlock = useCallback((id: string, before: string, after: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate the new block ID **outside** the setBlocks updater so the ID
    // is stable across React Strict Mode's double-invocation of the updater.
    // If makeBlock() were called inside the updater, each invocation would
    // produce a different uid(), causing nextId (from the 2nd call) to diverge
    // from the block actually committed to state (from the 1st call).
    const nextBlockId = uid();
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const cur = prev[idx];
      // New block inherits scene, rehearsal mark, and character from the block being split
      const next: Block = {
        ...makeBlock(after, cur.characterIds),
        id: nextBlockId,   // use the pre-generated stable ID
        sceneId: cur.sceneId,
        rehearsalMark: cur.rehearsalMark,
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
  }, [saveSnapshot, inheritTags, isLockedMode]);

  const mergeBlock = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
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
  }, [saveSnapshot, isLockedMode]);

  const deleteBlock = useCallback((id: string) => {
    if (isLockedMode) return;
    saveSnapshot();
    // Pre-generate replacement block ID outside the updater (Strict Mode fix).
    const emptyBlockId = uid();
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      if (prev.length <= 1) {
        const emptyBlock = { ...makeBlock(), id: emptyBlockId };
        pendingFocus.current = { id: emptyBlock.id, atEnd: false };
        return [emptyBlock];
      }
      const nextFocus = prev[idx + 1] ?? prev[idx - 1];
      if (nextFocus) pendingFocus.current = { id: nextFocus.id, atEnd: false };
      return prev.filter((b) => b.id !== id);
    });
    if (selectionAnchorBlockIdRef.current === id) {
      selectionAnchorBlockIdRef.current = null;
      rangeSelectionActiveRef.current = false;
    }
  }, [saveSnapshot, isLockedMode]);

  const deleteBlocks = useCallback((ids: string[]) => {
    if (isLockedMode) return;
    const deleteIds = new Set(ids);
    if (deleteIds.size === 0) return;
    saveSnapshot();
    const emptyBlockId2 = uid(); // pre-generated for the case where all blocks are deleted
    setBlocks((prev) => {
      const remaining = prev.filter((b) => !deleteIds.has(b.id));
      if (remaining.length === prev.length) return prev;
      if (remaining.length === 0) {
        const emptyBlock = { ...makeBlock(), id: emptyBlockId2 };
        pendingFocus.current = { id: emptyBlock.id, atEnd: false };
        return [emptyBlock];
      }
      const firstDeletedIdx = prev.findIndex((b) => deleteIds.has(b.id));
      const focusIdx = Math.min(firstDeletedIdx, remaining.length - 1);
      pendingFocus.current = { id: remaining[focusIdx].id, atEnd: false };
      return remaining;
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
  }, [saveSnapshot, isLockedMode]);

  const requestSelectedBlocksDelete = useCallback(() => {
    if (isLockedMode) return false;
    const selectedIds = Array.from(selectedBlockIds);
    if (selectedIds.length === 0) return false;
    const selectedIdSet = new Set(selectedIds);
    const selectedBlocks = blocks.filter((b) => selectedIdSet.has(b.id));
    if (selectedBlocks.length === 0) return false;
    if (selectedBlocks.every(isBlockEmptyForDelete)) {
      requestLargeSelectionOperation("delete", selectedIds.length, () => deleteBlocks(selectedIds));
      return true;
    }
    const visibleAnchor = blocks
      .slice(windowRange.start, windowRange.end)
      .find((b) => selectedIdSet.has(b.id));
    const anchorId = visibleAnchor?.id ?? selectedBlocks[0].id;
    setDeleteConfirmationRequest((current) => ({
      anchorId,
      token: (current?.token ?? 0) + 1,
    }));
    setDeleteConfirmingBlockIds(new Set(selectedIds));
    return true;
  }, [blocks, deleteBlocks, requestLargeSelectionOperation, selectedBlockIds, windowRange.end, windowRange.start, isLockedMode]);

  const dismissBlockConfirmations = useCallback(() => {
    setDeleteConfirmingBlockIds((current) => current.size === 0 ? current : new Set());
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
      if (target.closest("[data-script-confirmation='true']")) return;
      if (target.closest("[data-script-block-bar='true']") || target.closest("[data-script-selection-action='true']")) {
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
    const toIdx = prev.findIndex((b) => b.id === resolvedTarget.id);
    if (toIdx === -1) {
      showReorderNotice("移动失败：目标位置已失效，请重新拖拽。");
      return false;
    }

    const moving = prev.filter((b) => movingIds.has(b.id));
    if (moving.length === 0) {
      showReorderNotice("移动失败：未找到被拖拽内容。");
      return false;
    }

    const rawInsertIdx = resolvedTarget.position === "before" ? toIdx : toIdx + 1;
    const remaining = prev.filter((b) => !movingIds.has(b.id));
    const removedBeforeInsert = prev
      .slice(0, rawInsertIdx)
      .filter((b) => movingIds.has(b.id)).length;
    const insertIdx = Math.max(0, Math.min(remaining.length, rawInsertIdx - removedBeforeInsert));
    const ref = insertIdx > 0 ? remaining[insertIdx - 1] : null;
    const moved = moving.map((b) => ({
      ...b,
      sceneId: ref?.sceneId ?? null,
      rehearsalMark: ref?.rehearsalMark ?? null,
    }));
    const metadataChanged = moving.some((b, i) =>
      b.sceneId !== moved[i].sceneId || b.rehearsalMark !== moved[i].rehearsalMark
    );
    const next = [...remaining];
    next.splice(insertIdx, 0, ...moved);
    if (next.every((b, i) => b.id === prev[i]?.id)) {
      showReorderNotice("移动未执行：目标位置与当前位置相同。");
      return false;
    }

    requestLargeSelectionOperation("move", moving.length, () => {
      saveSnapshot();
      setBlocks(next);
      pendingMoveCenterRef.current = {
        id: moved[0].id,
        index: Math.max(0, Math.min(next.length - 1, insertIdx)),
      };
      glowChangedBlocks(moving.map((b) => b.id));
      selectionAnchorBlockIdRef.current = moving[0]?.id ?? null;
      rangeSelectionActiveRef.current = false;
      setSelectedBlockIds(new Set(moving.map((b) => b.id)));
      if (moving.length > 1 && metadataChanged) {
        const scene = moved[0].sceneId ? sceneById.get(moved[0].sceneId) : null;
        const sceneLabel = scene
          ? [scene.number.trim(), scene.name.trim()].filter(Boolean).join("-") || "（未命名）"
          : "（无章节）";
        const markLabel = moved[0].rehearsalMark?.trim() || "(空)";
        showSelectionChangeNotice(`当前 ${moving.length} 行的章节与排练记号已更改为：${sceneLabel}-${markLabel}`);
      }
      unlockReorderAfterCommit();
    }, unlockReorder);
    return true;
  }, [glowChangedBlocks, requestLargeSelectionOperation, saveSnapshot, sceneById, showReorderNotice, showSelectionChangeNotice, unlockReorder, unlockReorderAfterCommit, isLockedMode]);

  const isNoopDragTarget = useCallback((fromIds: string[], target: DragTarget): boolean => {
    const movingIds = new Set(fromIds);
    if (movingIds.size === 0) return true;
    const currentBlocks = blocksRef.current;
    const resolvedTarget = resolveDragTarget(target, currentBlocks, windowRangeRef.current);
    if (!resolvedTarget) return true;
    const toIdx = currentBlocks.findIndex((b) => b.id === resolvedTarget.id);
    if (toIdx < 0) return true;
    const rawInsertIdx = resolvedTarget.position === "before" ? toIdx : toIdx + 1;
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
    for (const row of rows) {
      const id = row.dataset.bwrap;
      const idx = currentBlocks.findIndex((b) => b.id === id);
      if (idx < 0) continue;
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
    setBlocks((prev) => {
      // Inherit scene and rehearsal mark from the block immediately before the insertion point
      const ref = index > 0 ? prev[index - 1] : null;
      const newBlock: Block = {
        ...makeBlock(),
        id: newBlockId,  // use the pre-generated stable ID
        sceneId: ref?.sceneId ?? null,
        rehearsalMark: ref?.rehearsalMark ?? null,
      };
      const updated = [...prev];
      updated.splice(index, 0, newBlock);
      pendingCharOpen.current = newBlock.id;
      return updated;
    });
    if (refId) inheritTags(refId, newBlockId);
  }, [saveSnapshot, inheritTags, isLockedMode]);

  const addChar = (name: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => [...prev, { id: uid(), name, isAggregate: false }]);
  };

  const removeChar = (charId: string) => {
    if (isLockedMode) return;
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    setBlocks((prev) =>
      prev.map((b) => {
        const { [charId]: _, ...restAnnotations } = b.characterAnnotations;
        return { ...b, characterIds: b.characterIds.filter((id) => id !== charId), characterAnnotations: restAnnotations };
      })
    );
  };

  const renameChar = (charId: string, name: string) =>
    !isLockedMode && setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? { ...c, name } : c))
    );

  const addScene = (parentId?: string) => {
    if (isLockedMode) return;
    const newScene: Scene = { id: uid(), number: "", name: "", parentId: parentId ?? null };
    if (parentId) {
      setScenes((prev) => {
        // Insert after the last sub-scene of this parent (or after the parent itself)
        let insertAfter = prev.findIndex((s) => s.id === parentId);
        for (let i = insertAfter + 1; i < prev.length; i++) {
          if (prev[i].parentId === parentId) insertAfter = i;
          else break;
        }
        const next = [...prev];
        next.splice(insertAfter + 1, 0, newScene);
        return next;
      });
    } else {
      setScenes((prev) => [...prev, newScene]);
    }
  };

  const updateScene = (id: string, number: string, name: string) => {
    if (isLockedMode) return;
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, number, name } : s)));
  };

  const removeScene = (id: string) => {
    if (isLockedMode) return;
    setScenes((prev) => prev.filter((s) => s.id !== id));
    setBlocks((prev) => prev.map((b) => (b.sceneId === id ? { ...b, sceneId: null } : b)));
  };

  const [printPreview, setPrintPreview] = useState(false);

  if (printPreview) {
    return (
      <PrintPreview
        blocks={blocks}
        characters={characters}
        scenes={scenes}
        onClose={() => setPrintPreview(false)}
      />
    );
  }

  if (loadState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100">
        <span className="text-sm text-zinc-400">加载中…</span>
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
        <div ref={setToolbarElement} className="relative mx-auto flex h-14 max-w-3xl flex-nowrap items-center gap-1 px-4">
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
                        onClick={() => { saveScriptConfig({ stageDelimOpen: open, stageDelimClose: close }); setOpenMenu(null); }}
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
                        {canImport && (
                          <>
                            <div className="my-1 border-t border-zinc-50" />
                            <Link
                              href={`/production/${productionId}/import-script`}
                              onNavigate={prepareForNavigation}
                              className="block w-full px-3 py-1.5 text-left text-sm text-blue-600 hover:bg-zinc-50"
                            >
                              导入剧本内容…
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
                onAdd={addChar}
                onRemove={removeChar}
                onRename={renameChar}
                open={openMenu === "char"}
                onOpenChange={(v) => setOpenMenu(v ? "char" : null)}
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
              max={jumpTarget === "line" ? blocks.length : Math.max(...Object.values(pageMap), 1)}
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
              placeholder={jumpTarget === "line" ? `1–${blocks.length}` : `1–${Math.max(...Object.values(pageMap), 1)}`}
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

        @keyframes scriptBlockUpdatedGlow {
          0% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0.14);
          }
          100% {
            background-color: rgba(244, 244, 245, 0.7);
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
        }

        @keyframes scriptBlockUpdatedFocusGlow {
          0% {
            background-color: #eef3fa;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0.14);
          }
          48% {
            background-color: #ffffff;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
          100% {
            background-color: #faf5ff;
            box-shadow: inset 0 0 0 9999px rgba(145, 168, 202, 0);
          }
        }

        .script-block-moved-glow {
          animation: scriptBlockMovedGlow 1s ease-in-out;
        }

        .script-block-updated-glow {
          animation: scriptBlockUpdatedGlow 1s ease-in-out;
        }

        .script-block-updated-focus-glow {
          animation: scriptBlockUpdatedFocusGlow 1s ease-in-out;
        }
      `}</style>

      {/* Document */}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="relative min-h-[70vh] rounded-2xl bg-white shadow-sm flex flex-col pt-6 pb-8">
          <TableOfContents scenes={scenes} blocks={blocks} onScrollToScene={scrollToScene} />
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
            const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter(Boolean));

            // Pre-compute scene-header state for blocks before the visible window
            let lastRenderedActId: string | undefined = undefined;
            for (let pi = 0; pi < safeWindowStart; pi++) {
              const pb = blocks[pi];
              const pp = pi > 0 ? blocks[pi - 1] : null;
              if (pb.sceneId === null || pb.sceneId === pp?.sceneId) continue;
              const pscene = scenes.find(s => s.id === pb.sceneId);
              if (!pscene) continue;
              const pci = scenes.findIndex(s => s.id === pb.sceneId);
              const ppi = pp?.sceneId != null ? scenes.findIndex(s => s.id === pp.sceneId) : -1;
              const pskipped = pci > ppi + 1 ? scenes.slice(ppi + 1, pci).filter(s => !usedSceneIds.has(s.id)) : [];
              const sim = (s: Scene) => {
                if (s.parentId !== null) {
                  if (s.parentId !== lastRenderedActId) {
                    const a = scenes.find(a => a.id === s.parentId);
                    if (a) lastRenderedActId = a.id;
                  }
                } else { lastRenderedActId = s.id; }
              };
              for (const s of pskipped) sim(s);
              sim(pscene);
            }
            const hasFocusedCharacters = focusedCharacterIds.size > 0;

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

            // Monotonicity-safe scene picker: only show scenes within the window
            // defined by the runs immediately before and after the current run.
            // null is treated as order -1. This prevents the user from creating
            // out-of-order scene sequences (e.g. 00 → 01 → 00).
            const ord = (sid: string | null) =>
              sid === null ? -1 : scenes.findIndex((s) => s.id === sid);
            let runStart = bIdx, runEnd = bIdx;
            while (runStart > 0 && blocks[runStart - 1].sceneId === block.sceneId) runStart--;
            while (runEnd + 1 < blocks.length && blocks[runEnd + 1].sceneId === block.sceneId) runEnd++;
            const prevRunOrd = runStart > 0 ? ord(blocks[runStart - 1].sceneId) : -1;
            const nextRunOrd = runEnd + 1 < blocks.length ? ord(blocks[runEnd + 1].sceneId) : scenes.length;
            const availableScenes = scenes.filter((_, i) => i >= prevRunOrd && i <= nextRunOrd);

            const sceneStart = block.sceneId !== null && block.sceneId !== prev?.sceneId;
            const isMarkStart = block.rehearsalMark !== (prev?.rehearsalMark ?? null);
            const pageBreak = bIdx > 0 && pageMap[block.id] !== pageMap[prev!.id];
            const hideCharSelector =
              focusedId === block.id || (pageBreak && display.pageBreaks) ? false : shouldHideCharacterLabel(prev, block);
            const showCharacterGap = isLockedMode && shouldShowCharacterGap(prev, block, hideCharSelector);
            const matchOrder = searchMatches.indexOf(bIdx);
            const searchHighlight: "focused" | "match" | undefined =
              matchOrder === searchIdx ? "focused" : matchOrder >= 0 ? "match" : undefined;
            const isSelected = selectedBlockIds.has(block.id);
            const isCharacterFocusHighlighted =
              hasFocusedCharacters && block.characterIds.some((id) => focusedCharacterIds.has(id));
            const selectedDeleteIds = isSelected ? Array.from(selectedBlockIds) : [block.id];
            const selectedCount = selectedDeleteIds.length;
            const canDeleteWithoutConfirmation = selectedDeleteIds.every((id) => {
              const selectedBlock = blocks.find((b) => b.id === id);
              return selectedBlock ? isBlockEmptyForDelete(selectedBlock) : false;
            });
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
                data-scene-anchor={sceneStart ? block.sceneId : undefined}
                className={`min-w-0 scroll-mt-20 transition-[outline] duration-150${highlightedBlockId === block.id ? " outline outline-2 outline-amber-400 rounded-lg" : ""}`}
              >
                {/* Scene anchor for TableOfContents links */}
                {sceneStart && <span id={`scene-block-${block.sceneId}`} className="pointer-events-none absolute" />}
                {pageBreak && display.pageBreaks && (
                  <div className="relative my-2 flex items-center gap-2 px-6 select-none">
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                    <span className="shrink-0 rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                      第 {pageMap[block.id]} 页
                    </span>
                    <div className="flex-1 border-t border-dashed border-zinc-200" />
                  </div>
                )}
                {sceneStart && (() => {
                  const scene = scenes.find((s) => s.id === block.sceneId);
                  const currentIdx = scene ? scenes.findIndex((s) => s.id === block.sceneId) : -1;
                  const prevIdx = prev?.sceneId != null ? scenes.findIndex((s) => s.id === prev.sceneId) : -1;
                  const skipped = currentIdx > prevIdx + 1
                    ? scenes.slice(prevIdx + 1, currentIdx).filter((s) => !usedSceneIds.has(s.id))
                    : [];

                  const headerEls: React.ReactNode[] = [];

                  // Emit a scene header, inserting parent act header when needed.
                  const emitHeader = (s: Scene, anchor?: string) => {
                    if (s.parentId !== null) {
                      // Sub-scene: ensure its parent act is shown first
                      if (s.parentId !== lastRenderedActId) {
                        const act = scenes.find((a) => a.id === s.parentId);
                        if (act) {
                          const actAnchor = !usedSceneIds.has(act.id) ? act.id : undefined;
                          headerEls.push(
                            <div key={`act-${act.id}`} id={actAnchor ? `scene-block-${actAnchor}` : undefined} className={actAnchor ? "scroll-mt-20" : undefined}>
                              <SceneHeader scene={act} />
                            </div>
                          );
                          lastRenderedActId = act.id;
                        }
                      }
                    } else {
                      lastRenderedActId = s.id;
                    }
                    headerEls.push(
                      <div key={`sh-${s.id}`} id={anchor ? `scene-block-${anchor}` : undefined} className={anchor ? "scroll-mt-20" : undefined}>
                        <SceneHeader scene={s} />
                      </div>
                    );
                  };

                  for (const s of skipped) emitHeader(s, s.id);
                  if (scene) emitHeader(scene); // block container already has the current scene's anchor

                  return <>{headerEls}</>;
                })()}
                <ScriptBlock
                  block={block}
                  index={bIdx}
                  lineNum={display.lineNumbers ? bIdx + 1 : undefined}
                  isSearchHighlight={searchHighlight}
                  showRehearsalMark={display.rehearsalMarks}
                  showReadOnlyRehearsalMark={isLockedMode && display.rehearsalMarks}
                  readOnlyRehearsalMode={isLockedMode}
                  readOnlyScene={isLockedMode && display.rehearsalBlockScenes && block.sceneId ? sceneById.get(block.sceneId) ?? null : null}
                  stageDelimOpen={scriptConfig.stageDelimOpen}
                  stageDelimClose={scriptConfig.stageDelimClose}
                  characters={characters}
                  scenes={scenes}
                  availableScenes={availableScenes}
                  hideCharSelector={hideCharSelector}
                  isFocused={focusedId === block.id}
                  dragTarget={dragTarget?.kind === "block" && dragTarget.id === block.id ? dragTarget : null}
                  isSelected={isSelected}
                  isDeleteConfirmHighlighted={deleteConfirmingBlockIds.has(block.id)}
                  isCharacterFocusHighlighted={isCharacterFocusHighlighted}
                  isRecentlyMoved={recentlyMovedBlockIds.has(block.id)}
                  deleteConfirmToken={deleteConfirmationRequest?.anchorId === block.id ? deleteConfirmationRequest.token : undefined}
                  selectedCount={selectedCount}
                  canDeleteWithoutConfirmation={canDeleteWithoutConfirmation}
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
                  onSceneChange={(id) => updateBlockScene(block.id, id)}
                  onMarkChange={(m) => updateBlockMark(block.id, m)}
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
                  commentCount={comments.filter(c => c.contextId === block.id).length}
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
                  canEditText ? <InsertZone key={`iz-${bIdx}`} onInsert={() => insertBlockAt(bIdx)} /> :
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
          {canEditText ? <InsertZone onInsert={() => insertBlockAt(blocks.length)} /> : null}
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
        <div className="fixed right-0 top-14 bottom-0 z-30 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
            <span className="text-sm font-semibold text-zinc-700">附件</span>
            <button onClick={() => setActiveAssetBlockId(null)} className="text-lg leading-none text-zinc-300 hover:text-zinc-500">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <BlockMountAssets
              productionId={productionId}
              blockId={activeAssetBlockId}
              versionId={activeVersionId ?? null}
              label="Block 附件"
              canEdit={true}
              display="panel"
              onNavigate={prepareForNavigation}
            />
          </div>
        </div>
      )}

      {activeCommentBlockId && productionId && (
        <CommentsPanel
          blockId={activeCommentBlockId}
          productionId={productionId}
          versionId={activeVersionId}
          comments={comments}
          currentOpenId={meOpenId}
          isAdmin={meIsAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentBlockId(null)}
          onNavigate={prepareForNavigation}
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
