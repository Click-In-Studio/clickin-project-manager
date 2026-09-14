"use client";

import React from "react";
import { EMPTY_BLOCK_ASSETS, type Comment, type BlockAssetBubbleItem } from "./comments";
import { COMMENT_BUBBLE_MIN_WIDTH_PX } from "./constants";

export default function CommentBubble({
  comments,
  assets,
  active,
  offsetY = 0,
  mode,
  width,
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
  mode: "full" | "compact" | null;
  width: number;
  blockLabel: string;
  captionBody: string;
  onCommentClick: () => void;
  onAssetClick: () => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  if ((comments.length === 0 && assets.length === 0) || mode === null) return null;

  if (active) return null;

  let visibleComments: Array<{ comment: Comment; reply: boolean }> = [];
  let visibleAssets = EMPTY_BLOCK_ASSETS;
  let hiddenCommentCount = 0;
  let hiddenAssetCount = 0;
  if (mode === "full") {
    const sortedComments = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const childrenByParent = new Map<string, Comment[]>();
    for (const comment of sortedComments) {
      if (!comment.parentId) continue;
      const replies = childrenByParent.get(comment.parentId) ?? [];
      replies.push(comment);
      childrenByParent.set(comment.parentId, replies);
    }
    const commentIds = new Set(sortedComments.map(comment => comment.id));
    const orderedComments: Array<{ comment: Comment; reply: boolean }> = [];
    for (const comment of sortedComments.filter(c => c.parentId === null)) {
      orderedComments.push({ comment, reply: false });
      for (const reply of childrenByParent.get(comment.id) ?? []) {
        orderedComments.push({ comment: reply, reply: true });
      }
    }
    for (const orphanReply of sortedComments.filter(c => c.parentId !== null && !commentIds.has(c.parentId))) {
      orderedComments.push({ comment: orphanReply, reply: true });
    }
    const visibleCommentLimit = assets.length > 0 ? Math.min(3, orderedComments.length) : 4;
    visibleComments = orderedComments.slice(0, visibleCommentLimit);
    visibleAssets = assets.slice(0, 4 - visibleComments.length);
    hiddenCommentCount = orderedComments.length - visibleComments.length;
    hiddenAssetCount = assets.length - visibleAssets.length;
  }
  const defaultAction = comments.length > 0 ? onCommentClick : onAssetClick;
  const handleClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  return (
    <div
      className="absolute left-full top-1/2 z-0 ml-6"
      style={{ transform: mode === "compact" ? "translateY(-50%)" : `translateY(calc(-50% + ${offsetY}px))` }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div
        className={`relative z-10 flex max-h-40 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-colors hover:border-zinc-300 ${mode === "compact" ? "w-max" : ""}`}
        style={mode === "compact"
          ? { maxWidth: width }
          : { width, minWidth: COMMENT_BUBBLE_MIN_WIDTH_PX }}
      >
        {mode === "compact" ? (
          <div className="flex items-center justify-center gap-2 whitespace-nowrap px-2 py-1.5 text-[10px] font-medium text-zinc-600">
            {comments.length > 0 && (
              <button type="button" onClick={(e) => handleClick(e, onCommentClick)} className="hover:text-zinc-900">
                评 {comments.length}
              </button>
            )}
            {assets.length > 0 && (
              <button type="button" onClick={(e) => handleClick(e, onAssetClick)} className="hover:text-zinc-900">
                附 {assets.length}
              </button>
            )}
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
