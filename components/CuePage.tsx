"use client";

import React, {
  useState, useRef, useCallback, useMemo, useEffect,
} from "react";
import { createPortal } from "react-dom";
import { match as pinyinMatch } from "pinyin-pro";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, Character, Scene } from "@/lib/script-types";
import type { CueList } from "@/lib/cue-list-types";
import type { Cue, CueAnchor } from "@/lib/cue-types";

// ─── Colours ──────────────────────────────────────────────────────────────────

const LIST_COLORS = [
  { bg: "bg-blue-500",    text: "text-blue-600",    line: "#3b82f6", light: "bg-blue-50"    },
  { bg: "bg-amber-500",   text: "text-amber-600",   line: "#f59e0b", light: "bg-amber-50"   },
  { bg: "bg-emerald-500", text: "text-emerald-600", line: "#10b981", light: "bg-emerald-50" },
  { bg: "bg-violet-500",  text: "text-violet-600",  line: "#8b5cf6", light: "bg-violet-50"  },
  { bg: "bg-rose-500",    text: "text-rose-600",    line: "#f43f5e", light: "bg-rose-50"    },
  { bg: "bg-cyan-500",    text: "text-cyan-600",    line: "#06b6d4", light: "bg-cyan-50"    },
];
function colorFor(idx: number) { return LIST_COLORS[idx % LIST_COLORS.length]; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPointCue(cue: Cue): boolean {
  if (cue.start.kind !== cue.end.kind) return false;
  if (cue.start.kind === "gap" && cue.end.kind === "gap")
    return cue.start.afterBlockId === cue.end.afterBlockId;
  if (cue.start.kind === "block" && cue.end.kind === "block")
    return cue.start.blockId === cue.end.blockId && cue.start.offset === cue.end.offset;
  return false;
}

function anchorEq(a: CueAnchor, b: CueAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "gap" && b.kind === "gap") return a.afterBlockId === b.afterBlockId;
  if (a.kind === "block" && b.kind === "block")
    return a.blockId === b.blockId && a.offset === b.offset;
  return false;
}

// Linear sort key: gap after block i sits between block i and block i+1.
function anchorSortKey(anchor: CueAnchor, blockIndexMap: Map<string, number>): number {
  if (anchor.kind === "gap") {
    const i = blockIndexMap.get(anchor.afterBlockId) ?? -1;
    return (i + 1) * 1_000_000;
  }
  const i = blockIndexMap.get(anchor.blockId) ?? -1;
  return i * 1_000_000 + anchor.offset + 1;
}

// ─── Drag types ───────────────────────────────────────────────────────────────

// "expand": drag a point cue outward to form a range (direction determined by drag direction)
type DragType = "move" | "expand" | "handle-start" | "handle-end";

type DragStateRef = {
  active: boolean;
  dragType: DragType;
  cueId: string;
  startX: number;
  startY: number;
  thresholdMet: boolean;
  liveAnchor: CueAnchor | null;
  originalAnchor: CueAnchor | null;
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  cueLists: CueList[];
  initialCues: Cue[];
  editableListIds: string[];
  myOpenId: string;
  isAdmin: boolean;
};

type Selection =
  | { kind: "none" }
  | { kind: "cue"; cueId: string }
  | { kind: "pending"; start: CueAnchor; end: CueAnchor };

type DragConfig = { dragType: DragType; origAnchor?: CueAnchor };

type CueMark = {
  offset: number;
  colorHex: string;
  selected: boolean;
  cueId: string;
  dragConfig?: DragConfig;
};

type GuideLineData = {
  cueId: string; color: string;
  chipX: number; chipY: number; markX: number; markY: number;
};

// ─── Comment types ───────────────────────────────────────────────────────────

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

// ─── Presence ────────────────────────────────────────────────────────────────

type CuePresence = {
  clientId: string;
  userName: string;
  color: string;
  listId: string | null;
  cueId: string | null;
};

function getOrCreateClientId(): string {
  const key = "presence_client_id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(key, id); }
  return id;
}

function anonymousName(clientId: string): string {
  return "访客 " + clientId.slice(-4).toUpperCase();
}

// ─── Comment helpers ─────────────────────────────────────────────────────────

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

// ─── CueCommentsPanel ─────────────────────────────────────────────────────────

function CueCommentsPanel({
  cueId, productionId, comments, currentOpenId, isAdmin,
  onAdd, onEdit, onDelete, onClose,
}: {
  cueId: string; productionId: string; comments: Comment[];
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
    () => comments.filter(c => c.contextId === cueId && c.parentId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments, cueId],
  );
  const repliesFor = useCallback(
    (parentId: string) => comments.filter(c => c.parentId === parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments],
  );

  const postComment = async (opts: { parentId?: string; text: string; mentions: Mention[] }) => {
    if (submitting) return null;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cueId, body: opts.text, parentId: opts.parentId ?? null, mentions: opts.mentions }),
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
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    if (res.ok) { onEdit((await res.json()).comment); setEditingId(null); }
  };

  const doDelete = async (id: string) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments/${id}`, { method: "DELETE" });
    if (res.ok) onDelete(id);
  };

  const startReply = (parentId: string, authorOpenId: string, authorName: string) => {
    setReplyingTo(parentId);
    setReplyText(`@${authorName} `);
    setReplyMentions([{ openId: authorOpenId, name: authorName }]);
  };

  const taClass = "w-full resize-none rounded border border-zinc-200 px-2 py-1.5 text-sm text-zinc-700 outline-none focus:border-zinc-400";

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
    <div
      className="fixed right-0 top-[44px] bottom-[44px] z-30 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-700">评论</span>
        <button onClick={onClose} className="text-lg leading-none text-zinc-300 hover:text-zinc-500">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {topLevel.length === 0 && <p className="py-4 text-center text-xs text-zinc-300">暂无评论</p>}
        {topLevel.map(topC => (
          <div key={topC.id}>
            <div className="group">
              {commentHeader(topC)}
              {commentBody(topC, {
                label: replyingTo === topC.id ? "取消回复" : "回复",
                onClick: () => replyingTo === topC.id ? setReplyingTo(null) : startReply(topC.id, topC.openId, topC.authorName),
              })}
            </div>

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
          className={taClass} />
        <div className="mt-2 flex justify-end">
          <button onClick={submitNew} disabled={!newText.trim() || submitting}
            className="rounded bg-zinc-800 px-4 py-1.5 text-xs text-white hover:bg-zinc-700 disabled:opacity-40">
            {submitting ? "…" : "发布"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inline edit field ────────────────────────────────────────────────────────

function InlineField({
  value, onCommit, placeholder, className,
}: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!focused && draft !== value) setDraft(value);
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); if (draft !== value) onCommit(draft); }}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setDraft(value); e.currentTarget.blur(); }
      }}
      placeholder={placeholder}
      className={className}
    />
  );
}

// ─── BlockText ────────────────────────────────────────────────────────────────

function BlockText({
  blockId, content, rangeHighlights, pendingHighlight, pointMarks, pendingCursor,
  onClick, onSelect, onMarkDrag, onMarkClick,
}: {
  blockId: string;
  content: string;
  rangeHighlights: { start: number; end: number; colorIdx: number; label?: string }[];
  pendingHighlight: { start: number; end: number } | null;
  pointMarks: CueMark[];
  pendingCursor: number | null;
  onClick: (blockId: string, offset: number) => void;
  onSelect: (blockId: string, start: number, end: number) => void;
  onMarkDrag?: (e: React.MouseEvent, cueId: string, dragType: DragType, origAnchor?: CueAnchor) => void;
  onMarkClick?: (cueId: string) => void;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const justRangeSelectedRef = useRef(false);

  const getOffset = useCallback((container: HTMLSpanElement, node: Node, nodeOffset: number): number => {
    let offset = 0;
    const iter = document.createNodeIterator(container, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = iter.nextNode())) {
      if (cur === node) return offset + nodeOffset;
      offset += cur.textContent?.length ?? 0;
    }
    return offset;
  }, []);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return;
    const range = sel.getRangeAt(0);
    const container = containerRef.current;
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

    const start = getOffset(container, range.startContainer, range.startOffset);
    const end = getOffset(container, range.endContainer, range.endOffset);
    if (start < end) {
      justRangeSelectedRef.current = true;
      onSelect(blockId, start, end);
    }
    sel.removeAllRanges();
  }, [blockId, onSelect, getOffset]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (justRangeSelectedRef.current) { justRangeSelectedRef.current = false; return; }
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!range || !containerRef.current?.contains(range.startContainer)) return;
    onClick(blockId, getOffset(containerRef.current!, range.startContainer, range.startOffset));
  }, [blockId, onClick, getOffset]);

  type RenderItem =
    | { kind: "text"; text: string; bgHex: string | null; pending: boolean; rangeLabel?: string }
    | { kind: "cue-mark"; colorHex: string; selected: boolean; cueId: string; dragConfig?: DragConfig }
    | { kind: "pending-cursor" };

  const items: RenderItem[] = useMemo(() => {
    if (!content) return [];

    type Event =
      | { pos: number; sort: number; action: "range-open";  colorIdx: number; label?: string }
      | { pos: number; sort: number; action: "range-close"; colorIdx: number }
      | { pos: number; sort: number; action: "pend-open" }
      | { pos: number; sort: number; action: "pend-close" }
      | { pos: number; sort: number; action: "cue-mark"; colorHex: string; selected: boolean; cueId: string; dragConfig?: DragConfig }
      | { pos: number; sort: number; action: "pending-cursor" };

    const evts: Event[] = [];
    for (const h of rangeHighlights) {
      evts.push({ pos: h.start, sort: 2, action: "range-open",  colorIdx: h.colorIdx, label: h.label });
      evts.push({ pos: h.end,   sort: 0, action: "range-close", colorIdx: h.colorIdx });
    }
    if (pendingHighlight) {
      evts.push({ pos: pendingHighlight.start, sort: 2, action: "pend-open" });
      evts.push({ pos: pendingHighlight.end,   sort: 0, action: "pend-close" });
    }
    for (const pm of pointMarks)
      evts.push({ pos: Math.min(pm.offset, content.length), sort: 1, action: "cue-mark", colorHex: pm.colorHex, selected: pm.selected, cueId: pm.cueId, dragConfig: pm.dragConfig });
    if (pendingCursor !== null)
      evts.push({ pos: Math.min(pendingCursor, content.length), sort: 1, action: "pending-cursor" });

    evts.sort((a, b) => a.pos - b.pos || a.sort - b.sort);

    const result: RenderItem[] = [];
    let textPos = 0;
    let activeColorIdx: number | null = null;
    let activeLabel: string | undefined;
    let isPending = false;

    const flush = (to: number) => {
      if (to > textPos) {
        result.push({
          kind: "text",
          text: content.slice(textPos, to),
          bgHex: activeColorIdx !== null ? LIST_COLORS[activeColorIdx % LIST_COLORS.length].line + "33" : null,
          pending: isPending,
          rangeLabel: activeColorIdx !== null ? activeLabel : undefined,
        });
        textPos = to;
      }
    };

    for (const e of evts) {
      flush(e.pos);
      if (e.action === "range-open")       { activeColorIdx = e.colorIdx; activeLabel = e.label; }
      else if (e.action === "range-close") { activeColorIdx = null; activeLabel = undefined; }
      else if (e.action === "pend-open")   isPending = true;
      else if (e.action === "pend-close")  isPending = false;
      else if (e.action === "cue-mark")    result.push({ kind: "cue-mark", colorHex: e.colorHex, selected: e.selected, cueId: e.cueId, dragConfig: e.dragConfig });
      else if (e.action === "pending-cursor") result.push({ kind: "pending-cursor" });
    }
    flush(content.length);
    return result;
  }, [content, rangeHighlights, pendingHighlight, pointMarks, pendingCursor]);

  return (
    <span
      ref={containerRef}
      data-block-id={blockId}
      className="cursor-text select-text"
      onMouseUp={handleMouseUp}
      onClick={handleClick}
    >
      {items.map((item, i) =>
        item.kind === "text" ? (
          item.bgHex ? (
            <mark key={i} title={item.rangeLabel} className="rounded-sm cursor-pointer" style={{ backgroundColor: item.bgHex }}>{item.text}</mark>
          ) : item.pending ? (
            <mark key={i} className="bg-zinc-200 rounded-sm">{item.text}</mark>
          ) : (
            <span key={i}>{item.text}</span>
          )
        ) : item.kind === "cue-mark" ? (
          <span
            key={i}
            data-mark-cue-id={item.cueId}
            onMouseDown={item.dragConfig && onMarkDrag
              ? (e) => onMarkDrag(e, item.cueId, item.dragConfig!.dragType, item.dragConfig!.origAnchor)
              : undefined}
            onClick={onMarkClick
              ? (e) => { e.stopPropagation(); onMarkClick(item.cueId); }
              : undefined}
            className={`inline-block w-[3px] h-[1em] rounded-full align-middle mx-[-1px] transition-transform
              ${item.dragConfig ? "cursor-ew-resize" : "cursor-pointer"}
              ${item.selected ? "scale-y-125" : ""}`}
            style={{ backgroundColor: item.colorHex }}
          />
        ) : (
          <span key={i} className="inline-block w-[2px] h-[1em] rounded-full align-middle mx-[-1px] bg-zinc-400 animate-pulse" />
        )
      )}
    </span>
  );
}

// ─── Cue chip ─────────────────────────────────────────────────────────────────

function CueChip({
  cue, colorIdx, selected, warning, editable, presenceUsers, onSelect, onCommitNumber, onCommitName, onDragStart,
}: {
  cue: Cue; colorIdx: number; selected: boolean; warning: boolean; editable: boolean;
  presenceUsers: CuePresence[];
  onSelect: () => void;
  onCommitNumber: (v: string) => void;
  onCommitName: (v: string) => void;
  onDragStart?: (e: React.MouseEvent) => void;
}) {
  const c = colorFor(colorIdx);
  return (
    <div
      data-chip-cue-id={cue.id}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); if (!selected) onSelect(); }}
      className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-mono cursor-pointer transition-all select-none
        ${selected ? `${c.bg} text-white ring-2 ring-offset-1 ring-white/50 shadow` : `${c.light} ${c.text} whitespace-nowrap hover:ring-1 hover:ring-current/30`}
        ${warning ? "ring-1 ring-amber-400" : ""}`}
      title={warning ? "⚠ 位置可能已偏移，请检查" : undefined}
    >
      {onDragStart && (
        <span
          onMouseDown={e => { e.stopPropagation(); onDragStart(e); }}
          className={`cursor-grab active:cursor-grabbing shrink-0 select-none leading-none
            ${selected ? "text-white/40 hover:text-white/70" : "text-current/25 hover:text-current/50"}`}
          style={{ fontSize: "9px", letterSpacing: "-1px" }}
        >⠿</span>
      )}
      {warning && <span className={selected ? "text-amber-200" : "text-amber-400"}>⚠</span>}
      {selected && editable ? (
        <>
          <InlineField
            value={cue.number}
            onCommit={onCommitNumber}
            placeholder="Q#"
            className="w-8 bg-white/20 text-white text-[10px] font-mono rounded px-0.5 outline-none placeholder:text-white/40 min-w-0"
          />
          <span className="text-white/40 shrink-0">/</span>
          <InlineField
            value={cue.name}
            onCommit={onCommitName}
            placeholder="名称"
            className="w-20 bg-white/20 text-white text-[10px] rounded px-0.5 outline-none placeholder:text-white/40 min-w-0"
          />
        </>
      ) : (
        <>
          <span className="font-bold">{cue.number}</span>
          {cue.name && <span className="opacity-70 max-w-[96px] truncate">{cue.name}</span>}
        </>
      )}
      {presenceUsers.length > 0 && (
        <div
          className="flex -space-x-1 ml-0.5 shrink-0"
          title={presenceUsers.map(p => p.userName).join("、")}
        >
          {presenceUsers.slice(0, 3).map(p => (
            <div
              key={p.clientId}
              style={{ backgroundColor: p.color, fontSize: "7px" }}
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/70 flex items-center justify-center font-bold text-white shrink-0"
            >
              {p.userName.charAt(0)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Export Modal ─────────────────────────────────────────────────────────────

function ExportModal({
  cueLists,
  defaultSelectedIds,
  productionId,
  onClose,
}: {
  cueLists: CueList[];
  defaultSelectedIds: Set<string>;
  productionId: string;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(defaultSelectedIds));
  const [wikiUrl, setWikiUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const runExport = useCallback(async () => {
    setPhase("running");
    setLog([]);
    setErrMsg("");
    const addLog = (msg: string) => setLog(prev => [...prev, msg]);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/export-cues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cueListIds: [...selectedIds], wikiUrl: wikiUrl.trim() }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setPhase("error");
        setErrMsg(text || `HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let event = "log";
        for (const line of lines) {
          if (line.startsWith("event: ")) { event = line.slice(7).trim(); continue; }
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (event === "log") addLog(data);
            if (event === "done") { setPhase("done"); break outer; }
            if (event === "error") { setPhase("error"); setErrMsg(data); break outer; }
          }
        }
      }
    } catch (e) {
      setPhase("error");
      setErrMsg((e as Error).message ?? "未知错误");
    }
  }, [selectedIds, wikiUrl, productionId]);

  const busy = phase === "running";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-zinc-700">导出 Cue</h2>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-zinc-400">选择 Cue 表</p>
          <div className="flex flex-wrap gap-1.5">
            {cueLists.map((cl, i) => {
              const c = colorFor(i);
              const on = selectedIds.has(cl.id);
              return (
                <button
                  key={cl.id}
                  onClick={() => toggle(cl.id)}
                  disabled={busy}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-all disabled:opacity-50 ${
                    on ? `${c.bg} text-white` : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
                  }`}
                >
                  {cl.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-400">飞书电子表格 Wiki 链接</p>
          <input
            type="text"
            value={wikiUrl}
            onChange={e => setWikiUrl(e.target.value)}
            placeholder="https://xxx.feishu.cn/wiki/…"
            disabled={busy}
            className="text-xs border border-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-zinc-400 disabled:bg-zinc-50"
          />
        </div>

        {phase !== "idle" && (
          <div
            ref={logRef}
            className="bg-zinc-50 rounded-lg p-3 text-xs font-mono text-zinc-600 max-h-36 overflow-y-auto flex flex-col gap-0.5"
          >
            {log.map((line, i) => <span key={i}>{line}</span>)}
            {phase === "error" && <span className="text-red-500">✗ {errMsg}</span>}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-xs text-zinc-400 hover:text-zinc-600 px-3 py-1.5"
          >
            {phase === "done" ? "关闭" : "取消"}
          </button>
          {phase !== "done" && (
            <button
              onClick={runExport}
              disabled={busy || selectedIds.size === 0 || !wikiUrl.trim()}
              className="text-xs bg-zinc-800 text-white rounded-lg px-4 py-1.5 hover:bg-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "导出中…" : "导出"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CuePage({
  productionId, productionName, blocks, characters, scenes,
  cueLists, initialCues, editableListIds, myOpenId, isAdmin,
}: Props) {
  const [cues, setCues] = useState<Cue[]>(initialCues);
  const [copiedCue, setCopiedCue] = useState<Cue | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentCueId, setActiveCommentCueId] = useState<string | null>(null);
  const [visibleListIds, setVisibleListIds] = useState<Set<string>>(
    () => new Set(cueLists.slice(0, 3).map(cl => cl.id))
  );
  const [activeListId, setActiveListId] = useState<string | null>(
    editableListIds[0] ?? cueLists[0]?.id ?? null
  );
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [savingCueId, setSavingCueId] = useState<string | null>(null);

  // ── Drag state ────────────────────────────────────────────────────────────
  const dragStateRef = useRef<DragStateRef>({
    active: false, dragType: "move", cueId: "",
    startX: 0, startY: 0, thresholdMet: false, liveAnchor: null, originalAnchor: null,
  });
  const [dragLive, setDragLive] = useState<{
    cueId: string; dragType: DragType; anchor: CueAnchor; originalAnchor: CueAnchor | null;
  } | null>(null);

  // Stable refs for use inside event handlers (avoid stale closures in global listeners)
  const cuesRef = useRef(cues);
  useEffect(() => { cuesRef.current = cues; }, [cues]);
  const visibleListIdsRef = useRef(visibleListIds);
  useEffect(() => { visibleListIdsRef.current = visibleListIds; }, [visibleListIds]);
  const activeListIdRef = useRef(activeListId);
  useEffect(() => { activeListIdRef.current = activeListId; }, [activeListId]);
  const blockIndexMapRef = useRef<Map<string, number>>(new Map());
  // Suppresses the browser click event that fires immediately after a completed drag mouseup.
  const justDraggedRef = useRef(false);

  // ── Presence ──────────────────────────────────────────────────────────────
  const [clientId] = useState<string>(() =>
    typeof window !== "undefined" ? getOrCreateClientId() : ""
  );
  const [userName, setUserName] = useState<string>(() =>
    typeof window !== "undefined"
      ? (localStorage.getItem("presence_name") || anonymousName(getOrCreateClientId()))
      : ""
  );
  const [presenceMap, setPresenceMap] = useState<Map<string, CuePresence>>(new Map());
  const lastSentPresRef = useRef("");
  const presTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch real name from session (same localStorage key as ScriptEditor)
  useEffect(() => {
    fetch(`${BASE_PATH}/api/me`)
      .then(r => r.json())
      .then((d: { name: string | null }) => {
        if (d.name) { setUserName(d.name); localStorage.setItem("presence_name", d.name); }
      })
      .catch(() => {});
  }, []);

  // Load cue comments for this production
  useEffect(() => {
    fetch(`${BASE_PATH}/api/production/${productionId}/cue-comments`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { comments?: Comment[] } | null) => { if (d?.comments) setComments(d.comments); })
      .catch(() => {});
  }, [productionId]);

  // Comment panel follows cue selection: auto-open on select, close on deselect
  useEffect(() => {
    if (selection.kind === "cue") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveCommentCueId(selection.cueId);
    } else if (selection.kind === "none") {
      setActiveCommentCueId(null);
    }
  }, [selection]);

  const sendCuePresence = useCallback((listId: string | null, cueId: string | null) => {
    if (!clientId || !userName) return;
    const key = `${listId}|${cueId}`;
    if (lastSentPresRef.current === key) return;
    lastSentPresRef.current = key;
    if (presTimerRef.current) clearTimeout(presTimerRef.current);
    presTimerRef.current = setTimeout(() => {
      fetch(`${BASE_PATH}/api/production/${productionId}/cue-presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, userName, listId, cueId }),
      }).catch(() => {});
    }, 200);
  }, [clientId, userName, productionId]);

  useEffect(() => {
    if (selection.kind === "cue") {
      sendCuePresence(activeListId, selection.cueId);
    } else {
      // Delay clearing cueId so brief transitions through "pending" (text-drag to
      // create a selection) don't immediately wipe the cue presence indicator.
      const t = setTimeout(() => sendCuePresence(activeListId, null), 1500);
      return () => clearTimeout(t);
    }
  }, [activeListId, selection, sendCuePresence]);

  const presenceForCue = useMemo(() => {
    const m = new Map<string, CuePresence[]>();
    for (const p of presenceMap.values()) {
      if (p.clientId === clientId || !p.cueId) continue;
      if (!m.has(p.cueId)) m.set(p.cueId, []);
      m.get(p.cueId)!.push(p);
    }
    return m;
  }, [presenceMap, clientId]);

  const presenceForList = useMemo(() => {
    const m = new Map<string, CuePresence[]>();
    for (const p of presenceMap.values()) {
      if (p.clientId === clientId || !p.listId) continue;
      if (!m.has(p.listId)) m.set(p.listId, []);
      m.get(p.listId)!.push(p);
    }
    return m;
  }, [presenceMap, clientId]);

  // Active list is always visible even if toggled off
  const visibleLists = cueLists.filter(cl => visibleListIds.has(cl.id) || cl.id === activeListId);
  const listColorIndex = useMemo(() => {
    const m = new Map<string, number>();
    cueLists.forEach((cl, i) => m.set(cl.id, i));
    return m;
  }, [cueLists]);

  const canEditActive = editableListIds.includes(activeListId ?? "");
  // Editing any cue requires an active list — prevents accidental edits with no context
  const canEditCue = useCallback((cue: Cue) =>
    cue.cueListId === activeListId && editableListIds.includes(cue.cueListId),
  [activeListId, editableListIds]);

  // ── updateCueField ────────────────────────────────────────────────────────
  const updateCueField = useCallback(async (
    cue: Cue,
    fields: { number?: string; name?: string; content?: string; warning?: boolean; start?: CueAnchor; end?: CueAnchor }
  ) => {
    setSavingCueId(cue.id);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cue.cueListId}/cues/${cue.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        }
      );
      if (res.ok) {
        setCues(prev => prev.map(c => c.id === cue.id ? { ...c, ...fields } : c));
      }
    } finally {
      setSavingCueId(null);
    }
  }, [productionId]);

  const updateCueFieldRef = useRef(updateCueField);
  useEffect(() => { updateCueFieldRef.current = updateCueField; }, [updateCueField]);

  // ── anchorFromPoint: resolve mouse coordinates to a CueAnchor ─────────────
  const anchorFromPoint = useCallback((x: number, y: number): CueAnchor | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    // Gap zones take priority (they're outside block text)
    const gapEl = el.closest("[data-gap-after]") as HTMLElement | null;
    if (gapEl?.dataset.gapAfter) return { kind: "gap", afterBlockId: gapEl.dataset.gapAfter };

    // Chip column → treat as block start (offset 0)
    const chipColEl = el.closest("[data-chip-col-for]") as HTMLElement | null;
    if (chipColEl?.dataset.chipColFor)
      return { kind: "block", blockId: chipColEl.dataset.chipColFor, offset: 0 };

    // Block text area
    const blockEl = el.closest("[data-block-id]") as HTMLElement | null;
    if (!blockEl?.dataset.blockId) return null;

    const caretRange = document.caretRangeFromPoint?.(x, y);
    if (!caretRange) return { kind: "block", blockId: blockEl.dataset.blockId, offset: 0 };

    let offset = 0;
    const iter = document.createNodeIterator(blockEl, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = iter.nextNode())) {
      if (cur === caretRange.startContainer) { offset += caretRange.startOffset; break; }
      offset += cur.textContent?.length ?? 0;
    }
    return { kind: "block", blockId: blockEl.dataset.blockId, offset };
  }, []);

  // ── startCueDrag: begin a drag operation ──────────────────────────────────
  const startCueDrag = useCallback((
    e: React.MouseEvent, cueId: string, dragType: DragType, originalAnchor?: CueAnchor
  ) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      active: true, dragType, cueId,
      startX: e.clientX, startY: e.clientY,
      thresholdMet: false, liveAnchor: null,
      originalAnchor: originalAnchor ?? null,
    };
  }, []);

  // ── Global drag event listeners ───────────────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      if (!ds.thresholdMet) {
        const dist = Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY);
        if (dist < 5) return;
        ds.thresholdMet = true;
        document.body.style.cursor = "crosshair";
      }
      const anchor = anchorFromPoint(e.clientX, e.clientY);
      if (anchor) {
        ds.liveAnchor = anchor;
        setDragLive({ cueId: ds.cueId, dragType: ds.dragType, anchor, originalAnchor: ds.originalAnchor });
      }
    };

    const handleMouseUp = () => {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      const wasThreshold = ds.thresholdMet;
      const anchor = ds.liveAnchor;
      const origAnchor = ds.originalAnchor;
      ds.active = false;
      ds.thresholdMet = false;
      ds.liveAnchor = null;
      ds.originalAnchor = null;
      document.body.style.cursor = "";
      setDragLive(null);
      if (!wasThreshold || !anchor) return;
      justDraggedRef.current = true; // suppress the browser click that fires right after mouseup
      const cue = cuesRef.current.find(c => c.id === ds.cueId);
      if (!cue) return;
      if (ds.dragType === "move") {
        updateCueFieldRef.current(cue, { start: anchor, end: anchor, warning: false });
      } else if (ds.dragType === "expand" && origAnchor) {
        const k  = anchorSortKey(anchor, blockIndexMapRef.current);
        const ok = anchorSortKey(origAnchor, blockIndexMapRef.current);
        if (k < ok)       updateCueFieldRef.current(cue, { start: anchor,    end: origAnchor, warning: false });
        else if (k > ok)  updateCueFieldRef.current(cue, { start: origAnchor, end: anchor,    warning: false });
        // k === ok: stayed at same spot, no-op
      } else if (ds.dragType === "handle-start") {
        updateCueFieldRef.current(cue, { start: anchor, warning: false });
      } else if (ds.dragType === "handle-end") {
        updateCueFieldRef.current(cue, { end: anchor, warning: false });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [anchorFromPoint]);

  // ── Cue SSE: refetch visible lists when any client mutates cues ───────────
  useEffect(() => {
    const es = new EventSource(
      `${BASE_PATH}/api/production/${productionId}/cue-stream${clientId ? `?cid=${encodeURIComponent(clientId)}` : ""}`
    );
    let debounce: ReturnType<typeof setTimeout> | null = null;
    es.addEventListener("presence", (e: MessageEvent) => {
      const list = JSON.parse(e.data as string) as CuePresence[];
      setPresenceMap(new Map(list.map(p => [p.clientId, p])));
    });
    es.onmessage = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const ids = new Set(visibleListIdsRef.current);
        if (activeListIdRef.current) ids.add(activeListIdRef.current);
        const listIds = [...ids];
        const results = await Promise.all(
          listIds.map(listId =>
            fetch(`${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/cues`)
              .then(r => r.ok ? (r.json() as Promise<Cue[]>) : [])
              .catch(() => [] as Cue[])
          )
        );
        const fresh = results.flat();
        setCues(prev => [...prev.filter(c => !ids.has(c.cueListId)), ...fresh]);
      }, 300);
    };
    return () => { es.close(); if (debounce) clearTimeout(debounce); };
  }, [productionId, clientId]);

  // ── blockIndexMap: stable sorted index for anchor comparisons ────────────
  const blockIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    blocks.forEach((b, i) => m.set(b.id, i));
    return m;
  }, [blocks]);
  useEffect(() => { blockIndexMapRef.current = blockIndexMap; }, [blockIndexMap]);

  // ── Orphaned cues: either anchor references a block that no longer exists ──
  const orphanedCues = useMemo(() => {
    return cues.filter(cue => {
      const startId = cue.start.kind === "block" ? cue.start.blockId : cue.start.afterBlockId;
      const endId   = cue.end.kind   === "block" ? cue.end.blockId   : cue.end.afterBlockId;
      return !blockIndexMap.has(startId) || !blockIndexMap.has(endId);
    });
  }, [cues, blockIndexMap]);

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

  const handleContainerClick = useCallback(() => setSelection({ kind: "none" }), []);

  const handleBlockSelect = useCallback((blockId: string, start: number, end: number) => {
    setSelection({ kind: "pending", start: { kind: "block", blockId, offset: start }, end: { kind: "block", blockId, offset: end } });
  }, []);

  // Returns the first visible range cue whose highlighted area contains (blockId, offset).
  const findRangeCueAtPosition = useCallback((blockId: string, offset: number): Cue | null => {
    const bi = blockIndexMap.get(blockId) ?? -1;
    if (bi === -1) return null;
    for (const cl of visibleLists) {
      for (const cue of (cuesByList.get(cl.id) ?? [])) {
        if (isPointCue(cue)) continue;
        if (cue.start.kind !== "block" || cue.end.kind !== "block") continue;
        const si = blockIndexMap.get(cue.start.blockId) ?? -1;
        const ei = blockIndexMap.get(cue.end.blockId) ?? -1;
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
  }, [blockIndexMap, visibleLists, cuesByList]);

  const handleBlockClick = useCallback((blockId: string, offset: number) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const rangeCue = findRangeCueAtPosition(blockId, offset);
    if (rangeCue) { setSelection({ kind: "cue", cueId: rangeCue.id }); return; }
    setSelection({ kind: "pending", start: { kind: "block", blockId, offset }, end: { kind: "block", blockId, offset } });
  }, [findRangeCueAtPosition]);

  const handleMarkClick = useCallback((cueId: string) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const realId = cueId.endsWith(":end") ? cueId.slice(0, -4) : cueId;
    setSelection({ kind: "cue", cueId: realId });
  }, []);

  const handleGapClick = useCallback((afterBlockId: string) => {
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    const anchor: CueAnchor = { kind: "gap", afterBlockId };
    setSelection({ kind: "pending", start: anchor, end: anchor });
  }, []);

  // ── Insert cue ────────────────────────────────────────────────────────────
  const insertCue = useCallback(async () => {
    if (selection.kind !== "pending" || !activeListId || !canEditActive) return;
    const { start, end } = selection;

    const existing = (cuesByList.get(activeListId) ?? []).map(c => c.number);
    const nums = existing.map(n => parseInt(n.replace(/\D/g, ""))).filter(n => !isNaN(n));
    const next = nums.length ? Math.max(...nums) + 1 : 1;

    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${activeListId}/cues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: String(next), name: "", content: "", start, end }),
      }
    );
    if (res.ok) {
      const newCues = await res.json() as Cue[];
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
    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${cue.cueListId}/cues/${cue.id}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setCues(prev => prev.filter(c => c.id !== cue.id));
      setSelection({ kind: "none" });
    }
  }, [productionId]);

  const dismissWarning = useCallback(async (cue: Cue) => {
    await updateCueField(cue, { warning: false });
  }, [updateCueField]);

  // Re-anchor an orphaned cue to the current pending selection
  const reassignOrphanedCue = useCallback(async (cue: Cue) => {
    if (selection.kind !== "pending" || !canEditCue(cue)) return;
    await updateCueField(cue, { start: selection.start, end: selection.end, warning: false });
  }, [selection, canEditCue, updateCueField]);

  // Start dragging an orphaned cue into the script; ensure the list is visible so preview renders
  const startOrphanDrag = useCallback((e: React.MouseEvent, cue: Cue) => {
    setVisibleListIds(prev => prev.has(cue.cueListId) ? prev : new Set([...prev, cue.cueListId]));
    startCueDrag(e, cue.id, "move");
  }, [startCueDrag]);

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
        const si = blockIndexMap.get(cue.start.blockId) ?? -1;
        const ei = blockIndexMap.get(cue.end.blockId) ?? -1;
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
  }, [visibleLists, cuesByList, listColorIndex, blocks, blockIndexMap]);

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

  // ── Guide lines ───────────────────────────────────────────────────────────
  const blockRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [guideLines, setGuideLines] = useState<Map<string, GuideLineData[]>>(new Map());
  const guideLinesHashRef = useRef("");

  useEffect(() => {
    if (dragLive) return; // skip during live drag — measure only committed state
    const newMap = new Map<string, GuideLineData[]>();
    let hash = "";

    for (const [blockId, rowEl] of blockRowRefs.current) {
      const blockChips = (cuesForBlock.get(blockId) ?? []).filter(c => c.cue.start.kind === "block");
      if (blockChips.length === 0) continue;
      const isMulti = blockChips.length >= 2;
      const rowRect = rowEl.getBoundingClientRect();
      const lines: GuideLineData[] = [];

      for (const { cue, listIdx } of blockChips) {
        const chipEl = rowEl.querySelector(`[data-chip-cue-id="${cue.id}"]`) as HTMLElement | null;
        const markEl = rowEl.querySelector(`[data-mark-cue-id="${cue.id}"]`) as HTMLElement | null;
        if (!chipEl || !markEl) continue;
        const chipRect = chipEl.getBoundingClientRect();
        const markRect = markEl.getBoundingClientRect();
        const chipY = Math.round((chipRect.top + chipRect.bottom) / 2 - rowRect.top);
        const markY = Math.round((markRect.top + markRect.bottom) / 2 - rowRect.top);
        if (!isMulti && chipY === markY) continue;
        lines.push({
          cueId: cue.id,
          color: LIST_COLORS[listIdx % LIST_COLORS.length].line,
          chipX: Math.round(chipRect.right - rowRect.left),
          chipY,
          markX: Math.round((markRect.left + markRect.right) / 2 - rowRect.left),
          markY,
        });
      }
      if (lines.length > 0) {
        newMap.set(blockId, lines);
        hash += blockId + lines.map(l => `${l.chipX},${l.chipY},${l.markX},${l.markY}`).join(";") + "|";
      }
    }

    if (hash !== guideLinesHashRef.current) {
      guideLinesHashRef.current = hash;
      setGuideLines(newMap);
    }
  }, [cuesForBlock, selection, dragLive]);

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
      const nums = existing.map(n => parseInt(n.replace(/\D/g, ""))).filter(n => !isNaN(n));
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${activeListId}/cues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ number: String(next), name: copiedCue.name, content: copiedCue.content, start, end }),
        }
      );
      if (res.ok) {
        const newCues = await res.json() as Cue[];
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
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const lastGapChips = lastBlock
    ? (cuesForBlock.get(lastBlock.id) ?? []).filter(({ cue }) => cue.start.kind === "gap")
    : [];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-zinc-100" onClick={handleContainerClick}>

      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-zinc-200 shrink-0" onClick={e => e.stopPropagation()}>
        <Link href={`/production/${productionId}`} className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0">
          ← {productionName}
        </Link>
        <Link href={`/production/${productionId}/cuelists`} className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0 transition-colors">
          Cue表
        </Link>
        <span className="text-zinc-200">|</span>
        <div className="flex gap-1.5 flex-wrap">
          {cueLists.map((cl, i) => {
            const c = colorFor(i);
            const on = visibleListIds.has(cl.id);
            const lp = presenceForList.get(cl.id) ?? [];
            return (
              <div key={cl.id} className="flex flex-col items-center gap-0.5">
                <button
                  onClick={() => setVisibleListIds(prev => {
                    const next = new Set(prev);
                    if (next.has(cl.id)) next.delete(cl.id); else next.add(cl.id);
                    return next;
                  })}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-all ${
                    on ? `${c.bg} text-white` : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
                  }`}
                >
                  {cl.name}
                </button>
                {lp.length > 0 && (
                  <div
                    className="flex -space-x-0.5"
                    title={lp.map(p => p.userName).join("、")}
                  >
                    {lp.slice(0, 4).map(p => (
                      <div
                        key={p.clientId}
                        style={{ backgroundColor: p.color }}
                        className="h-2 w-2 rounded-full ring-1 ring-white"
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <span className="text-zinc-200">|</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-400 shrink-0">激活</span>
          <select
            value={activeListId ?? ""}
            onChange={e => setActiveListId(e.target.value || null)}
            className="text-xs bg-zinc-50 border border-zinc-200 rounded px-1.5 py-0.5 outline-none"
          >
            <option value="">—</option>
            {cueLists.filter(cl => editableListIds.includes(cl.id)).map(cl => (
              <option key={cl.id} value={cl.id}>{cl.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setShowExport(true)}
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-600 shrink-0 transition-colors"
        >
          导出
        </button>
        {selection.kind === "pending" && activeListId && canEditActive && (
          <button
            onClick={e => { e.stopPropagation(); insertCue(); }}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-white hover:bg-zinc-900 shrink-0"
          >
            插入 Cue
          </button>
        )}
      </div>

      {/* ── Script + Cue lanes ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto py-6 px-2">
          {blocks.map((block, blockIdx) => {
            const chipsHere = cuesForBlock.get(block.id) ?? [];
            const rangeHL = rangeHighlightsForBlock.get(block.id) ?? [];
            const pendingHL = pendingHighlightForBlock.get(block.id) ?? null;
            const prevBlock = blockIdx > 0 ? blocks[blockIdx - 1] : null;

            const scene = block.sceneId ? sceneMap.get(block.sceneId) : null;
            const prevScene = prevBlock?.sceneId ? sceneMap.get(prevBlock.sceneId) : null;
            const showSceneHeading = scene && scene.id !== prevScene?.id;

            const gapBlockId = prevBlock?.id ?? null;
            const gapChips = gapBlockId ? (cuesForBlock.get(gapBlockId)?.filter(
              ({ cue }) => cue.start.kind === "gap"
            ) ?? []) : [];
            const gapPending = pendingGapBlockId === gapBlockId;

            return (
              <React.Fragment key={block.id}>
                {/* Gap zone */}
                {blockIdx > 0 && (
                  <div
                    data-gap-after={gapBlockId!}
                    className={`flex items-center gap-0 rounded transition-colors cursor-pointer group
                      ${gapPending ? "bg-zinc-200/70" : "hover:bg-zinc-100"}`}
                    style={{ minHeight: "22px" }}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); handleGapClick(gapBlockId!); }}
                  >
                    <div className="w-44 shrink-0 flex gap-1 flex-wrap px-2 py-1">
                      {gapChips.map(({ cue, listIdx }) => (
                        <CueChip
                          key={cue.id}
                          cue={cue}
                          colorIdx={listIdx}
                          selected={selection.kind === "cue" && selection.cueId === cue.id}
                          warning={cue.warning}
                          editable={canEditCue(cue)}
                          presenceUsers={presenceForCue.get(cue.id) ?? []}
                          onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                          onCommitNumber={v => updateCueField(cue, { number: v })}
                          onCommitName={v => updateCueField(cue, { name: v })}
                          onDragStart={canEditCue(cue) ? (e) => startCueDrag(e, cue.id, "move") : undefined}
                        />
                      ))}
                    </div>
                    <div className="flex-1 flex items-center gap-2 pr-2">
                      <div className="h-px flex-1 bg-zinc-200 group-hover:bg-zinc-300 transition-colors" />
                      {activeListId && canEditActive && (
                        <span className="text-[10px] text-zinc-300 group-hover:text-zinc-400 transition-colors select-none">
                          + Cue
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Scene heading */}
                {showSceneHeading && (
                  <div className="px-2 pt-3 pb-1">
                    <p className="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase">
                      {scene!.number} {scene!.name}
                    </p>
                  </div>
                )}

                {/* Block row */}
                <div
                  ref={el => { if (el) blockRowRefs.current.set(block.id, el); else blockRowRefs.current.delete(block.id); }}
                  className="flex gap-0 rounded-lg py-1.5 hover:bg-white/60 transition-colors relative"
                  onClick={e => e.stopPropagation()}
                >
                  {/* SVG guide lines: Bezier curves from chip right edge to inline mark */}
                  {(guideLines.get(block.id) ?? []).length > 0 && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" style={{ zIndex: 1 }}>
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
                  <div className="w-44 shrink-0 flex flex-col gap-1 pt-0.5 px-2" data-chip-col-for={block.id}>
                    {chipsHere
                      .filter(({ cue }) => cue.start.kind === "block")
                      .map(({ cue, listIdx }) => (
                        <CueChip
                          key={cue.id}
                          cue={cue}
                          colorIdx={listIdx}
                          selected={selection.kind === "cue" && selection.cueId === cue.id}
                          warning={cue.warning}
                          editable={canEditCue(cue)}
                          presenceUsers={presenceForCue.get(cue.id) ?? []}
                          onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                          onCommitNumber={v => updateCueField(cue, { number: v })}
                          onCommitName={v => updateCueField(cue, { name: v })}
                          onDragStart={canEditCue(cue) ? (e) => startCueDrag(e, cue.id, "move") : undefined}
                        />
                      ))
                    }
                  </div>

                  <div className="w-[520px] min-w-0 pr-4">
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
                </div>
              </React.Fragment>
            );
          })}

          {/* Final gap after last block */}
          {lastBlock && (
            <div
              data-gap-after={lastBlock.id}
              className={`flex items-center gap-0 rounded cursor-pointer transition-colors group
                ${pendingGapBlockId === lastBlock.id ? "bg-zinc-200/70" : "hover:bg-zinc-100"}`}
              style={{ minHeight: "32px" }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); handleGapClick(lastBlock.id); }}
            >
              <div className="w-44 shrink-0 flex gap-1 flex-wrap px-2 py-1">
                {lastGapChips.map(({ cue, listIdx }) => (
                  <CueChip
                    key={cue.id}
                    cue={cue}
                    colorIdx={listIdx}
                    selected={selection.kind === "cue" && selection.cueId === cue.id}
                    warning={cue.warning}
                    editable={canEditCue(cue)}
                    presenceUsers={presenceForCue.get(cue.id) ?? []}
                    onSelect={() => setSelection({ kind: "cue", cueId: cue.id })}
                    onCommitNumber={v => updateCueField(cue, { number: v })}
                    onCommitName={v => updateCueField(cue, { name: v })}
                    onDragStart={canEditCue(cue) ? (e) => startCueDrag(e, cue.id, "move") : undefined}
                  />
                ))}
              </div>
              <div className="flex-1 flex items-center gap-2 pr-2">
                <div className="h-px flex-1 bg-zinc-200 group-hover:bg-zinc-300 transition-colors" />
                {activeListId && canEditActive && (
                  <span className="text-[10px] text-zinc-300 group-hover:text-zinc-400 transition-colors select-none">
                    + Cue
                  </span>
                )}
              </div>
            </div>
          )}
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
            <span className="text-[10px] text-amber-500">块引用已失效 · 从此处拖拽或选中脚本范围后点击「定位到选区」</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {orphanedCues.map(cue => {
              const listIdx = listColorIndex.get(cue.cueListId) ?? 0;
              const isDragging = dragLive?.cueId === cue.id;
              const canEdit = canEditCue(cue);
              const canReassign = selection.kind === "pending" && canEdit;
              return (
                <div
                  key={cue.id}
                  className={`flex items-center gap-1.5 transition-opacity ${isDragging ? "opacity-25" : ""}`}
                >
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

      {/* ── Bottom bar: selected cue inspector ── */}
      {selectedCue && (() => {
        const canEdit = canEditCue(selectedCue);
        const commentCount = comments.filter(c => c.contextId === selectedCue.id).length;
        return (
          <div
            className="shrink-0 bg-white border-t border-zinc-200 px-4 py-2.5 flex items-center gap-3"
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
          productionId={productionId}
          comments={comments}
          currentOpenId={myOpenId}
          isAdmin={isAdmin}
          onAdd={c => setComments(prev => [...prev, c])}
          onEdit={c => setComments(prev => prev.map(x => x.id === c.id ? c : x))}
          onDelete={id => setComments(prev => prev.filter(x => x.id !== id))}
          onClose={() => setActiveCommentCueId(null)}
        />
      )}
    </div>
  );
}
