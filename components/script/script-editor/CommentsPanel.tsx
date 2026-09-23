"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommentAssetPicker, { type PendingAsset } from "@/components/assets/CommentAssetPicker";
import MountPointAssets from "@/components/assets/MountPointAssets";
import SmartTextarea from "@/components/editor/SmartTextarea";
import SmartText from "@/components/ui/SmartText";
import { useShortcutLabel } from "@/components/ui/shortcut-label";
import { BASE_PATH } from "@/lib/base-path";
import { postScriptComment, patchScriptComment, deleteScriptComment } from "@/lib/script/script-client";
import SideBlockPanel from "./SideBlockPanel";
import type { Mention, Comment, CommentBlockCaption, SideBlockPanelNavigation, BlockSidePanelKind, CommentDraft } from "./comments";

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export type CommentsPanelProps = {
  blockId: string; productionId: string; comments: Comment[];
  currentUserId: string; isAdmin: boolean;
  onAdd: (c: Comment) => void; onEdit: (c: Comment) => void;
  onDelete: (id: string) => void; onClose: () => void;
  onNavigate?: () => void;
  onPanelChange: (panel: BlockSidePanelKind) => void;
  draft?: CommentDraft;
  onDraftChange: (blockId: string, draft: CommentDraft) => void;
  width: number;
  blockCaption?: CommentBlockCaption | null;
  navigation?: SideBlockPanelNavigation;
};

export default function CommentsPanel({
  blockId, productionId, comments, currentUserId, isAdmin,
  onAdd, onEdit, onDelete, onClose, onNavigate,
  onPanelChange, draft, onDraftChange,
  width,
  blockCaption,
  navigation,
}: CommentsPanelProps) {
  const submitKey = useShortcutLabel("Mod+Enter");
  const [members, setMembers] = useState<Mention[]>([]);
  const [newText, setNewText] = useState(draft?.text ?? "");
  const [newMentions, setNewMentions] = useState<Mention[]>(draft?.mentions ?? []);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyMentions, setReplyMentions] = useState<Mention[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingNewAssets, setPendingNewAssets] = useState<PendingAsset[]>([]);
  const [pendingReplyAssets, setPendingReplyAssets] = useState<PendingAsset[]>([]);
  const draftRef = useRef<CommentDraft>(draft ?? { text: "", mentions: [] });

  const updateDraft = (patch: Partial<CommentDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    onDraftChange(blockId, next);
  };

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
      const created = await postScriptComment<Comment>(productionId, { blockId, body: opts.text, parentId: opts.parentId ?? null, mentions: opts.mentions });
      if (created) return created;
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
      const emptyDraft = { text: "", mentions: [] };
      draftRef.current = emptyDraft;
      onDraftChange(blockId, emptyDraft);
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
    const updated = await patchScriptComment<Comment>(productionId, id, text);
    if (updated) { onEdit(updated); setEditingId(null); }
  };

  const doDelete = async (id: string) => {
    if (await deleteScriptComment(productionId, id)) onDelete(id);
  };

  const startReply = (parentId: string, authorUserId: string, authorName: string) => {
    setReplyingTo(parentId);
    setReplyText(`@${authorName} `);
    setReplyMentions([{ userId: authorUserId, name: authorName }]);
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
      activePanel="comment"
      onPanelChange={onPanelChange}
      blockCaption={blockCaption}
      width={width}
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
                onClick: () => replyingTo === topC.id ? setReplyingTo(null) : startReply(topC.id, topC.userId, topC.authorName),
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
                  onClick: () => startReply(topC.id, r.userId, r.authorName),
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
                  placeholder={`回复… (${submitKey} 发布)`} rows={2} autoFocus
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
        <SmartTextarea value={newText} onChange={value => { setNewText(value); updateDraft({ text: value }); }}
          memberMention={{ members, onMentionsChange: mentions => { setNewMentions(mentions); updateDraft({ mentions }); } }}
          placeholder={`添加评论… (${submitKey} 发布)`} rows={3}
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
