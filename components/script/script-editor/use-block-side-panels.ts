"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { Comment, CommentDraft, BlockSidePanelKind, BlockAssetBubbleItem } from "./comments";

/**
 * 块侧栏：评论列表（按块分组）、资产气泡、当前打开的评论 / 资产面板、标签编辑器开合、
 * 评论草稿。从 ScriptEditor 主函数体原样搬出（#487 S7）。
 */
export function useBlockSidePanels({ productionId }: { productionId: string | undefined }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [blockAssetsByBlockId, setBlockAssetsByBlockId] = useState<Map<string, BlockAssetBubbleItem[]>>(new Map());
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
  const [activeAssetBlockId, setActiveAssetBlockId] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagEditorOnTop, setTagEditorOnTop] = useState(false);
  const commentDraftsRef = useRef(new Map<string, CommentDraft>());
  const updateCommentDraft = useCallback((blockId: string, draft: CommentDraft) => {
    if (draft.text.length > 0) commentDraftsRef.current.set(blockId, draft);
    else commentDraftsRef.current.delete(blockId);
  }, []);
  const openBlockSidePanel = useCallback((panel: BlockSidePanelKind, blockId: string) => {
    setActiveCommentBlockId(panel === "comment" ? blockId : null);
    setActiveAssetBlockId(panel === "asset" ? blockId : null);
    setTagEditorOnTop(false);
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
    // #420：挂载锚稳定 block_id，服务端无版本分辨路径，不再传 ?v=
    fetch(`${BASE_PATH}/api/production/${productionId}/assets/block-summary`)
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
  }, [productionId]);

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

  return {
    comments, setComments, blockAssetsByBlockId, loadBlockAssetBubbles, commentsByBlockId,
    activeCommentBlockId, setActiveCommentBlockId, activeAssetBlockId, setActiveAssetBlockId,
    tagEditorOpen, setTagEditorOpen, tagEditorOnTop, setTagEditorOnTop,
    commentDraftsRef, updateCommentDraft, openBlockSidePanel,
  };
}
