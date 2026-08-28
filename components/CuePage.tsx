"use client";

import OverflowSafeSelect from "@/components/OverflowSafeSelect";

import React, {
  useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { Block, Character, Scene } from "@/lib/script-types";
import type { CueList } from "@/lib/cue-list-types";
import type { Cue, CueAnchor } from "@/lib/cue-types";
import CueMountAssets from "@/components/assets/CueMountAssets";
import RelatedWikiChips from "@/components/wiki/RelatedWikiChips";
import MountPointAssets from "@/components/assets/MountPointAssets";
import SmartTextarea from "@/components/SmartTextarea";
import SmartText from "@/components/SmartText";
import CommentAssetPicker, { type PendingAsset } from "@/components/assets/CommentAssetPicker";
import { buildMarkerContextById, isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import { buildMarkerLabelIndex } from "@/lib/script-generated-labels";
import { hasScriptInsertionGapBefore, sceneParentIdMap } from "@/lib/script-insertion-gaps";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionOverflowSubmenuButton,
  ProductionTopMenuDivider,
  PRODUCTION_TOP_MENU_RIGHT_CLASS,
  useAnchoredMenu,
  useProductionToolbar,
} from "@/components/ProductionTopMenu";
import ChevronIcon from "@/components/ChevronIcon";

// ─── Per-production cookies ───────────────────────────────────────────────────

function readCookie(key: string): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
function writeCookie(key: string, value: string) {
  document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
}

type CueViewState = { visibleIds: string[]; activeId: string | null };
type CueSequenceItem =
  | { kind: "gap"; afterBlockId: string }
  | { kind: "marker"; block: Block };

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

type CueJumpTarget = "line" | "page" | "scene";
const CUE_JUMP_OPTIONS: { target: CueJumpTarget; label: string }[] = [
  { target: "line", label: "行" },
  { target: "page", label: "页" },
  { target: "scene", label: "段落" },
];

function CueJumpOptions({ onSelect }: { onSelect: (target: CueJumpTarget) => void }) {
  return CUE_JUMP_OPTIONS.map(({ target, label }) => (
    <button
      key={target}
      type="button"
      onClick={() => onSelect(target)}
      className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
    >
      跳转到{label}…
    </button>
  ));
}

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
    const i = anchor.afterBlockId !== null ? (blockIndexMap.get(anchor.afterBlockId) ?? -1) : -1;
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
  manageListIds: string[];
  myUserId: string;
  isAdmin: boolean;
  pageMap: Record<string, number>;
  versionId?: string;
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

type Mention = { userId: string; name: string };

type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  userId: string;
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

// ─── CueCommentsPanel ─────────────────────────────────────────────────────────

function CueCommentsPanel({
  cueId, logicalCueId, productionId, versionId, comments, currentUserId, isAdmin,
  onAdd, onEdit, onDelete, onClose,
}: {
  // cueId = 行 id：评论 contextId 与附件挂载都锚修订行，保持不动。
  // logicalCueId = 稳定 cue_id：wiki 引用边锚它（#302），两者不可混用。
  cueId: string; logicalCueId: string; productionId: string; versionId?: string | null; comments: Comment[];
  currentUserId: string; isAdmin: boolean;
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
  const [pendingNewAssets, setPendingNewAssets] = useState<PendingAsset[]>([]);
  const [pendingReplyAssets, setPendingReplyAssets] = useState<PendingAsset[]>([]);

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

  const startReply = (parentId: string, authorUserId: string, authorName: string) => {
    setReplyingTo(parentId);
    setReplyText(`@${authorName} `);
    setReplyMentions([{ userId: authorUserId, name: authorName }]);
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
            {c.userId === currentUserId && (
              <button onClick={() => { setEditingId(c.id); setEditText(c.body); }}
                className="text-[11px] text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-zinc-600">
                编辑
              </button>
            )}
            {(c.userId === currentUserId || isAdmin) && (
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
    <div
      className="fixed inset-0 sm:top-[108px] sm:right-0 sm:bottom-0 sm:left-auto sm:w-80 z-50 flex flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-xl"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-700">评论</span>
        <button onClick={onClose} className="text-lg leading-none text-zinc-300 hover:text-zinc-500">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Cue-level assets */}
        <CueMountAssets
          productionId={productionId}
          cueId={cueId}
          versionId={versionId ?? null}
          label="Cue 附件"
          canEdit={true}
          display="panel"
        />

        <RelatedWikiChips productionId={productionId} entityType="cue" entityId={logicalCueId} />

        {topLevel.length === 0 && <p className="py-4 text-center text-xs text-zinc-300">暂无评论</p>}
        {topLevel.map(topC => (
          <div key={topC.id}>
            <div className="group">
              {commentHeader(topC)}
              {commentBody(topC, {
                label: replyingTo === topC.id ? "取消回复" : "回复",
                onClick: () => replyingTo === topC.id ? setReplyingTo(null) : startReply(topC.id, topC.userId, topC.authorName),
              })}
              <MountPointAssets
                productionId={productionId}
                mountType="comment"
                mountId={topC.id}
                label="评论附件"
                display="compact"
              />
            </div>

            {repliesFor(topC.id).map(r => (
              <div key={r.id} className="group mt-2 ml-3 border-l-2 border-zinc-200 pl-3">
                <p className="mb-0.5 text-[10px] text-zinc-300">↳ 回复 {r.mentions[0]?.name ?? topC.authorName}</p>
                {commentHeader(r)}
                {commentBody(r, {
                  label: "回复",
                  onClick: () => startReply(topC.id, r.userId, r.authorName),
                })}
                <MountPointAssets
                  productionId={productionId}
                  mountType="comment"
                  mountId={r.id}
                  label="评论附件"
                  display="compact"
                />
              </div>
            ))}

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
          className={taClass} />
        <div className="mt-2 flex items-center justify-between">
          <CommentAssetPicker productionId={productionId} selected={pendingNewAssets} onSelect={setPendingNewAssets} />
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
  cue, colorIdx, selected, warning, editable, presenceUsers, highlighted,
  onSelect, onCommitNumber, onCommitName, onDragStart,
}: {
  cue: Cue; colorIdx: number; selected: boolean; warning: boolean; editable: boolean;
  presenceUsers: CuePresence[];
  highlighted?: boolean;
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
        ${warning ? "ring-1 ring-amber-400" : ""}
        ${highlighted && !selected ? "ring-2 ring-amber-400 ring-offset-1 shadow-sm shadow-amber-200" : ""}`}
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
  productionId, productionName, blocks: rawBlocks, characters, scenes,
  cueLists, initialCues, editableListIds, manageListIds, myUserId, isAdmin, pageMap,
  versionId,
}: Props) {
  const { stage: toolbarStage, closeOverflow, overflowOpen } = useProductionToolbar();
  const router = useRouter();
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
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentCueId, setActiveCommentCueId] = useState<string | null>(null);
  const [visibleListIds, setVisibleListIds] = useState<Set<string>>(
    () => new Set(cueLists.slice(0, 3).map(cl => cl.id))
  );
  const [activeListId, setActiveListId] = useState<string | null>(
    editableListIds[0] ?? cueLists[0]?.id ?? null
  );
  const toggleListVisibility = (listId: string) => {
    setVisibleListIds((current) => {
      if (listId === activeListId) return current;
      const next = new Set(current);
      if (next.has(listId)) next.delete(listId); else next.add(listId);
      return next;
    });
  };
  // Phase 4: localEditableIds starts from server-computed editableListIds and can be
  // extended when the user self-confirms access to additional lists.
  const [localEditableIds, setLocalEditableIds] = useState<Set<string>>(
    () => new Set(editableListIds),
  );
  const [localManageIds, setLocalManageIds] = useState<Set<string>>(
    // creator always has implicit manage permission regardless of production_member_grant state
    () => new Set([...manageListIds, ...cueLists.filter(cl => cl.createdBy === myUserId).map(cl => cl.id)]),
  );
  const [shareModalListId, setShareModalListId] = useState<string | null>(null);
  // Phase 4: Access modal state — shown when user activates a list they don't yet have edit access to.
  type AccessModal =
    | { listId: string; listName: string; status: "loading" }
    | { listId: string; listName: string; status: "can_self_confirm"; selfConfirmLevel: "edit" | "manage" }
    | { listId: string; listName: string; status: "needs_approval" };
  const [accessModal, setAccessModal] = useState<AccessModal | null>(null);
  const [accessModalConfirming, setAccessModalConfirming] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [savingCueId, setSavingCueId] = useState<string | null>(null);
  const [highlightedCueId, setHighlightedCueId] = useState<string | null>(null);
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollLockedRef = useRef(true);

  // ── Cookie: restore cue view state once on mount ──────────────────────────
  const cueStateRestoredRef = useRef(false);
  useEffect(() => {
    if (cueStateRestoredRef.current) return;
    cueStateRestoredRef.current = true;
    const raw = readCookie(`cue_view_${productionId}`);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as CueViewState;
      const validIds = (saved.visibleIds ?? []).filter(id => cueLists.some(cl => cl.id === id));
      if (validIds.length > 0) setVisibleListIds(new Set(validIds));
      if (saved.activeId && cueLists.some(cl => cl.id === saved.activeId))
        setActiveListId(saved.activeId);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cookie: save cue view state on change ────────────────────────────────
  useEffect(() => {
    if (!cueStateRestoredRef.current) return;
    writeCookie(`cue_view_${productionId}`, JSON.stringify({ visibleIds: [...visibleListIds], activeId: activeListId } satisfies CueViewState));
  }, [visibleListIds, activeListId, productionId]);

  // ── Jump bar ──────────────────────────────────────────────────────────────
  const [jumpTarget, setJumpTarget] = useState<CueJumpTarget | null>(null);
  const [jumpValue, setJumpValue] = useState("");

  // ── Toolbar menus ─────────────────────────────────────────────────────────
  type CueToolbarMenu = "active" | "jump" | "settings" | null;
  const [openToolbarMenu, setOpenToolbarMenu] = useState<CueToolbarMenu>(null);
  const secondaryMenusFolded = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored;
  const cueTagsFolded = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryShort;
  const toolbarCompact = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryStored;
  const activeMenuPosition = useAnchoredMenu<HTMLButtonElement>(
    openToolbarMenu === "active",
    "bottom",
  );
  const settingsMenuPosition = useAnchoredMenu<HTMLButtonElement>(
    openToolbarMenu === "settings" && secondaryMenusFolded,
    toolbarCompact ? "left" : "bottom",
  );
  const toggleToolbarMenu = (menu: Exclude<CueToolbarMenu, null>) => {
    setOpenToolbarMenu((current) => current === menu ? null : menu);
  };
  const finishToolbarAction = () => {
    setOpenToolbarMenu(null);
    closeOverflow();
  };
  const selectJumpTarget = (target: CueJumpTarget) => {
    setJumpTarget((current) => current === target ? null : target);
    setJumpValue("");
    finishToolbarAction();
  };

  useEffect(() => {
    if ((openToolbarMenu === "jump" && (!secondaryMenusFolded || toolbarCompact))
      || (openToolbarMenu === "settings" && (!secondaryMenusFolded || (toolbarCompact && !overflowOpen)))) {
      setOpenToolbarMenu(null);
    }
  }, [openToolbarMenu, overflowOpen, secondaryMenusFolded, toolbarCompact]);

  useEffect(() => {
    if (!openToolbarMenu) return;
    const dismissOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>("[data-cue-toolbar-menu-panel]");
      const trigger = target.closest<HTMLElement>("[data-cue-toolbar-menu-trigger]");
      const triggerMenu = trigger?.dataset.cueToolbarMenuTrigger;
      if (panel?.dataset.cueToolbarMenuPanel === openToolbarMenu
        || triggerMenu === openToolbarMenu) return;
      setOpenToolbarMenu(null);
    };
    document.addEventListener("mousedown", dismissOnOutsideMouseDown);
    return () => document.removeEventListener("mousedown", dismissOnOutsideMouseDown);
  }, [openToolbarMenu]);

  // ── Virtual scroll ────────────────────────────────────────────────────────
  const VSCROLL_BUFFER = 80;
  const DEFAULT_BLOCK_H = 80;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const botSpacerRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const cumulativeHRef = useRef<number[]>([0]);
  const [windowRange, setWindowRange] = useState(() => ({ start: 0, end: Math.min(160, blocks.length) }));
  const [spacerH, setSpacerH] = useState({ top: 0, bot: 0 });
  const pendingNavigateRef = useRef<
    { kind: "block"; id: string; align: ScrollLogicalPosition } | { kind: "scene"; id: string } | null
  >(null);
  const postNavCorrectionRef = useRef<
    { kind: "block"; id: string; align: ScrollLogicalPosition } | { kind: "scene"; id: string } | null
  >(null);
  const [correctionTick, setCorrectionTick] = useState(0);

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

  // Close comment panel when cue is deselected
  useEffect(() => {
    if (selection.kind === "none") {
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
  const activeCueList = useMemo(
    () => cueLists.find((list) => list.id === activeListId) ?? null,
    [cueLists, activeListId],
  );
  const canShareActive = activeListId !== null && localManageIds.has(activeListId);
  const visibleLists = useMemo(
    () => cueLists.filter(cl => visibleListIds.has(cl.id) || cl.id === activeListId),
    [cueLists, visibleListIds, activeListId],
  );
  const listColorIndex = useMemo(() => {
    const m = new Map<string, number>();
    cueLists.forEach((cl, i) => m.set(cl.id, i));
    return m;
  }, [cueLists]);

  const canEditActive = localEditableIds.has(activeListId ?? "");
  // Editing any cue requires an active list — prevents accidental edits with no context
  const canEditCue = useCallback((cue: Cue) =>
    cue.cueListId === activeListId && localEditableIds.has(cue.cueListId),
  [activeListId, localEditableIds]);

  // Phase 4: activate a cue list, showing access modal if not yet granted
  const handleActivateList = useCallback(async (listId: string | null) => {
    if (!listId || localEditableIds.has(listId)) {
      setActiveListId(listId);
      return;
    }
    const list = cueLists.find(cl => cl.id === listId);
    if (!list) { setActiveListId(listId); return; }
    setActiveListId(listId);
    setAccessModal({ listId, listName: list.name, status: "loading" });
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/access`,
        { credentials: "include" },
      );
      if (!res.ok) { setAccessModal(null); return; }
      const data = await res.json() as
        | { canAccess: true }
        | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "edit" | "manage" }
        | { canAccess: false; canSelfConfirm: false };
      if (data.canAccess) {
        setLocalEditableIds(prev => new Set([...prev, listId]));
        if ((data as { level?: string }).level === "manage") {
          setLocalManageIds(prev => new Set([...prev, listId]));
        }
        setAccessModal(null);
      } else if (data.canSelfConfirm) {
        setAccessModal({ listId, listName: list.name, status: "can_self_confirm", selfConfirmLevel: data.selfConfirmLevel });
      } else {
        setAccessModal({ listId, listName: list.name, status: "needs_approval" });
      }
    } catch {
      setAccessModal(null);
    }
  }, [cueLists, localEditableIds, productionId]);

  // ── updateCueField ────────────────────────────────────────────────────────
  const updateCueField = useCallback(async (
    cue: Cue,
    fields: { number?: string; name?: string; content?: string; warning?: boolean; start?: CueAnchor; end?: CueAnchor }
  ) => {
    setSavingCueId(cue.id);
    try {
      const vid = versionIdRef.current;
      const vParam = vid ? `?v=${encodeURIComponent(vid)}` : "";
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${cue.cueListId}/cues/${cue.id}${vParam}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        }
      );
      if (res.ok) {
        setCues(prev => prev.map(c => c.id === cue.id ? { ...c, ...fields } : c));
      } else if (res.status === 409) {
        const body = await res.json() as { error: string };
        alert(body.error || "修改被拒绝");
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
    // End handle marks use "${cueId}:end" to avoid guide-line querySelector collision;
    // strip the suffix here to get the real cue id (same pattern as handleMarkClick).
    const realCueId = cueId.endsWith(":end") ? cueId.slice(0, -4) : cueId;
    dragStateRef.current = {
      active: true, dragType, cueId: realCueId,
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
        const vid = versionIdRef.current;
        const vParam = vid ? `?v=${encodeURIComponent(vid)}` : "";
        const results = await Promise.all(
          listIds.map(listId =>
            fetch(`${BASE_PATH}/api/production/${productionId}/cuelists/${listId}/cues${vParam}`)
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
  const orphanedCues = useMemo(() => {
    if (!activeListId) return [];
    return cues.filter(cue => {
      if (cue.cueListId !== activeListId) return false;
      const startId = cue.start.kind === "block" ? cue.start.blockId : cue.start.afterBlockId;
      const endId   = cue.end.kind   === "block" ? cue.end.blockId   : cue.end.afterBlockId;
      return (startId !== null && !blockIndexMap.has(startId)) || (endId !== null && !blockIndexMap.has(endId));
    });
  }, [cues, blockIndexMap, activeListId]);

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
    // parseInt stops at the first non-digit, so "7.5" → 7, "1-0" → 1.
    // The old replace(/\D/g,"") was too greedy: "7.5"→75, "1-0"→10.
    const nums = existing.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    const next = nums.length ? Math.max(...nums) + 1 : 1;

    const vid = versionIdRef.current;
    const vParam = vid ? `?v=${encodeURIComponent(vid)}` : "";
    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${activeListId}/cues${vParam}`,
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
    const vid = versionIdRef.current;
    const vParam = vid ? `?v=${encodeURIComponent(vid)}` : "";
    const res = await fetch(
      `${BASE_PATH}/api/production/${productionId}/cuelists/${cue.cueListId}/cues/${cue.id}${vParam}`,
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

  // ── Virtual scroll hooks ──────────────────────────────────────────────────

  const rebuildCumulative = useCallback(() => {
    const measured = measuredHeightsRef.current;
    let avgH = DEFAULT_BLOCK_H;
    if (measured.size > 0) {
      let sum = 0;
      measured.forEach(h => { sum += h; });
      avgH = sum / measured.size;
    }
    const arr = new Array(blocks.length + 1);
    arr[0] = 0;
    for (let i = 0; i < blocks.length; i++) {
      arr[i + 1] = arr[i] + (measured.get(blocks[i].id) ?? avgH);
    }
    cumulativeHRef.current = arr;
  }, [blocks]);

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
    const container = scrollContainerRef.current;
    if (!container || blocks.length === 0) return;
    const sy = container.scrollTop;
    const viewStart = sy;
    const viewEnd = viewStart + container.clientHeight;
    const newStart = Math.max(0, blockAtOffset(viewStart) - VSCROLL_BUFFER);
    const newEnd = Math.min(blocks.length, blockAtOffset(viewEnd) + VSCROLL_BUFFER + 1);
    setWindowRange(prev =>
      prev.start === newStart && prev.end === newEnd ? prev : { start: newStart, end: newEnd }
    );
  }, [blocks.length]);

  // Always-fresh scroll-position saver (reads DOM directly; avoids stale cumulative-height estimates)
  const saveScrollPosRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveScrollPosRef.current = () => {
      const c = scrollContainerRef.current;
      if (!c || !productionId) return;
      const containerTop = c.getBoundingClientRect().top;
      // Find the last rendered block whose top edge is at or above the container's viewport top.
      let savedId: string | null = null;
      for (const el of c.querySelectorAll<HTMLElement>("[data-cue-bwrap]")) {
        if (el.getBoundingClientRect().top <= containerTop) savedId = el.dataset.cueBwrap ?? null;
        else break;
      }
      if (savedId) writeCookie(`cue_pos_${productionId}`, savedId);
    };
  });

  // Keep scrollLockedRef in sync
  useEffect(() => { scrollLockedRef.current = scrollLocked; }, [scrollLocked]);

  // Block user scroll while locked
  useEffect(() => {
    if (!scrollLocked) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const prevent = (e: Event) => e.preventDefault();
    const preventKeys = (e: Event) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes((e as globalThis.KeyboardEvent).key)) e.preventDefault();
    };
    container.addEventListener('wheel', prevent, { passive: false });
    container.addEventListener('touchmove', prevent, { passive: false });
    container.addEventListener('keydown', preventKeys);
    return () => {
      container.removeEventListener('wheel', prevent);
      container.removeEventListener('touchmove', prevent);
      container.removeEventListener('keydown', preventKeys);
    };
  }, [scrollLocked]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recomputeWindow);
      if (!scrollLockedRef.current) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveScrollPosRef.current(), 400);
        // User took control of scroll — abandon any pending post-navigation correction
        postNavCorrectionRef.current = null;
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    recomputeWindow();
    return () => { container.removeEventListener("scroll", onScroll); cancelAnimationFrame(rafId); clearTimeout(saveTimer); };
  }, [recomputeWindow]);

  useLayoutEffect(() => {
    setWindowRange(prev => ({
      start: Math.min(prev.start, Math.max(0, blocks.length - 1)),
      end: Math.min(prev.end, blocks.length),
    }));
  }, [blocks.length]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let changed = false;
    container.querySelectorAll<HTMLElement>("[data-cue-bwrap]").forEach(el => {
      const id = el.dataset.cueBwrap;
      if (!id) return;
      const h = el.offsetHeight;
      if (h > 0 && measuredHeightsRef.current.get(id) !== h) {
        measuredHeightsRef.current.set(id, h);
        changed = true;
      }
    });
    if (changed) {
      rebuildCumulative();
      recomputeWindow();
      if (postNavCorrectionRef.current) setCorrectionTick(t => t + 1);
    }
  });

  useLayoutEffect(() => {
    if (correctionTick === 0) return;
    const nav = postNavCorrectionRef.current;
    if (!nav) return;
    postNavCorrectionRef.current = null;
    const el = nav.kind === "block"
      ? document.getElementById(`cue-block-${nav.id}`)
      : document.getElementById(`cue-scene-${nav.id}`);
    if (!el) return;
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    el.scrollIntoView({ behavior: "instant", block: nav.kind === "block" ? nav.align : "start" });
    setScrollLocked(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionTick, windowRange]);

  useLayoutEffect(() => {
    const nav = pendingNavigateRef.current;
    if (!nav) return;
    const el = nav.kind === "block"
      ? document.getElementById(`cue-block-${nav.id}`)
      : document.getElementById(`cue-scene-${nav.id}`);
    if (!el) return;
    pendingNavigateRef.current = null;
    rebuildCumulative();
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const newTop = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total  = cum[n] ?? n * DEFAULT_BLOCK_H;
    const newBot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    if (topSpacerRef.current) topSpacerRef.current.style.height = `${newTop}px`;
    if (botSpacerRef.current) botSpacerRef.current.style.height = `${newBot}px`;
    el.scrollIntoView({ behavior: "instant", block: nav.kind === "block" ? nav.align : "start" });
    postNavCorrectionRef.current = nav;
  }, [windowRange, rebuildCumulative, blocks.length]);

  useLayoutEffect(() => {
    const cum = cumulativeHRef.current;
    const n = blocks.length;
    const top = cum[windowRange.start] ?? windowRange.start * DEFAULT_BLOCK_H;
    const total = cum[n] ?? n * DEFAULT_BLOCK_H;
    const bot = Math.max(0, total - (cum[windowRange.end] ?? windowRange.end * DEFAULT_BLOCK_H));
    setSpacerH(prev => prev.top === top && prev.bot === bot ? prev : { top, bot });
  }, [windowRange, blocks.length]);

  // ── Navigation functions ──────────────────────────────────────────────────

  const scrollToBlockIdx = useCallback((idx: number, align: ScrollLogicalPosition = "center") => {
    if (idx < 0 || idx >= blocks.length) return;
    const block = blocks[idx];
    const el = document.getElementById(`cue-block-${block.id}`);
    if (el) { el.scrollIntoView({ behavior: "instant", block: align }); return; }
    pendingNavigateRef.current = { kind: "block", id: block.id, align };
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocks.length, idx + VSCROLL_BUFFER + 1),
    });
  }, [blocks]);

  // ── Cookie: restore scroll position once on mount ────────────────────────
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    // Fallback: unlock 300ms after mount (covers immediate restore and no-save cases)
    const unlockTimer = setTimeout(() => setScrollLocked(false), 300);
    if (scrollRestoredRef.current) return () => clearTimeout(unlockTimer);
    scrollRestoredRef.current = true;
    const savedId = readCookie(`cue_pos_${productionId}`);
    if (!savedId) return () => clearTimeout(unlockTimer);
    const idx = blocks.findIndex(b => b.id === savedId);
    if (idx >= 0) scrollToBlockIdx(idx, "start");
    return () => clearTimeout(unlockTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToBlockIdx]);

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

  // ── Clear cue highlight on scroll or click ───────────────────────────────
  useEffect(() => {
    if (!highlightedCueId) return;
    const clear = () => setHighlightedCueId(null);
    const container = scrollContainerRef.current;
    const timer = setTimeout(() => {
      if (container) container.addEventListener("scroll", clear, { passive: true });
      document.addEventListener("click", clear);
    }, 400);
    return () => {
      clearTimeout(timer);
      if (container) container.removeEventListener("scroll", clear);
      document.removeEventListener("click", clear);
    };
  }, [highlightedCueId]);


  const scrollToScene = useCallback((sceneId: string) => {
    const el = document.getElementById(`cue-scene-${sceneId}`);
    if (el) { el.scrollIntoView({ behavior: "instant", block: "start" }); return; }
    const idx = blocks.findIndex(b => b.sceneId === sceneId);
    if (idx < 0) return;
    pendingNavigateRef.current = { kind: "scene", id: sceneId };
    setWindowRange({
      start: Math.max(0, idx - VSCROLL_BUFFER),
      end: Math.min(blocks.length, idx + VSCROLL_BUFFER + 1),
    });
  }, [blocks]);

  const jumpToLine = useCallback((n: number) => {
    scrollToBlockIdx(Math.max(0, Math.min(n - 1, blocks.length - 1)), "center");
  }, [blocks.length, scrollToBlockIdx]);

  const jumpToPage = useCallback((n: number) => {
    const idx = blocks.findIndex(b => pageMap[b.id] === n);
    if (idx >= 0) scrollToBlockIdx(idx, "start");
  }, [blocks, pageMap, scrollToBlockIdx]);

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
      const nums = existing.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const vid = versionIdRef.current;
      const vParam = vid ? `?v=${encodeURIComponent(vid)}` : "";
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/cuelists/${activeListId}/cues${vParam}`,
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
          versionId={versionId}
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
                        const res = await fetch(
                          `${BASE_PATH}/api/production/${productionId}/cuelists/${accessModal.listId}/access`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({ action: "self_confirm", level: accessModal.selfConfirmLevel }),
                          },
                        );
                        if (res.ok) {
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

// ─── ShareModal ───────────────────────────────────────────────────────────────

import type { CueListGrant, CueListDeptAccess } from "@/lib/cue-list-types";
import type { MemberWithRoles } from "@/lib/db";

const SM_GRANT_LEVELS = [
  { value: "view",  label: "查看" },
  { value: "mount", label: "挂载资产" },
  { value: "edit",  label: "编辑" },
  { value: "manage", label: "管理" },
] as const;
const SM_LEVEL_LABEL: Record<string, string> = Object.fromEntries(SM_GRANT_LEVELS.map(l => [l.value, l.label]));

function ShareModal({
  productionId, cueListId, cueListName, onClose,
}: {
  productionId: string;
  cueListId: string;
  cueListName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [grants, setGrants] = useState<CueListGrant[]>([]);
  const [deptAccess, setDeptAccess] = useState<CueListDeptAccess[]>([]);
  const [productionDepts, setProductionDepts] = useState<{ id: string; name: string }[]>([]);
  const [members, setMembers] = useState<MemberWithRoles[]>([]);
  const [saving, setSaving] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddDept, setShowAddDept] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [pendingUser, setPendingUser] = useState<{ userId: string; name: string } | null>(null);

  const COLLAB_BASE = `${BASE_PATH}/api/production/${productionId}/cuelists/${cueListId}/collaborators`;

  useEffect(() => {
    void (async () => {
      const [collabRes, membersRes] = await Promise.all([
        fetch(COLLAB_BASE, { credentials: "include" }),
        fetch(`${BASE_PATH}/api/production/${productionId}/contacts`, { credentials: "include" }),
      ]);
      if (collabRes.ok) {
        const d = await collabRes.json() as { grants: CueListGrant[]; deptAccess: CueListDeptAccess[]; productionDepts: { id: string; name: string }[] };
        setGrants(d.grants); setDeptAccess(d.deptAccess); setProductionDepts(d.productionDepts);
      }
      if (membersRes.ok) setMembers(await membersRes.json() as MemberWithRoles[]);
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const postCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const res = await fetch(COLLAB_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" });
      if (res.ok) { const d = await res.json() as { grants: CueListGrant[]; deptAccess: CueListDeptAccess[] }; setGrants(d.grants); setDeptAccess(d.deptAccess); }
    } finally { setSaving(false); }
  };

  const deleteCollaborator = async (body: object) => {
    setSaving(true);
    try {
      const res = await fetch(COLLAB_BASE, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" });
      if (res.ok) { const d = await res.json() as { grants: CueListGrant[]; deptAccess: CueListDeptAccess[] }; setGrants(d.grants); setDeptAccess(d.deptAccess); }
    } finally { setSaving(false); }
  };

  const grantedUserIds = new Set(grants.map(g => g.userId));
  const addedDeptIds = new Set(deptAccess.map(d => d.deptId));
  const availableDepts = productionDepts.filter(d => !addedDeptIds.has(d.id));
  const availableMembers = members.filter(m =>
    !grantedUserIds.has(m.userId) &&
    (userSearch === "" || m.name.includes(userSearch))
  );

  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--line)" };
  const removeBtnStyle: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, border: 0, background: "transparent", fontSize: 11, color: "var(--muted)", cursor: saving ? "default" : "pointer", padding: "2px 6px", borderRadius: 5 };
  const addBtnStyle: React.CSSProperties = { border: "1px dashed var(--line)", background: "transparent", borderRadius: 7, padding: "5px 10px", fontSize: 11, color: "var(--muted)", cursor: "pointer", width: "100%", textAlign: "left" as const, marginTop: 4 };
  const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" as const, color: "var(--muted)", marginBottom: 6 };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.25)", zIndex: 70 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: "min(480px, calc(100vw - 32px))", maxHeight: "calc(100vh - 80px)",
        background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)",
        boxShadow: "0 12px 40px rgba(24,42,42,.18)", zIndex: 71,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <div>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 2 }}>分享协作</p>
            <h2 style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>{cueListName}</h2>
          </div>
          <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 18, cursor: "pointer", color: "var(--muted)", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8 }}>×</button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "24px 0" }}>加载中…</p>
          ) : (
            <>
              <div>
                <p style={labelStyle}>部门自助访问</p>
                {deptAccess.length === 0 && <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无部门</p>}
                {deptAccess.map(d => (
                  <div key={d.deptId} style={rowStyle}>
                    <span style={{ fontSize: 12, color: "var(--ink)" }}>{d.deptName}</span>
                    <button style={removeBtnStyle} disabled={saving} onClick={() => deleteCollaborator({ type: "dept", deptId: d.deptId })}>移除</button>
                  </div>
                ))}
                {!showAddDept && availableDepts.length > 0 && (
                  <button style={addBtnStyle} onClick={() => setShowAddDept(true)}>+ 添加部门</button>
                )}
                {showAddDept && (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                    {availableDepts.map(d => (
                      <button key={d.id} disabled={saving}
                        style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: "var(--surface-2)", color: "var(--ink)", cursor: saving ? "default" : "pointer", textAlign: "left" }}
                        onClick={async () => { await postCollaborator({ type: "dept", deptId: d.id }); setShowAddDept(false); }}>
                        {d.name}
                      </button>
                    ))}
                    <button style={{ ...addBtnStyle, marginTop: 2 }} onClick={() => setShowAddDept(false)}>取消</button>
                  </div>
                )}
                <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>添加部门后，该部门符合条件的成员可自助确认访问</p>
              </div>

              <div>
                <p style={labelStyle}>个人直接授权</p>
                {grants.length === 0 && <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginBottom: 4 }}>暂无个人授权</p>}
                {grants.map(g => (
                  <div key={g.userId + g.level} style={rowStyle}>
                    <span style={{ fontSize: 12, color: "var(--ink)", flex: 1, minWidth: 0 }}>{g.userName}</span>
                    <OverflowSafeSelect
                      value={g.level}
                      disabled={saving}
                      onChange={async (e) => { await postCollaborator({ type: "user", userId: g.userId, level: e.target.value }); }}
                      style={{ fontSize: 11, border: "1px solid var(--line)", borderRadius: 5, padding: "2px 4px", background: "var(--surface)", color: "var(--ink)", cursor: saving ? "default" : "pointer" }}>
                      {SM_GRANT_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </OverflowSafeSelect>
                    <button style={removeBtnStyle} disabled={saving}
                      onClick={() => deleteCollaborator({ type: "user", userId: g.userId })}>
                      移除
                    </button>
                  </div>
                ))}
                {!showAddUser && (
                  <button style={addBtnStyle} onClick={() => { setShowAddUser(true); setUserSearch(""); setPendingUser(null); }}>+ 添加成员</button>
                )}
                {showAddUser && (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                    {!pendingUser ? (
                      <>
                        <input
                          autoFocus placeholder="搜索姓名…" value={userSearch} onChange={e => setUserSearch(e.target.value)}
                          style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, outline: "none", background: "var(--surface)", color: "var(--ink)", marginBottom: 2 }}
                        />
                        {userSearch === ""
                          ? <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>输入姓名搜索成员…</p>
                          : availableMembers.length === 0
                          ? <p style={{ fontSize: 11, color: "var(--muted)", padding: "4px 2px" }}>无匹配成员</p>
                          : availableMembers.map(m => (
                            <button key={m.userId} disabled={saving}
                              style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: "var(--surface-2)", color: "var(--ink)", cursor: saving ? "default" : "pointer", textAlign: "left" }}
                              onClick={() => setPendingUser({ userId: m.userId, name: m.name })}>
                              <span>{m.name}</span>
                              {m.roles.length > 0 && <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{m.roles.slice(0, 2).join("、")}</span>}
                            </button>
                          ))
                        }
                      </>
                    ) : (
                      <>
                        <p style={{ fontSize: 12, color: "var(--ink)", padding: "4px 2px", fontWeight: 600 }}>
                          {pendingUser.name} — 选择权限
                        </p>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 2 }}>
                          {SM_GRANT_LEVELS.map(l => (
                            <button key={l.value} disabled={saving}
                              style={{ borderRadius: 6, border: "1px solid var(--line)", padding: "4px 12px", fontSize: 11, cursor: saving ? "default" : "pointer", background: "var(--surface-2)", color: "var(--ink)" }}
                              onClick={async () => {
                                await postCollaborator({ type: "user", userId: pendingUser.userId, level: l.value });
                                setShowAddUser(false); setUserSearch(""); setPendingUser(null);
                              }}>
                              {l.label}
                            </button>
                          ))}
                        </div>
                        <button style={{ ...addBtnStyle, marginTop: 0 }} onClick={() => setPendingUser(null)}>← 返回</button>
                      </>
                    )}
                    <button style={{ ...addBtnStyle, marginTop: 2 }} onClick={() => { setShowAddUser(false); setUserSearch(""); setPendingUser(null); }}>取消</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
