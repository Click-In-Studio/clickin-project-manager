"use client";

import { useState, useEffect } from "react";
import { fetchCueComments } from "@/lib/ops/cue-client";
import type { Comment, Selection } from "./types";

/** cue 评论列表与当前打开评论面板的 cue。从 CuePage 主函数体原样搬出（#487 C2）。 */
export function useCueComments({ productionId, selection }: { productionId: string; selection: Selection }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentCueId, setActiveCommentCueId] = useState<string | null>(null);

  useEffect(() => {
    fetchCueComments<Comment>(productionId).then((list) => { if (list) setComments(list); });
  }, [productionId]);

  // Close comment panel when cue is deselected
  useEffect(() => {
    if (selection.kind === "none") {
      setActiveCommentCueId(null);
    }
  }, [selection]);

  return { comments, setComments, activeCommentCueId, setActiveCommentCueId };
}
