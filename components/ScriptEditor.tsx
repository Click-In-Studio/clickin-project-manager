"use client";

import React from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import {
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
import type { Block, BlockType, Character, Scene, ScriptState, ScriptConfig, PageLayout } from "@/lib/script-types";
import type { TagGroup, BlockTagValue } from "@/lib/db";
import TagGroupEditor from "@/components/TagGroupEditor";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { diffState } from "@/lib/script-ops";
import { computePageMap, DEFAULT_PAGE_CONFIG, PAGE_CONFIGS } from "@/lib/script-page";
import type { PageConfig } from "@/lib/script-page";

let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;

const Chevron = () => (
  <svg className="h-3 w-3 opacity-50" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Display settings (cookie-persisted) ───────────────────────────────────────
type DisplaySettings = { pageBreaks: boolean; lineNumbers: boolean; rehearsalMarks: boolean; blockTags: boolean };
const DEFAULT_DISPLAY: DisplaySettings = { pageBreaks: true, lineNumbers: true, rehearsalMarks: true, blockTags: true };
const DISPLAY_COOKIE = "script_display";
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

const makeBlock = (content = "", characterIds: string[] = [], type: BlockType = "dialogue"): Block => ({
  id: uid(),
  type,
  content,
  characterIds,
  characterAnnotations: {},
  lyric: false,
  sceneId: null,
  rehearsalMark: null,
});

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
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (offset + node.length >= target) {
      const r = document.createRange();
      r.setStart(node, target - offset);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      return;
    }
    offset += node.length;
  }
  setCursorAtEnd(div);
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
  for (let i = 0; i < usedOrdered.length; i++) {
    const prevIdx = i === 0 ? -1 : scenes.findIndex((s) => s.id === usedOrdered[i - 1].id);
    const currIdx = scenes.findIndex((s) => s.id === usedOrdered[i].id);
    for (let j = prevIdx + 1; j < currIdx; j++) {
      if (!usedSceneIds.has(scenes[j].id)) orderedScenes.push(scenes[j]);
    }
    orderedScenes.push(usedOrdered[i]);
  }
  // Append any unused scenes that come after the last used scene.
  const lastIdx = usedOrdered.length
    ? scenes.findIndex((s) => s.id === usedOrdered[usedOrdered.length - 1].id)
    : -1;
  for (let j = lastIdx + 1; j < scenes.length; j++) {
    if (!usedSceneIds.has(scenes[j].id)) orderedScenes.push(scenes[j]);
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

  if (lastSeenNumber !== scene.number) { setLastSeenNumber(scene.number); setNumber(scene.number); }
  if (lastSeenName !== scene.name) { setLastSeenName(scene.name); setName(scene.name); }

  const commit = () => {
    if (number.trim() !== scene.number || name.trim() !== scene.name) {
      onUpdate(scene.id, number.trim(), name.trim());
    }
  };

  return (
    <tr className="border-b border-zinc-50 last:border-0">
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
        <button
          onClick={() => onRemove(scene.id)}
          className="text-zinc-300 transition-colors hover:text-red-400"
        >
          ×
        </button>
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
}: {
  scenes: Scene[];
  productionId: string;
  onAdd: (parentId?: string) => void;
  onUpdate: (id: string, number: string, name: string) => void;
  onRemove: (id: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canImport?: boolean;
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
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-0.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
      >
        章节 <Chevron />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-zinc-100 bg-white shadow-xl flex flex-col" style={{ maxHeight: "min(28rem, calc(100vh - 8rem))" }}>
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">章节管理</span>
            <div className="flex items-center gap-2">
              {canImport && productionId && (
                <Link href={`/production/${productionId}/import-scenes`} className="text-[11px] text-blue-400 hover:text-blue-600 transition-colors">
                  导入
                </Link>
              )}
              <Link href={`/production/${productionId}/scenes`} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
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
}: {
  scenes: Scene[];
  availableScenes: Scene[];
  sceneId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = scenes.find((s) => s.id === sceneId);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
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
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[9rem] rounded-xl border border-zinc-100 bg-white py-1 shadow-xl overflow-y-auto" style={{ maxHeight: "min(20rem, calc(100vh - 12rem))" }}>
          <button
            onMouseDown={(e) => { e.preventDefault(); onChange(null); setOpen(false); }}
            className="w-full px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-50"
          >
            — 无
          </button>
          {availableScenes.map((s) => (
            <button
              key={s.id}
              onMouseDown={(e) => { e.preventDefault(); onChange(s.id); setOpen(false); }}
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
        className="w-10 rounded border border-zinc-300 px-1 py-0.5 text-center text-[11px] font-bold uppercase outline-none"
      />
    );
  }

  return (
    <button
      onClick={() => { setDraft(mark ?? ""); setEditing(true); }}
      title="设置排练记号"
      className={`rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
        mark
          ? "text-zinc-500 hover:text-zinc-700"
          : "text-zinc-200 hover:text-zinc-400"
      }`}
    >
      {mark ?? "▶"}
    </button>
  );
}

// ─── CharacterPanel ───────────────────────────────────────────────────────────

function CharacterRow({
  char,
  onRename,
  onRemove,
}: {
  char: Character;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(char.name);

  const commit = () => {
    const t = draft.trim();
    if (t) onRename(t);
    else setDraft(char.name);
    setEditing(false);
  };

  return (
    <tr className="group border-b border-zinc-50 last:border-0">
      <td className="px-4 py-2 w-full">
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
            onClick={() => { setDraft(char.name); setEditing(true); }}
            className="cursor-text text-sm text-zinc-700 hover:text-zinc-900"
            title="点击重命名"
          >
            {char.name}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        <button
          onClick={onRemove}
          className="text-sm text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
        >
          删除
        </button>
      </td>
    </tr>
  );
}

function CharacterPanel({
  characters,
  productionId,
  onAdd,
  onRemove,
  onRename,
  open,
  onOpenChange,
}: {
  characters: Character[];
  productionId: string;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    setDraft("");
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        className={`flex items-center gap-0.5 rounded px-2 py-1 text-sm transition-colors ${
          open
            ? "bg-zinc-100 text-zinc-800"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        }`}
      >
        角色 <Chevron />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-56 rounded-xl border border-zinc-100 bg-white shadow-xl flex flex-col" style={{ maxHeight: "min(28rem, calc(100vh - 8rem))" }}>
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">角色管理</span>
            <Link href={`/production/${productionId}/characters`} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
              管理页 →
            </Link>
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
                    onRename={(name) => onRename(c.id, name)}
                    onRemove={() => onRemove(c.id)}
                  />
                ))
              )}
            </tbody>
          </table>
          </div>

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

  const addChar = (id: string) => {
    onChange([...block.characterIds, id]);
    setQuery("");
    setHighlightIdx(0);
    inputRef.current?.focus();
  };

  const removeChar = (id: string) =>
    onChange(block.characterIds.filter((c) => c !== id));

  const close = () => { setEditingWithNotify(false); setQuery(""); setHighlightIdx(0); };

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
    <div ref={wrapRef} className="relative mb-2">
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
        {selected.length > 0 && (
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setShowAnnotations((v) => !v); }}
            className="ml-auto shrink-0 text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors"
          >
            备注{showAnnotations ? " ▴" : " ▾"}
          </button>
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
        <div className="absolute left-0 top-full z-10 mt-1 w-full rounded-xl border border-zinc-100 bg-white py-1 shadow-xl overflow-y-auto" style={{ maxHeight: "min(16rem, calc(100vh - 12rem))" }}>
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
        <div className="absolute left-0 top-full z-10 mt-1 w-full rounded-xl border border-zinc-100 bg-white px-4 py-2 shadow-xl">
          <p className="text-xs text-zinc-400">无匹配角色</p>
        </div>
      )}
    </div>
  );
}

// ─── Print ────────────────────────────────────────────────────────────────────

// PageConfig and DEFAULT_PAGE_CONFIG imported from @/lib/script-page

type PrintItem =
  | { kind: "sceneHeader"; scene: Scene }
  | { kind: "block"; block: Block; hideChar: boolean };

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

  const flush = () => {
    if (curItems.length === 0) return;
    pages.push({ items: [...curItems], sceneLabel: curLabel, pageNum });
    pageNum++;
    curItems = [];
    curH = 0;
  };

  const addItem = (item: PrintItem, h: number) => {
    if (curH + h > contentH && curItems.length > 0) flush();
    curItems.push(item);
    curH += h;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const prev = i > 0 ? blocks[i - 1] : null;
    const hideChar = !!(
      prev &&
      prev.type === "dialogue" &&
      block.type === "dialogue" &&
      block.characterIds.length > 0 &&
      prev.lyric !== block.lyric &&
      _sameCharacters(prev.characterIds, block.characterIds)
    );

    if (block.sceneId && block.sceneId !== prev?.sceneId) {
      const scene = scenes.find((s) => s.id === block.sceneId);
      if (scene) {
        addItem({ kind: "sceneHeader", scene }, heights[`sh-${block.sceneId}`] ?? 52);
        curLabel = scene.number;
        if (!(scene.id in scenePageNums)) scenePageNums[scene.id] = pageNum;
      }
    }

    addItem({ kind: "block", block, hideChar }, heights[`b-${block.id}`] ?? 60);
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

  const renderBlock = (block: Block, hideChar: boolean) => {
    const isStage = block.type === "stage";
    const sel = characters.filter((c) => block.characterIds.includes(c.id));
    return (
      <div key={block.id} className="w-full py-1">
        {!isStage && !hideChar && sel.length > 0 && (
          <div className="mb-0.5 w-full text-center text-sm font-bold tracking-[0.12em] text-zinc-800">
            {sel.map((c) => { const ann = block.characterAnnotations[c.id]; return ann ? `${c.name}（${ann}）` : c.name; }).join("、")}
          </div>
        )}
        <div
          className={`w-full break-words text-sm leading-7 font-script ${
            isStage
              ? "text-center italic text-zinc-500"
              : block.lyric
              ? "text-center uppercase text-zinc-800"
              : "text-left text-zinc-800"
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
              const hideChar = !!(
                prev &&
                prev.type === "dialogue" &&
                block.type === "dialogue" &&
                block.characterIds.length > 0 &&
                prev.lyric !== block.lyric &&
                _sameCharacters(prev.characterIds, block.characterIds)
              );
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
                  : renderBlock(item.block, item.hideChar)
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

  const isDirty = (b: Block): boolean => {
    const s = syncedMap.get(b.id);
    if (!s) return true;
    return (
      b.content !== s.content ||
      b.type !== s.type ||
      b.lyric !== s.lyric ||
      b.rehearsalMark !== s.rehearsalMark ||
      b.sceneId !== s.sceneId ||
      b.characterIds.length !== s.characterIds.length ||
      b.characterIds.some((id, i) => id !== s.characterIds[i]) ||
      b.characterIds.some((id) => (b.characterAnnotations[id] ?? "") !== (s.characterAnnotations[id] ?? ""))
    );
  };

  // Server ordering is authoritative; preserve locally-dirty blocks' content
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
  onFocus,
  onToggleType,
  onToggleLyric,
  onArrowUpFromChar,
  onArrowDownFromChar,
  onArrowUpFromTextarea,
  onArrowDownFromTextarea,
  onSceneChange,
  onMarkChange,
  isMarkStart,
  commentCount,
  onCommentClick,
  index = 0,
  lineNum,
  isSearchHighlight,
  showRehearsalMark = true,
  stageDelimOpen = "（",
  stageDelimClose = "）",
  canEditText = false,
  canEditMetadata = false,
  canEditRehearsalMark = false,
  tagGroups,
  blockTagValues,
  showBlockTags = false,
  hasLyricConfig = false,
  onTagChange,
  onTagCopyClick,
  onTagPasteClick,
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
  onFocus: () => void;
  onToggleType: () => void;
  onToggleLyric: () => void;
  onArrowUpFromChar: () => void;
  onArrowDownFromChar: () => void;
  onArrowUpFromTextarea: () => void;
  onArrowDownFromTextarea: () => void;
  onSceneChange: (sceneId: string | null) => void;
  onMarkChange: (mark: string | null) => void;
  isMarkStart: boolean;
  commentCount: number;
  onCommentClick: () => void;
  index?: number;
  lineNum?: number;
  isSearchHighlight?: "match" | "focused";
  showRehearsalMark?: boolean;
  stageDelimOpen?: string;
  stageDelimClose?: string;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
  tagGroups?: TagGroup[];
  blockTagValues?: BlockTagValue[];
  showBlockTags?: boolean;
  hasLyricConfig?: boolean;
  onTagChange?: (groupId: string, optionId: string | null, value: number | null, del: boolean) => void;
  onTagCopyClick?: () => void;
  onTagPasteClick?: () => void;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const localContentRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const [charSelectorOpen, setCharSelectorOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      divRef.current = el;
      onRegisterRef(block.id, el);
    },
    [block.id, onRegisterRef]
  );

  // Sync state → DOM only for external changes (split, merge, type toggle, etc.)
  useLayoutEffect(() => {
    const div = divRef.current;
    if (!div) return;
    if (block.content !== localContentRef.current) {
      localContentRef.current = block.content;
      div.innerHTML = mdToHtml(block.content);
      if (block.type !== "stage") applyInlineStageStyling(div, stageDelimOpen, stageDelimClose);
    }
  }, [block.content, block.type]);

  const syncContent = () => {
    let html = divRef.current?.innerHTML ?? "";
    if (html === "<br>") html = "";
    const md = htmlToMd(html);
    localContentRef.current = md;
    onUpdate({ content: md });
  };

  const applyInlineFormat = (tag: "b" | "u") => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    toggleInlineTag(sel.getRangeAt(0), tag);
    syncContent();
  };

  const handleInput = () => {
    if (composingRef.current) return;
    const div = divRef.current;
    if (!div) return;
    if (block.type !== "stage") applyInlineStageStyling(div, stageDelimOpen, stageDelimClose);
    syncContent();
  };

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = () => { composingRef.current = false; syncContent(); };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const div = divRef.current!;

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        const sel = window.getSelection();
        if (block.type !== "stage" && sel && !sel.isCollapsed && div.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0);
          const frag = range.extractContents();
          const span = document.createElement("span");
          span.setAttribute("data-stage-inline", "");
          span.style.fontStyle = "italic";
          span.style.color = "#a1a1aa";
          span.appendChild(document.createTextNode("("));
          span.appendChild(frag);
          span.appendChild(document.createTextNode(")"));
          range.insertNode(span);
          const after = document.createRange();
          after.setStartAfter(span);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
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
      onMerge();
    }
  };

  const isStage = block.type === "stage";

  const firstEditor = presenceEditors[0];

  const searchRingClass =
    isSearchHighlight === "focused" ? "ring-2 ring-inset ring-amber-400" :
    isSearchHighlight === "match"   ? "ring-1 ring-inset ring-amber-200" : "";

  return (
    <div
      className={`group relative px-6 py-0 text-center transition-colors ${searchRingClass} ${
        isFocused ? "bg-zinc-100/70" : (index ?? 0) % 2 === 1 ? "bg-zinc-50/60" : ""
      }`}
    >
      {/* Line number — shown in left padding, subtle */}
      {lineNum !== undefined && (
        <span className="pointer-events-none absolute left-1 top-[3px] select-none tabular-nums text-[9px] leading-none text-zinc-400 group-hover:text-zinc-600 transition-colors">
          {lineNum}
        </span>
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

      {/* Rehearsal mark — top left, visible at the start of a new mark section; hover to edit */}
      {canEditRehearsalMark && (
        <div className={`absolute left-2 top-1 transition-opacity ${isMarkStart && block.rehearsalMark && showRehearsalMark ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <RehearsalMarkInput
            mark={block.rehearsalMark}
            onChange={onMarkChange}
          />
        </div>
      )}

      {/* Right-side action buttons — flex row, no overlap */}
      <div className={`absolute right-2 top-1 flex items-center transition-opacity ${charSelectorOpen ? "opacity-0 pointer-events-none" : ""}`}>
        {canEditText && !isStage && !hasLyricConfig && (
          <button
            onClick={onToggleLyric}
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
            />
          </div>
        )}
        {canEditText && (
          <button
            onClick={onToggleType}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-200 opacity-0 transition-opacity hover:text-zinc-400 group-hover:opacity-100"
          >
            {isStage ? "台词" : "舞台"}
          </button>
        )}
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

      {!isStage && (!hideCharSelector || isFocused) && (
        <BlockCharacterSelector
          block={block}
          characters={characters}
          onChange={(ids) => onUpdate({ characterIds: ids })}
          onAnnotationChange={(charId, ann) => onUpdate({ characterAnnotations: { ...block.characterAnnotations, [charId]: ann } })}
          onEditingChange={setCharSelectorOpen}
          editRequestToken={charEditToken}
          onArrowUp={onArrowUpFromChar}
          onArrowDown={onArrowDownFromChar}
          readOnly={!canEditText}
        />
      )}

      <div
        ref={refCallback}
        contentEditable={canEditText}
        suppressContentEditableWarning
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onPaste={(e) => {
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
        className={`w-full min-h-[1.75rem] outline-none text-base leading-7 break-words font-script ${
          isStage ? "italic text-zinc-400 text-center" :
          block.lyric ? "text-zinc-700 text-center uppercase" :
          "text-zinc-700 text-left"
        }`}
      />

      {showBlockTags && !isStage && !!tagGroups?.length && (
        <div className="relative mt-0.5 pb-1">
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
                  onClick={() => setTagPickerOpen(v => !v)}
                  className={`cursor-pointer rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity select-none ${isDefault ? "opacity-35" : ""}`}
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

// ─── InsertZone ───────────────────────────────────────────────────────────────

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

function BodyWithMentions({ body, mentions }: { body: string; mentions: Mention[] }) {
  if (!mentions.length)
    return <p className="whitespace-pre-wrap break-words text-sm text-zinc-600">{body}</p>;
  const escaped = mentions.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`@(${escaped.join("|")})`, "g");
  const parts: React.ReactNode[] = [];
  let last = 0; let key = 0; let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<span key={key++} className="font-medium text-blue-500">@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <p className="whitespace-pre-wrap break-words text-sm text-zinc-600">{parts}</p>;
}

function MentionTextarea({
  value, onChange, mentions, onMentionsChange, members,
  placeholder, rows, className, onKeyDown, autoFocus,
}: {
  value: string; onChange: (v: string) => void;
  mentions: Mention[]; onMentionsChange: (m: Mention[]) => void;
  members: Mention[]; placeholder?: string; rows?: number;
  className?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [drop, setDrop] = useState<{ active: boolean; atPos: number; filter: string; idx: number }>(
    { active: false, atPos: 0, filter: "", idx: 0 },
  );
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});

  const filtered = useMemo<Mention[]>(() => {
    if (!drop.active) return [];
    const f = drop.filter;
    if (!f) return members.slice(0, 6);
    return members.filter(m =>
      m.name.includes(f) || pinyinMatch(m.name, f.toLowerCase()) != null
    ).slice(0, 6);
  }, [drop.active, drop.filter, members]);

  const computeDropStyle = useCallback((): React.CSSProperties => {
    const ta = taRef.current;
    if (!ta) return {};
    const rect = ta.getBoundingClientRect();
    return {
      position: "fixed",
      left: rect.left,
      width: rect.width,
      bottom: window.innerHeight - rect.top + 4,
      maxHeight: Math.min(220, rect.top - 8),
      overflowY: "auto",
      zIndex: 9999,
    };
  }, []);

  const pickMember = useCallback((m: Mention) => {
    const ta = taRef.current; if (!ta) return;
    const before = value.slice(0, drop.atPos);
    const after = value.slice(drop.atPos + 1 + drop.filter.length);
    const next = `${before}@${m.name} ${after}`;
    onChange(next);
    onMentionsChange([...mentions.filter(x => x.openId !== m.openId), m]);
    setDrop(d => ({ ...d, active: false }));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = before.length + 1 + m.name.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }, [value, drop, onChange, onMentionsChange, mentions]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cur = e.target.selectionStart ?? val.length;
    onChange(val);
    const match = val.slice(0, cur).match(/@([^\s@]*)$/);
    if (match) {
      setDropStyle(computeDropStyle());
      setDrop({ active: true, atPos: cur - match[0].length, filter: match[1], idx: 0 });
    } else {
      setDrop(d => d.active ? { ...d, active: false } : d);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (drop.active && filtered.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setDrop(d => ({ ...d, idx: Math.min(d.idx + 1, filtered.length - 1) })); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setDrop(d => ({ ...d, idx: Math.max(d.idx - 1, 0) })); return; }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pickMember(filtered[drop.idx]); return; }
      if (e.key === "Escape") { setDrop(d => ({ ...d, active: false })); return; }
    }
    onKeyDown?.(e);
  };

  return (
    <>
      <textarea ref={taRef} value={value} onChange={handleChange} onKeyDown={handleKeyDown}
        placeholder={placeholder} rows={rows} autoFocus={autoFocus} className={className} />
      {drop.active && filtered.length > 0 && createPortal(
        <div style={dropStyle} className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg">
          {filtered.map((m, i) => (
            <button key={m.openId} type="button"
              onMouseDown={e => { e.preventDefault(); pickMember(m); }}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${i === drop.idx ? "bg-zinc-100 text-zinc-800" : "text-zinc-700 hover:bg-zinc-50"}`}
            >{m.name}</button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── CommentsPanel ────────────────────────────────────────────────────────────

function CommentsPanel({
  blockId, productionId, comments, currentOpenId, isAdmin,
  onAdd, onEdit, onDelete, onClose,
}: {
  blockId: string; productionId: string; comments: Comment[];
  currentOpenId: string; isAdmin: boolean;
  onAdd: (c: Comment) => void; onEdit: (c: Comment) => void;
  onDelete: (id: string) => void; onClose: () => void;
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

  const submitNew = async () => {
    const text = newText.trim(); if (!text) return;
    const c = await postComment({ text, mentions: newMentions });
    if (c) { onAdd(c); setNewText(""); setNewMentions([]); }
  };

  const submitReply = async () => {
    const text = replyText.trim(); if (!text || !replyingTo) return;
    const c = await postComment({ parentId: replyingTo, text, mentions: replyMentions });
    if (c) { onAdd(c); setReplyText(""); setReplyMentions([]); setReplyingTo(null); }
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
        <BodyWithMentions body={c.body} mentions={c.mentions} />
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
              </div>
            ))}

            {/* Reply compose */}
            {replyingTo === topC.id && (
              <div className="mt-2 ml-3 border-l-2 border-zinc-200 pl-3">
                <MentionTextarea value={replyText} onChange={setReplyText}
                  mentions={replyMentions} onMentionsChange={setReplyMentions}
                  members={members} placeholder="回复… (⌘↵ 发布)" rows={2} autoFocus
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitReply(); }}
                  className={taClass} />
                <div className="mt-1 flex justify-end gap-2">
                  <button onClick={() => setReplyingTo(null)} className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-600">取消</button>
                  <button onClick={submitReply} disabled={!replyText.trim() || submitting}
                    className="rounded bg-zinc-800 px-3 py-1 text-xs text-white hover:bg-zinc-700 disabled:opacity-40">
                    {submitting ? "…" : "回复"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-zinc-100 px-4 py-3">
        <MentionTextarea value={newText} onChange={setNewText}
          mentions={newMentions} onMentionsChange={setNewMentions}
          members={members} placeholder="添加评论… (⌘↵ 发布)" rows={3}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitNew(); }}
          className="w-full resize-none rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-400" />
        <div className="mt-2 flex justify-end">
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
  canEditText = true,
  canEditMetadata = true,
  canEditRehearsalMark = true,
  canImport = false,
}: {
  scriptId?: string;
  productionId?: string;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
  canImport?: boolean;
}) {
  const canEdit = canEditText || canEditMetadata || canEditRehearsalMark;
  const effectiveScriptId = productionId ?? scriptId;
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([makeBlock()]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const [charEditTokens, setCharEditTokens] = useState<Record<string, number>>({});

  // ── Block tags ───────────────────────────────────────────────────────────────
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [blockTagMap, setBlockTagMap] = useState<Map<string, BlockTagValue[]>>(new Map());
  const blockTagMapRef = useRef<Map<string, BlockTagValue[]>>(new Map());
  const tagClipboardRef = useRef<BlockTagValue[] | null>(null);

  // ── Script config (page layout, stage delimiters) ─────────────────────────
  const [scriptConfig, setScriptConfig] = useState<ScriptConfig>(DEFAULT_SCRIPT_CONFIG);
  const [aboutOpen, setAboutOpen] = useState(false);

  const saveScriptConfig = useCallback(async (patch: Partial<ScriptConfig>) => {
    const next = { ...scriptConfig, ...patch };
    setScriptConfig(next);
    await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
  }, [scriptConfig, effectiveScriptId]);

  // ── Page map (computed client-side, deterministic) ──────────────────────────
  const pageMap = useMemo(() => computePageMap(blocks, scriptConfig.pageLayout), [blocks, scriptConfig.pageLayout]);

  // ── Search ──────────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExact, setSearchExact] = useState(false);
  const [searchCurrentPage, setSearchCurrentPage] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  // ── Jump (line / page) ──────────────────────────────────────────────────────
  const [jumpTarget, setJumpTarget] = useState<"line" | "page" | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  // ── Toolbar dropdowns — single state enforces mutual exclusion ───────────────
  type OpenMenu = "script" | "edit" | "display" | "export" | "scene" | "char" | null;
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const toggleMenu = useCallback((name: Exclude<OpenMenu, null>) =>
    setOpenMenu(prev => prev === name ? null : name), []);

  // ── Display settings (cookie-persisted) ──────────────────────────────────────
  const [display, setDisplay] = useState<DisplaySettings>(readDisplayCookie);
  const toggleDisplay = useCallback((key: keyof DisplaySettings) => {
    setDisplay(prev => {
      const next = { ...prev, [key]: !prev[key] };
      writeDisplayCookie(next);
      return next;
    });
  }, []);

  const taRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFocus = useRef<{ id: string; textOffset?: number; atEnd?: boolean } | null>(null);
  const pendingCharOpen = useRef<string | null>(null);
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  useEffect(() => { blockTagMapRef.current = blockTagMap; }, [blockTagMap]);

  // ── Virtual scroll ────────────────────────────────────────────────────────────
  const VSCROLL_BUFFER = 80;
  const DEFAULT_BLOCK_H = 80;
  const blocksContainerRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const cumulativeHRef = useRef<number[]>([0]); // indexed 0..blocks.length
  const [windowRange, setWindowRange] = useState(() => ({ start: 0, end: Math.min(200, blocks.length) }));
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });
  // Pending navigation: set before windowRange update, consumed by useLayoutEffect after DOM commit
  const pendingNavigateRef = useRef<
    { kind: 'block'; id: string; align: ScrollLogicalPosition } | { kind: 'scene'; id: string } | null
  >(null);

  // Rebuild cumulative heights from cache
  const rebuildCumulative = useCallback(() => {
    const bl = blocksRef.current;
    const arr = new Array(bl.length + 1);
    arr[0] = 0;
    for (let i = 0; i < bl.length; i++) {
      arr[i + 1] = arr[i] + (measuredHeightsRef.current.get(bl[i].id) ?? DEFAULT_BLOCK_H);
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

    setWindowRange(prev =>
      prev.start === newStart && prev.end === newEnd ? prev : { start: newStart, end: newEnd }
    );
  }, []);

  // Scroll listener
  useEffect(() => {
    let rafId = 0;
    const onScroll = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(recomputeWindow); };
    window.addEventListener('scroll', onScroll, { passive: true });
    recomputeWindow();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(rafId); };
  }, [recomputeWindow]);

  // Clamp window when blocks list length changes (insert/delete)
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWindowRange(prev => ({
      start: Math.min(prev.start, Math.max(0, blocks.length - 1)),
      end: Math.min(prev.end, blocks.length),
    }));
  }, [blocks.length]);

  // Measure rendered block heights after each render pass
  useEffect(() => {
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
    if (changed) { rebuildCumulative(); recomputeWindow(); }
  });

  // After each window-changing render, execute any pending navigation (fires before paint)
  useLayoutEffect(() => {
    const nav = pendingNavigateRef.current;
    if (!nav) return;
    const el = nav.kind === 'block'
      ? document.getElementById(`block-${nav.id}`)
      : document.getElementById(`scene-block-${nav.id}`);
    if (!el) return;
    pendingNavigateRef.current = null;
    el.scrollIntoView({ behavior: 'instant', block: nav.kind === 'block' ? nav.align : 'start' });
  }, [windowRange]);

  // Update spacer heights from cumulative cache after each render (safe: layoutEffect, not render)
  useLayoutEffect(() => {
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const top = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total = cum[n] ?? n * DEFAULT_BLOCK_H;
    const bot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
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
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocksRef.current.length, idx + VSCROLL_BUFFER + 1),
    });
  }, []);

  const scrollToScene = useCallback((sceneId: string) => {
    const existing = document.getElementById(`scene-block-${sceneId}`);
    if (existing) { existing.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const idx = blocksRef.current.findIndex(b => b.sceneId === sceneId);
    if (idx < 0) return;
    pendingNavigateRef.current = { kind: 'scene', id: sceneId };
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocksRef.current.length, idx + VSCROLL_BUFFER + 1),
    });
  }, []);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);

  // ── Server sync ─────────────────────────────────────────────────────────────

  const syncedStateRef = useRef<ScriptState | null>(null);
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
        if (!patch.blockOps.length && !patch.charOps.length && !patch.sceneOps.length) return;
        const res = await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          const body = await res.json() as { ok: boolean; serverSeq: number };
          serverSeqRef.current = body.serverSeq;
          syncedStateRef.current = curr;
        }
      } catch {
        // Sync failure is non-fatal — will retry on next state change.
      } finally {
        isSyncingRef.current = false;
      }
    };
  }, [effectiveScriptId]);

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

    const loadUrl = productionId
      ? `${BASE_PATH}/api/production/${productionId}`
      : `${BASE_PATH}/api/script/${effectiveScriptId}`;

    fetch(loadUrl)
      .then(async (r) => {
        const body = await r.json();
        if (r.status === 404) { setLoadState("not-found"); return; }
        if (!r.ok) { setLoadError(body.error ?? "加载失败"); setLoadState("error"); return; }

        const state = body as ScriptState;
        if (state.blocks.length > 0) {
          setBlocks(state.blocks);
          setCharacters(state.characters);
          setScenes(state.scenes);
          syncedStateRef.current = state;
        }
        if (state.config) setScriptConfig({ ...DEFAULT_SCRIPT_CONFIG, ...state.config });
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
            }
          }).catch(() => {});
        }
      })
      .catch(() => { setLoadError("网络错误，请稍后重试"); setLoadState("error"); });
  }, [effectiveScriptId, productionId]);

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
  const lastSentPresenceRef = useRef<string | null | undefined>(undefined);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE: receive seq pushes (state sync) and presence pushes from other clients
  useEffect(() => {
    if (loadState !== "ready") return;

    const es = new EventSource(
      `${BASE_PATH}/api/script/${effectiveScriptId}/stream${clientId ? `?cid=${encodeURIComponent(clientId)}` : ""}`
    );
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    es.onmessage = (e: MessageEvent) => {
      const { seq } = JSON.parse(e.data as string) as { seq: number };
      if (seq <= serverSeqRef.current) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const r = await fetch(`${BASE_PATH}/api/script/${effectiveScriptId}`);
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

    es.addEventListener("presence", (e: MessageEvent) => {
      const list = JSON.parse(e.data as string) as RemotePresence[];
      setPresenceMap(new Map(list.map(p => [p.clientId, p])));
    });

    es.addEventListener("config", (e: MessageEvent) => {
      const cfg = JSON.parse(e.data as string) as ScriptConfig;
      setScriptConfig(prev => ({ ...DEFAULT_SCRIPT_CONFIG, ...prev, ...cfg }));
    });

    return () => {
      es.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [effectiveScriptId, loadState, clientId]);

  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
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
    if (lastSentPresenceRef.current === blockId) return;
    lastSentPresenceRef.current = blockId;
    if (presenceTimerRef.current) clearTimeout(presenceTimerRef.current);
    presenceTimerRef.current = setTimeout(() => {
      fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, userName, blockId }),
      }).catch(() => {});
    }, 200);
  }, [clientId, effectiveScriptId, userName]);

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
  }, [blocks, characters, scenes]);

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
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    // Walk up to the contenteditable container
    let node: Node | null = range.commonAncestorContainer;
    let editableEl: HTMLElement | null = null;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).isContentEditable) {
        editableEl = node as HTMLElement;
        break;
      }
      node = node.parentNode;
    }
    if (!editableEl) return;
    // End typing session so startTypingSession (called by updateBlock via input event)
    // saves a fresh pre-format snapshot rather than lumping with active typing.
    isTypingSession.current = false;
    toggleInlineTag(range, tag);
    // Re-focus then fire input so ScriptBlock's handleInput → syncContent runs
    editableEl.focus();
    editableEl.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);

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
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = undoStack.current.pop();
    if (!snapshot) return;
    redoStack.current.push(blocksRef.current);
    setBlocks(snapshot);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, []);

  const redo = useCallback(() => {
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    isTypingSession.current = false;
    const snapshot = redoStack.current.pop();
    if (!snapshot) return;
    undoStack.current.push(blocksRef.current);
    setBlocks(snapshot);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  // ── Tag handlers ─────────────────────────────────────────────────────────────

  const upsertBlockTagApi = useCallback((blockId: string, groupId: string, optionId: string | null, value: number | null, del: boolean) => {
    fetch(`${BASE_PATH}/api/script/${effectiveScriptId}/block-tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(del ? { blockId, groupId, delete: true } : { blockId, groupId, optionId, value }),
    }).catch(() => {});
  }, [effectiveScriptId]);

  const handleTagChange = useCallback((blockId: string, groupId: string, optionId: string | null, value: number | null, del: boolean) => {
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
    upsertBlockTagApi(blockId, groupId, optionId, value, del);
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
  }, [upsertBlockTagApi, blockTagMapRef, tagGroups]);

  const handleTagCopy = useCallback((blockId: string) => {
    tagClipboardRef.current = blockTagMapRef.current.get(blockId) ?? [];
  }, []);

  const handleTagPaste = useCallback((blockId: string) => {
    const clipboard = tagClipboardRef.current;
    if (!clipboard?.length) return;
    const inherited = clipboard.map(t => ({ ...t, blockId }));
    setBlockTagMap(prev => { const m = new Map(prev); m.set(blockId, inherited); return m; });
    inherited.forEach(t => upsertBlockTagApi(blockId, t.groupId, t.optionId, t.value, false));
  }, [upsertBlockTagApi]);

  const inheritTags = useCallback((fromId: string, toId: string) => {
    const sourceTags = blockTagMapRef.current.get(fromId) ?? [];
    if (!sourceTags.length) return;
    const inherited = sourceTags.map(t => ({ ...t, blockId: toId }));
    setBlockTagMap(prev => { const m = new Map(prev); m.set(toId, inherited); return m; });
    inherited.forEach(t => upsertBlockTagApi(toId, t.groupId, t.optionId, t.value, false));
  }, [upsertBlockTagApi]);

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
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      b.id === id
        ? { ...b, type: b.type === "dialogue" ? "stage" : "dialogue", characterIds: [] }
        : b
    ));
  }, [saveSnapshot]);

  const toggleBlockLyric = useCallback((id: string) => {
    saveSnapshot();
    setBlocks((prev) => prev.map((b) =>
      b.id === id ? { ...b, lyric: !b.lyric } : b
    ));
  }, [saveSnapshot]);

  // Apply pending focus on every render until resolved
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pf = pendingFocus.current;
    if (pf) {
      const el = taRefs.current.get(pf.id);
      if (el) {
        el.focus();
        if (pf.atEnd) setCursorAtEnd(el);
        else if (pf.textOffset !== undefined) setCursorAtTextOffset(el, pf.textOffset);
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
      startTypingSession();
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
    },
    [startTypingSession]
  );

  // Cascade a scene boundary change, preserving monotonic scene order.
  // null is treated as order -1 (before all named scenes).
  // Moving to a later scene  → cascade the tail of the current run forward.
  // Moving to an earlier scene → cascade the head of the current run backward.
  const updateBlockScene = useCallback((id: string, newSceneId: string | null) => {
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
  }, [saveSnapshot, scenes]);

  // Same cascade logic for rehearsal marks.
  const updateBlockMark = useCallback((id: string, newMark: string | null) => {
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
  }, [saveSnapshot]);

  const splitBlock = useCallback((id: string, before: string, after: string) => {
    saveSnapshot();
    let nextId: string | null = null;
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === -1) return prev;
      const cur = prev[idx];
      // New block inherits scene and rehearsal mark from the block being split
      const next: Block = {
        ...makeBlock(after, []),
        sceneId: cur.sceneId,
        rehearsalMark: cur.rehearsalMark,
      };
      nextId = next.id;
      const updated = [...prev];
      updated[idx] = { ...cur, content: before };
      updated.splice(idx + 1, 0, next);
      pendingCharOpen.current = next.id;
      return updated;
    });
    if (nextId) inheritTags(id, nextId);
  }, [saveSnapshot, inheritTags]);

  const mergeBlock = useCallback((id: string) => {
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
      const merged = { ...p, content: p.content + c.content };
      const updated = [...prev];
      updated[idx - 1] = merged;
      updated.splice(idx, 1);
      pendingFocus.current = { id: p.id, textOffset: getTextLength(mdToHtml(p.content)) };
      return updated;
    });
  }, [saveSnapshot]);

  const insertBlockAt = useCallback((index: number) => {
    saveSnapshot();
    let newId: string | null = null;
    let refId: string | null = null;
    setBlocks((prev) => {
      // Inherit scene and rehearsal mark from the block immediately before the insertion point
      const ref = index > 0 ? prev[index - 1] : null;
      const newBlock: Block = {
        ...makeBlock(),
        sceneId: ref?.sceneId ?? null,
        rehearsalMark: ref?.rehearsalMark ?? null,
      };
      newId = newBlock.id;
      refId = ref?.id ?? null;
      const updated = [...prev];
      updated.splice(index, 0, newBlock);
      pendingCharOpen.current = newBlock.id;
      return updated;
    });
    if (newId && refId) inheritTags(refId, newId);
  }, [saveSnapshot, inheritTags]);

  const addChar = (name: string) => {
    setCharacters((prev) => [...prev, { id: uid(), name, isAggregate: false }]);
  };

  const removeChar = (charId: string) => {
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    setBlocks((prev) =>
      prev.map((b) => {
        const { [charId]: _, ...restAnnotations } = b.characterAnnotations;
        return { ...b, characterIds: b.characterIds.filter((id) => id !== charId), characterAnnotations: restAnnotations };
      })
    );
  };

  const renameChar = (charId: string, name: string) =>
    setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? { ...c, name } : c))
    );

  const addScene = (parentId?: string) => {
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
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, number, name } : s)));
  };

  const removeScene = (id: string) => {
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

  return (
    <div className="min-h-screen bg-zinc-100">
      {/* Toolbar */}
      <header className="sticky top-0 z-20 border-b border-zinc-100 bg-white shadow-sm">
        <div className="mx-auto flex h-14 max-w-3xl flex-wrap items-center gap-3 px-6">
          <Link
            href={productionId ? `/production/${productionId}` : "/"}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回
          </Link>
          <div className="h-4 w-px shrink-0 bg-zinc-100" />

          {/* 剧本▼ — 关于 + 元数据设置 */}
          <div className="relative">
            <button
              onClick={() => toggleMenu("script")}
              className="flex items-center gap-0.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              剧本 <Chevron />
            </button>
            {openMenu === "script" && (
              <div
                className="absolute left-0 top-full z-30 mt-1 w-52 rounded-xl border border-zinc-100 bg-white py-1 shadow-md"
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
          {!canEdit && (
            <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-400">
              只读
            </span>
          )}
          {canEditMetadata && (
            <>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <ScenePanel
                scenes={scenes}
                productionId={productionId ?? ""}
                onAdd={(parentId) => addScene(parentId)}
                onUpdate={updateScene}
                onRemove={removeScene}
                open={openMenu === "scene"}
                onOpenChange={(v) => setOpenMenu(v ? "scene" : null)}
                canImport={canImport}
              />
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <CharacterPanel
                characters={characters}
                productionId={productionId ?? ""}
                onAdd={addChar}
                onRemove={removeChar}
                onRename={renameChar}
                open={openMenu === "char"}
                onOpenChange={(v) => setOpenMenu(v ? "char" : null)}
              />
            </>
          )}
          <div className="h-4 w-px shrink-0 bg-zinc-100" />

          {/* 编辑▼ — undo/redo + 格式 + 搜索/跳转 */}
          <div className="relative">
            <button
              onClick={() => toggleMenu("edit")}
              className="flex items-center gap-0.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              编辑 <Chevron />
            </button>
            {openMenu === "edit" && (
              <div
                className="absolute left-0 top-full z-30 mt-1 w-44 rounded-xl border border-zinc-100 bg-white py-1 shadow-md"
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
                      onMouseDown={e => { e.preventDefault(); if (focusedId) toggleBlockType(focusedId); }}
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
          <div className="relative">
            <button
              onClick={() => toggleMenu("display")}
              className="flex items-center gap-0.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              显示 <Chevron />
            </button>
            {openMenu === "display" && (
              <div
                className="absolute left-0 top-full z-30 mt-1 w-44 rounded-xl border border-zinc-100 bg-white py-1 shadow-md"
                onMouseLeave={() => setOpenMenu(null)}
              >
                {(
                  [
                    ["pageBreaks",     "分页线"],
                    ["lineNumbers",    "行号"],
                    ["rehearsalMarks", "排练记号"],
                    ["blockTags",      "Block 标签"],
                  ] as [keyof DisplaySettings, string][]
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
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Online users: self (dimmed) + others */}
            <div className="flex items-center">
              {(() => {
                const others = Array.from(presenceMap.values()).filter(p => p.clientId !== clientId);
                return (
                  <>
                    {others.map(p => (
                      <div key={p.clientId} className="-ml-1 first:ml-0">
                        <PresenceAvatar name={p.userName} color={p.color} title={p.userName} />
                      </div>
                    ))}
                    {clientId && (
                      <div className="-ml-1 first:ml-0 opacity-40" title={`${userName}（你）`}>
                        <PresenceAvatar name={userName || "?"} color={presenceColor(clientId)} />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* 导出▼ */}
            <div className="relative">
              <button
                onClick={() => toggleMenu("export")}
                className="flex items-center gap-0.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
              >
                导出 <Chevron />
              </button>
              {openMenu === "export" && (
                <div
                  className="absolute right-0 top-full z-30 mt-1 w-36 rounded-xl border border-zinc-100 bg-white py-1 shadow-md"
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

      {/* Document */}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="min-h-[70vh] rounded-2xl bg-white shadow-sm flex flex-col pt-6 pb-8">
          <TableOfContents scenes={scenes} blocks={blocks} onScrollToScene={scrollToScene} />
          <div ref={blocksContainerRef}>
          {(() => {
            const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter(Boolean));

            // Pre-compute scene-header state for blocks before the visible window
            let lastRenderedActId: string | undefined = undefined;
            for (let pi = 0; pi < windowRange.start; pi++) {
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

            return [
              <div key="__vtop" style={{ height: spacerH.top }} aria-hidden="true" />,
              ...blocks.slice(windowRange.start, windowRange.end).flatMap((block, wIdx) => {
            const bIdx = windowRange.start + wIdx;
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

            const hideCharSelector = !!(
              prev &&
              prev.type === "dialogue" &&
              block.type === "dialogue" &&
              block.characterIds.length > 0 &&
              prev.lyric !== block.lyric &&
              _sameCharacters(prev.characterIds, block.characterIds)
            );
            const sceneStart = block.sceneId !== null && block.sceneId !== prev?.sceneId;
            const isMarkStart = block.rehearsalMark !== (prev?.rehearsalMark ?? null);
            const pageBreak = bIdx > 0 && pageMap[block.id] !== pageMap[prev!.id];
            const matchOrder = searchMatches.indexOf(bIdx);
            const searchHighlight: "focused" | "match" | undefined =
              matchOrder === searchIdx ? "focused" : matchOrder >= 0 ? "match" : undefined;

            const blockEl = (
              <div
                key={block.id}
                id={`block-${block.id}`}
                data-bwrap={block.id}
                data-scene-anchor={sceneStart ? block.sceneId : undefined}
                className={`min-w-0 scroll-mt-20`}
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
                  stageDelimOpen={scriptConfig.stageDelimOpen}
                  stageDelimClose={scriptConfig.stageDelimClose}
                  characters={characters}
                  scenes={scenes}
                  availableScenes={availableScenes}
                  hideCharSelector={hideCharSelector}
                  isFocused={focusedId === block.id}
                  charEditToken={charEditTokens[block.id] ?? 0}
                  presenceEditors={Array.from(presenceMap.values()).filter(
                    p => p.blockId === block.id && p.clientId !== clientId
                  )}
                  onRegisterRef={registerRef}
                  onUpdate={(changes) => updateBlock(block.id, changes)}
                  onSplit={(before, after) => splitBlock(block.id, before, after)}
                  onMerge={() => mergeBlock(block.id)}
                  onFocus={() => { setFocusedId(block.id); sendPresence(block.id); }}
                  onToggleType={() => toggleBlockType(block.id)}
                  onToggleLyric={() => toggleBlockLyric(block.id)}
                  onArrowUpFromChar={() => handleArrowUpFromChar(block.id)}
                  onArrowDownFromChar={() => handleArrowDownFromChar(block.id)}
                  onArrowUpFromTextarea={() => handleArrowUpFromTextarea(block.id)}
                  onArrowDownFromTextarea={() => handleArrowDownFromTextarea(block.id)}
                  onSceneChange={(id) => updateBlockScene(block.id, id)}
                  onMarkChange={(m) => updateBlockMark(block.id, m)}
                  isMarkStart={isMarkStart}
                  commentCount={comments.filter(c => c.contextId === block.id).length}
                  onCommentClick={() => setActiveCommentBlockId(block.id)}
                  canEditText={canEditText}
                  canEditMetadata={canEditMetadata}
                  canEditRehearsalMark={canEditRehearsalMark}
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
              ? [canEditText && <InsertZone key={`iz-${bIdx}`} onInsert={() => insertBlockAt(bIdx)} />, blockEl]
              : [blockEl];
              }),
              <div key="__vbot" style={{ height: spacerH.bot }} aria-hidden="true" />,
            ];
          })()}
          {canEditText && <InsertZone onInsert={() => insertBlockAt(blocks.length)} />}
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

      {activeCommentBlockId && productionId && (
        <CommentsPanel
          blockId={activeCommentBlockId}
          productionId={productionId}
          comments={comments}
          currentOpenId={meOpenId}
          isAdmin={meIsAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentBlockId(null)}
        />
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
                  ["Backspace", "合并到上一块（行首）"],
                  ["Tab", "切换台词 / 舞台提示"],
                  ["⌘⌥L", "切换歌词模式"],
                  ["⌘⇧C", "复制当前块标签"],
                  ["⌘⇧V", "粘贴标签到当前块"],
                ].map(([key, desc]) => (
                  <tr key={key}>
                    <td className="py-1.5 pr-4 font-mono text-[13px] text-zinc-400 whitespace-nowrap">{key}</td>
                    <td className="py-1.5 text-zinc-600">{desc}</td>
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
