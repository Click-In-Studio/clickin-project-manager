"use client";

import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, BlockType, Character, Scene, ScriptState } from "@/lib/script-types";
import { diffState } from "@/lib/script-ops";

let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;

const makeBlock = (content = "", characterIds: string[] = [], type: BlockType = "dialogue"): Block => ({
  id: uid(),
  type,
  content,
  characterIds,
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
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => `<b>${inner}</b>`);
  s = s.replace(/__([\s\S]+?)__/g, (_, inner) => `<u>${inner}</u>`);
  s = s.replace(/\n/g, "<br>");
  return s;
}

function applyInlineStageStyling(div: HTMLDivElement) {
  const sel = window.getSelection();
  let savedOffset: number | null = null;
  if (sel && sel.rangeCount && sel.isCollapsed && div.contains(sel.anchorNode)) {
    savedOffset = getTextBeforeCursor(div).length;
  }

  const isStageSpan = (el: Element) =>
    el.hasAttribute("data-stage-inline");

  const validStageText = (text: string) =>
    ((text.startsWith("(") && text.endsWith(")")) ||
     (text.startsWith("（") && text.endsWith("）"))) &&
    text.length >= 2;

  // Remove spans whose content no longer forms a valid () or （） pair
  div.querySelectorAll("span[data-stage-inline]").forEach((span) => {
    if (!validStageText(span.textContent ?? "")) {
      const parent = span.parentNode!;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  div.normalize();

  // Wrap new (...) / （...） patterns in text nodes outside existing spans
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

  const pairRegex = /\([^()（）\n]*\)|（[^()（）\n]*）/g;

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
}: {
  scenes: Scene[];
  blocks: Block[];
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
    document.getElementById(`scene-block-${sceneId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="px-8 pt-6 pb-5 border-b border-zinc-100">
      <p className="mb-3 text-[10px] font-bold tracking-widest text-zinc-300 uppercase">目录</p>
      <nav className="flex flex-col gap-0.5">
        {orderedScenes.map((scene) => (
          <button
            key={scene.id}
            onClick={() => scrollTo(scene.id)}
            className="flex items-baseline gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-zinc-50 group"
          >
            <span className="min-w-[3rem] text-xs font-bold tracking-wider text-zinc-300 group-hover:text-zinc-500">
              {scene.number || "—"}
            </span>
            <span className="text-sm text-zinc-400 group-hover:text-zinc-600">
              {scene.name || <span className="italic text-zinc-200">未命名</span>}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ─── ScenePanel ───────────────────────────────────────────────────────────────

function SceneRow({
  scene,
  onUpdate,
  onRemove,
}: {
  scene: Scene;
  onUpdate: (id: string, number: string, name: string) => void;
  onRemove: (id: string) => void;
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
      <td className="py-1 pr-2 align-middle">
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          className="w-14 rounded border border-transparent px-1 py-0.5 text-sm outline-none focus:border-zinc-300"
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
}: {
  scenes: Scene[];
  productionId: string;
  onAdd: () => void;
  onUpdate: (id: string, number: string, name: string) => void;
  onRemove: (id: string) => void;
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

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
      >
        章节 ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-zinc-100 bg-white shadow-xl flex flex-col" style={{ maxHeight: "min(28rem, calc(100vh - 8rem))" }}>
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">章节管理</span>
            <Link href={`/production/${productionId}/scenes`} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
              管理页 →
            </Link>
          </div>
          <div className="overflow-y-auto p-3">
            {scenes.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                    <th className="pb-1 pr-2 font-medium">编号</th>
                    <th className="pb-1 font-medium">名称</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s) => (
                    <SceneRow key={s.id} scene={s} onUpdate={onUpdate} onRemove={onRemove} />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mb-2 text-center text-xs text-zinc-300">暂无章节</p>
            )}
          </div>
          <div className="shrink-0 border-t border-zinc-100 p-3">
            <button
              onClick={onAdd}
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

function SceneHeader({ scene }: { scene: Scene }) {
  return (
    <div className="flex select-none items-center gap-3 px-8 py-3">
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold tracking-widest text-zinc-400">{scene.number}</span>
        {scene.name && <span className="text-sm text-zinc-500">{scene.name}</span>}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
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
}: {
  characters: Character[];
  productionId: string;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    setDraft("");
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
          open
            ? "bg-zinc-100 text-zinc-800"
            : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
        }`}
      >
        角色
        <span className="text-xs text-zinc-300">▾</span>
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
  editRequestToken,
  onArrowUp,
  onArrowDown,
  readOnly = false,
}: {
  block: Block;
  characters: Character[];
  onChange: (ids: string[]) => void;
  editRequestToken: number;
  onArrowUp: () => void;
  onArrowDown: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derived: open when token increments (React during-render setState pattern)
  const [lastSeenToken, setLastSeenToken] = useState(editRequestToken);
  if (lastSeenToken !== editRequestToken && editRequestToken > 0) {
    setLastSeenToken(editRequestToken);
    setEditing(true);
  }

  // Focus input whenever editing mode activates
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setEditing(false);
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

  const close = () => { setEditing(false); setQuery(""); setHighlightIdx(0); };

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

  if (!editing) {
    return (
      <div className="mb-2 flex justify-center">
        {readOnly ? (
          <span className={`text-sm font-bold tracking-[0.12em] ${selected.length ? "text-zinc-800" : "text-zinc-300"}`}>
            {selected.length ? selected.map((c) => c.name).join("、") : "无角色"}
          </span>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className={`text-sm font-bold tracking-[0.12em] transition-colors ${
              selected.length
                ? "text-zinc-800 hover:text-zinc-500"
                : "text-zinc-300 hover:text-zinc-400"
            }`}
          >
            {selected.length ? selected.map((c) => c.name).join("、") : "无角色"}
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
            >
              ×
            </button>
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
      </div>
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

type PageConfig = {
  width: number;
  height: number;
  marginX: number;
  marginTop: number;
  marginBottom: number;
  headerHeight: number;
  footerHeight: number;
};

const DEFAULT_PAGE_CONFIG: PageConfig = {
  width: 794,    // A4 at 96 dpi (210 mm)
  height: 1123,  // A4 at 96 dpi (297 mm)
  marginX: 75,
  marginTop: 90,
  marginBottom: 90,
  headerHeight: 28,
  footerHeight: 28,
};

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
            {sel.map((c) => c.name).join("、")}
          </div>
        )}
        <div
          className={`w-full break-words text-sm leading-7 ${
            isStage
              ? "text-center italic text-zinc-500"
              : block.lyric
              ? "text-center uppercase text-zinc-800"
              : "text-left font-kaiti text-zinc-800"
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

type Comment = {
  id: string;
  blockId: string;
  openId: string;
  authorName: string;
  content: string;
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
      b.characterIds.some((id, i) => id !== s.characterIds[i])
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

function _sameCharacters(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
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
  canEditText = false,
  canEditMetadata = false,
  canEditRehearsalMark = false,
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
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const localContentRef = useRef<string | null>(null);
  const composingRef = useRef(false);

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
      if (block.type !== "stage") applyInlineStageStyling(div);
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
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
    const existing = el?.closest(tag);
    if (existing) {
      existing.replaceWith(...Array.from(existing.childNodes));
    } else {
      const wrapper = document.createElement(tag);
      try { range.surroundContents(wrapper); }
      catch { wrapper.appendChild(range.extractContents()); range.insertNode(wrapper); }
    }
    syncContent();
  };

  const handleInput = () => {
    if (composingRef.current) return;
    const div = divRef.current;
    if (!div) return;
    if (block.type !== "stage") applyInlineStageStyling(div);
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

  return (
    <div
      className={`group relative px-6 py-0 text-center transition-colors ${
        isFocused ? "bg-zinc-50/60" : ""
      }`}
    >
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
        <div className={`absolute left-2 top-1 transition-opacity ${isMarkStart && block.rehearsalMark ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <RehearsalMarkInput
            mark={block.rehearsalMark}
            onChange={onMarkChange}
          />
        </div>
      )}

      {/* Right-side action buttons — flex row, no overlap */}
      <div className="absolute right-2 top-1 flex items-center">
        {canEditText && !isStage && (
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
          if (block.type !== "stage") applyInlineStageStyling(divRef.current!);
          syncContent();
        }}
        data-placeholder={isStage ? "舞台提示…" : "在此输入台词…"}
        className={`w-full min-h-[1.75rem] outline-none text-base leading-7 break-words ${
          isStage ? "italic text-zinc-400 text-center" :
          block.lyric ? "text-zinc-700 text-center uppercase" :
          "text-zinc-700 text-left font-kaiti"
        }`}
      />
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

// ─── CommentsPanel ────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function CommentsPanel({
  blockId,
  productionId,
  comments,
  currentOpenId,
  isAdmin,
  onAdd,
  onEdit,
  onDelete,
  onClose,
}: {
  blockId: string;
  productionId: string;
  comments: Comment[];
  currentOpenId: string;
  isAdmin: boolean;
  onAdd: (c: Comment) => void;
  onEdit: (c: Comment) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const blockComments = comments.filter(c => c.blockId === blockId);
  const [newText, setNewText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const submit = async () => {
    const text = newText.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, content: text }),
      });
      if (res.ok) { onAdd((await res.json()).comment); setNewText(""); }
    } finally { setSubmitting(false); }
  };

  const saveEdit = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (res.ok) { onEdit((await res.json()).comment); setEditingId(null); }
  };

  const doDelete = async (id: string) => {
    const res = await fetch(`${BASE_PATH}/api/script/${productionId}/comments/${id}`, { method: "DELETE" });
    if (res.ok) onDelete(id);
  };

  return (
    <div className="fixed right-0 top-14 bottom-0 z-30 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-700">评论</span>
        <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 text-lg leading-none">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {blockComments.length === 0 && (
          <p className="py-4 text-center text-xs text-zinc-300">暂无评论</p>
        )}
        {blockComments.map(c => (
          <div key={c.id} className="group">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-700">{c.authorName}</span>
              {editingId !== c.id && (
                <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                  {c.openId === currentOpenId && (
                    <button
                      onClick={() => { setEditingId(c.id); setEditText(c.content); }}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600"
                    >编辑</button>
                  )}
                  {(c.openId === currentOpenId || isAdmin) && (
                    <button
                      onClick={() => doDelete(c.id)}
                      className="text-[11px] text-zinc-400 hover:text-red-400"
                    >删除</button>
                  )}
                </div>
              )}
            </div>
            <p className="mb-1 text-[10px] text-zinc-300">{relativeTime(c.createdAt)}</p>
            {editingId === c.id ? (
              <div>
                <textarea
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  autoFocus
                  rows={3}
                  className="w-full resize-none rounded border border-zinc-200 px-2 py-1.5 text-sm text-zinc-700 outline-none focus:border-zinc-400"
                />
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => setEditingId(null)}
                    className="flex-1 rounded border border-zinc-200 py-1 text-xs text-zinc-500 hover:border-zinc-400"
                  >取消</button>
                  <button
                    onClick={() => saveEdit(c.id)}
                    className="flex-1 rounded bg-zinc-800 py-1 text-xs text-white hover:bg-zinc-700"
                  >保存</button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm text-zinc-600">{c.content}</p>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-zinc-100 px-4 py-3">
        <textarea
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="添加评论… (⌘↵ 发布)"
          rows={3}
          className="w-full resize-none rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-700 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={submit}
            disabled={!newText.trim() || submitting}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
          >{submitting ? "发布中…" : "发布"}</button>
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
}: {
  scriptId?: string;
  productionId?: string;
  canEditText?: boolean;
  canEditMetadata?: boolean;
  canEditRehearsalMark?: boolean;
}) {
  const canEdit = canEditText || canEditMetadata || canEditRehearsalMark;
  const effectiveScriptId = productionId ?? scriptId;
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([makeBlock()]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [charEditTokens, setCharEditTokens] = useState<Record<string, number>>({});

  const taRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingFocus = useRef<{ id: string; textOffset?: number; atEnd?: boolean } | null>(null);
  const pendingCharOpen = useRef<string | null>(null);
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);

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
    setLoadState("loading");
    setLoadError("");
    setBlocks([makeBlock()]);
    setCharacters([]);
    setScenes([]);
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
        setLoadState("ready");
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

    return () => {
      es.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [effectiveScriptId, loadState, clientId]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);

  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const curr: ScriptState = {
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

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [undo, redo]);

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
      const updated = [...prev];
      updated[idx] = { ...cur, content: before };
      updated.splice(idx + 1, 0, next);
      pendingCharOpen.current = next.id;
      return updated;
    });
  }, [saveSnapshot]);

  const mergeBlock = useCallback((id: string) => {
    saveSnapshot();
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx === 0) return prev;
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
    setBlocks((prev) => {
      // Inherit scene and rehearsal mark from the block immediately before the insertion point
      const ref = index > 0 ? prev[index - 1] : null;
      const newBlock: Block = {
        ...makeBlock(),
        sceneId: ref?.sceneId ?? null,
        rehearsalMark: ref?.rehearsalMark ?? null,
      };
      const updated = [...prev];
      updated.splice(index, 0, newBlock);
      pendingCharOpen.current = newBlock.id;
      return updated;
    });
  }, [saveSnapshot]);

  const addChar = (name: string) => {
    setCharacters((prev) => [...prev, { id: uid(), name }]);
  };

  const removeChar = (charId: string) => {
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    setBlocks((prev) =>
      prev.map((b) => ({
        ...b,
        characterIds: b.characterIds.filter((id) => id !== charId),
      }))
    );
  };

  const renameChar = (charId: string, name: string) =>
    setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? { ...c, name } : c))
    );

  const addScene = () => {
    setScenes((prev) => [...prev, { id: uid(), number: "", name: "" }]);
  };

  const updateScene = (id: string, number: string, name: string) => {
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, number, name } : s)));
  };

  const removeScene = (id: string) => {
    setScenes((prev) => prev.filter((s) => s.id !== id));
    setBlocks((prev) => prev.map((b) => (b.sceneId === id ? { ...b, sceneId: null } : b)));
  };

  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
  const [meOpenId, setMeOpenId] = useState("");
  const [meIsAdmin, setMeIsAdmin] = useState(false);

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
          <span className="shrink-0 text-xs font-bold tracking-widest text-zinc-300 uppercase">
            剧本
          </span>
          {!canEdit && (
            <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-400">
              只读
            </span>
          )}
          {canEdit && (
            <>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <button
                onClick={undo}
                disabled={!canUndo}
                title="撤销 ⌘Z"
                className={`rounded px-2 py-1 text-sm transition-colors ${canUndo ? "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800" : "cursor-not-allowed text-zinc-300"}`}
              >
                撤销
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="重做 ⌘⇧Z"
                className={`rounded px-2 py-1 text-sm transition-colors ${canRedo ? "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800" : "cursor-not-allowed text-zinc-300"}`}
              >
                重做
              </button>
            </>
          )}
          {canEditMetadata && (
            <>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <ScenePanel
                scenes={scenes}
                productionId={productionId ?? ""}
                onAdd={addScene}
                onUpdate={updateScene}
                onRemove={removeScene}
              />
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <CharacterPanel
                characters={characters}
                productionId={productionId ?? ""}
                onAdd={addChar}
                onRemove={removeChar}
                onRename={renameChar}
              />
            </>
          )}
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
                    {/* Self — always shown, slightly dimmed */}
                    {clientId && (
                      <div className="-ml-1 first:ml-0 opacity-40" title={`${userName}（你）`}>
                        <PresenceAvatar name={userName || "?"} color={presenceColor(clientId)} />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <button
              onClick={() => setPrintPreview(true)}
              className="rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              打印预览
            </button>
          </div>
        </div>
      </header>

      {/* Document */}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="min-h-[70vh] rounded-2xl bg-white shadow-sm flex flex-col pt-6 pb-8">
          <TableOfContents scenes={scenes} blocks={blocks} />
          {(() => {
            const usedSceneIds = new Set(blocks.map((b) => b.sceneId).filter(Boolean));
            return blocks.flatMap((block, bIdx) => {
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
            const blockEl = (
              <div
                key={block.id}
                id={sceneStart ? `scene-block-${block.sceneId}` : undefined}
                className={`min-w-0${sceneStart ? " scroll-mt-20" : ""}`}
              >
                {sceneStart && (() => {
                  const scene = scenes.find((s) => s.id === block.sceneId);
                  const currentIdx = scene ? scenes.findIndex((s) => s.id === block.sceneId) : -1;
                  const prevIdx = prev?.sceneId != null ? scenes.findIndex((s) => s.id === prev.sceneId) : -1;
                  const skipped = currentIdx > prevIdx + 1
                    ? scenes.slice(prevIdx + 1, currentIdx).filter((s) => !usedSceneIds.has(s.id))
                    : [];
                  return (
                    <>
                      {skipped.map((s) => (
                        <div key={`empty-${s.id}`} id={`scene-block-${s.id}`} className="scroll-mt-20">
                          <SceneHeader scene={s} />
                        </div>
                      ))}
                      {scene && <SceneHeader scene={scene} />}
                    </>
                  );
                })()}
                <ScriptBlock
                  block={block}
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
                  commentCount={comments.filter(c => c.blockId === block.id).length}
                  onCommentClick={() => setActiveCommentBlockId(block.id)}
                  canEditText={canEditText}
                  canEditMetadata={canEditMetadata}
                  canEditRehearsalMark={canEditRehearsalMark}
                />
              </div>
            );
            return bIdx > 0
              ? [canEditText && <InsertZone key={`iz-${bIdx}`} onInsert={() => insertBlockAt(bIdx)} />, blockEl]
              : [blockEl];
          });
          })()}
          {canEditText && <InsertZone onInsert={() => insertBlockAt(blocks.length)} />}
        </div>
        {canEditText && (
          <p className="mt-4 text-center text-xs text-zinc-300">
            Enter 新建块 · Shift+Enter 块内换行 · Backspace（行首）合并到上一块
          </p>
        )}
      </main>

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
    </div>
  );
}
