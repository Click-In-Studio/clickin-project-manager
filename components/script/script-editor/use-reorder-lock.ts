"use client";

import { useState, useRef, useLayoutEffect, useCallback } from "react";
import type { Block } from "@/lib/script/script-types";

/**
 * 重排锁：拖拽落下到块序提交期间锁住重排相关交互，提交后下一帧解锁；
 * 加一条 1.8s 自动消失的提示文案。从 ScriptEditor 主函数体原样搬出（#487 S6）。
 * frame / timer 的 ref 一并交出：离开页面与卸载时主体要统一取消。
 */
export function useReorderLock({ blocks }: { blocks: Block[] }) {
  const [isReorderLocked, setIsReorderLocked] = useState(false);
  const [reorderNotice, setReorderNotice] = useState("");
  const isReorderLockedRef = useRef(false);
  const reorderUnlockFrame = useRef<number | null>(null);
  const pendingReorderUnlockRef = useRef(false);
  const reorderNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return {
    isReorderLocked, reorderNotice, isReorderLockedRef, reorderUnlockFrame, reorderNoticeTimer,
    lockReorder, unlockReorder, unlockReorderAfterCommit, showReorderNotice,
  };
}
