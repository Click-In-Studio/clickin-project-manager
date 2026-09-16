"use client";

import { useRef, useEffect, useCallback, type RefObject } from "react";

/**
 * 多选拖拽时跟着鼠标走的「N」计数徽标：直接改 DOM 不走 state（拖拽事件每帧都来）。
 * 浏览器在 dragend 前不一定给 mouseup，所以用 drag/dragover 的 buttons 位判断松键。
 * 从 ScriptEditor 主函数体原样搬出（#487 S6）。
 */
export function useDragCountBadge({ blocksContainerRef }: { blocksContainerRef: RefObject<HTMLDivElement | null> }) {
  const dragCountBadgeRef = useRef<HTMLDivElement>(null);
  const dragButtonDownSeenRef = useRef(false);
  const dragButtonReleasedRef = useRef(false);

  const clearDragCountBadge = useCallback(() => {
    dragButtonReleasedRef.current = true;
    dragButtonDownSeenRef.current = false;
    const badge = dragCountBadgeRef.current;
    if (badge) badge.hidden = true;
  }, []);

  useEffect(() => {
    const clearIfDragButtonReleased = (event: globalThis.DragEvent) => {
      if (event.buttons > 0) {
        dragButtonDownSeenRef.current = true;
        return;
      }
      if (!dragButtonDownSeenRef.current || event.buttons !== 0) return;
      clearDragCountBadge();
    };
    document.addEventListener("drag", clearIfDragButtonReleased, true);
    document.addEventListener("dragend", clearDragCountBadge, true);
    document.addEventListener("dragover", clearIfDragButtonReleased, true);
    document.addEventListener("drop", clearDragCountBadge, true);
    document.addEventListener("pointerup", clearDragCountBadge, true);
    document.addEventListener("mouseup", clearDragCountBadge, true);
    window.addEventListener("drag", clearIfDragButtonReleased, true);
    window.addEventListener("dragover", clearIfDragButtonReleased, true);
    window.addEventListener("pointerup", clearDragCountBadge, true);
    window.addEventListener("mouseup", clearDragCountBadge, true);
    return () => {
      document.removeEventListener("drag", clearIfDragButtonReleased, true);
      document.removeEventListener("dragend", clearDragCountBadge, true);
      document.removeEventListener("dragover", clearIfDragButtonReleased, true);
      document.removeEventListener("drop", clearDragCountBadge, true);
      document.removeEventListener("pointerup", clearDragCountBadge, true);
      document.removeEventListener("mouseup", clearDragCountBadge, true);
      window.removeEventListener("drag", clearIfDragButtonReleased, true);
      window.removeEventListener("dragover", clearIfDragButtonReleased, true);
      window.removeEventListener("pointerup", clearDragCountBadge, true);
      window.removeEventListener("mouseup", clearDragCountBadge, true);
    };
  }, [clearDragCountBadge]);


  const updateDragCountBadge = useCallback((clientX: number, clientY: number, count: number, buttons?: number) => {
    if (buttons !== undefined) {
      if (buttons > 0) dragButtonDownSeenRef.current = true;
      if (dragButtonDownSeenRef.current && buttons === 0) {
        clearDragCountBadge();
        return;
      }
    }
    if (dragButtonReleasedRef.current || count <= 1) {
      clearDragCountBadge();
      return;
    }
    const rect = blocksContainerRef.current?.getBoundingClientRect();
    const midpoint = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const side = clientX > midpoint ? "left" : "right";
    const badge = dragCountBadgeRef.current;
    if (!badge) return;
    badge.textContent = String(count);
    badge.style.left = `${side === "right" ? clientX + 16 : clientX - 16}px`;
    badge.style.top = `${clientY}px`;
    badge.style.transform = side === "right" ? "" : "translateX(-100%)";
    badge.hidden = false;
  }, [clearDragCountBadge, blocksContainerRef]);

  return { dragCountBadgeRef, dragButtonDownSeenRef, dragButtonReleasedRef, clearDragCountBadge, updateDragCountBadge };
}
