"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import type { Block } from "@/lib/script/script-types";

/** 历史仍只保存块快照；恢复章节等派生状态交给正文更新入口。 */
export function useScriptHistory(readBlocks: () => Block[], restore: (blocks: Block[]) => void) {
  const callbacks = useRef({ readBlocks, restore });
  callbacks.current = { readBlocks, restore };
  const state = useRef({ undo: [] as Block[][], redo: [] as Block[][], typing: false, timer: null as ReturnType<typeof setTimeout> | null });
  const [availability, setAvailability] = useState({ canUndo: false, canRedo: false });
  const publish = useCallback(() => {
    setAvailability({ canUndo: state.current.undo.length > 0, canRedo: state.current.redo.length > 0 });
  }, []);
  const endTyping = useCallback(() => {
    if (state.current.timer !== null) clearTimeout(state.current.timer);
    state.current.timer = null;
    state.current.typing = false;
  }, []);
  const record = useCallback(() => {
    state.current.undo.push(callbacks.current.readBlocks());
    state.current.redo = [];
    publish();
  }, [publish]);
  const startTyping = useCallback(() => {
    if (!state.current.typing) { record(); state.current.typing = true; }
    if (state.current.timer !== null) clearTimeout(state.current.timer);
    state.current.timer = setTimeout(endTyping, 800);
  }, [endTyping, record]);
  const undo = useCallback(() => {
    endTyping();
    const blocks = state.current.undo.pop();
    if (!blocks) return;
    state.current.redo.push(callbacks.current.readBlocks());
    callbacks.current.restore(blocks);
    publish();
  }, [endTyping, publish]);
  const redo = useCallback(() => {
    endTyping();
    const blocks = state.current.redo.pop();
    if (!blocks) return;
    state.current.undo.push(callbacks.current.readBlocks());
    callbacks.current.restore(blocks);
    publish();
  }, [endTyping, publish]);
  const reset = useCallback(() => {
    endTyping();
    state.current.undo = [];
    state.current.redo = [];
    publish();
  }, [endTyping, publish]);
  useEffect(() => endTyping, [endTyping]);
  return useMemo(() => ({ ...availability, record, startTyping, endTyping, undo, redo, reset }), [availability, record, startTyping, endTyping, undo, redo, reset]);
}
