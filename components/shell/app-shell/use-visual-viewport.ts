"use client";

import { useEffect } from "react";

type AppViewportSnapshot = {
  height: number;
  offsetTop: number;
};

export type AppViewportState = {
  visibleHeight: number;
  bottomInset: number;
  editing: boolean;
  keyboardOpen: boolean;
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, [contenteditable]");
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(editable.type);
  }
  return editable.getAttribute("contenteditable") !== "false";
}

export function ensureEditableTargetVisible(
  target: Element | null,
  viewport: AppViewportSnapshot,
  padding = 12,
): boolean {
  if (!(target instanceof HTMLElement) || !isEditableTarget(target)) return false;
  let scrollContainer: HTMLElement | null = target.parentElement;
  while (scrollContainer && scrollContainer !== document.documentElement) {
    const overflowY = window.getComputedStyle(scrollContainer).overflowY;
    if (/^(auto|scroll)$/.test(overflowY) && scrollContainer.scrollHeight > scrollContainer.clientHeight) break;
    scrollContainer = scrollContainer.parentElement;
  }
  if (!scrollContainer || scrollContainer === document.documentElement) return false;

  const rect = target.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  // Safari 在键盘平移 Visual Viewport 时，不同版本对 client rect 是否已包含
  // offsetTop 的处理并不一致。不要混用两种坐标：优先拿实际承载工作面的矩形，
  // 与目标、滚动容器的 client rect 在同一坐标系内求交。
  const viewportSurface = target.closest<HTMLElement>(
    ".app-mobile-input-overlay, .agent-mobile-full, .app-shell-frame",
  );
  const surfaceRect = viewportSurface?.getBoundingClientRect();
  const viewportTop = surfaceRect?.top ?? viewport.offsetTop;
  const viewportBottom = surfaceRect?.bottom ?? viewport.offsetTop + viewport.height;
  const visibleTop = Math.max(viewportTop, containerRect.top) + padding;
  const visibleBottom = Math.min(viewportBottom, containerRect.bottom) - padding;

  // 富文本根节点可能比整个视口还高；这类编辑器应按光标自行定位，不能把
  // 整个 contenteditable 根节点滚进视口，否则会直接跳到长文档边界。
  if (visibleBottom <= visibleTop || rect.height >= visibleBottom - visibleTop) return false;
  if (rect.top >= visibleTop && rect.bottom <= visibleBottom) return false;

  // 只移动离焦点最近的业务滚动面；scrollIntoView 会继续滚动外层页面，和
  // Safari 的 Visual Viewport 自动平移叠加后会出现二次跳动。
  scrollContainer.scrollTop += rect.top < visibleTop
    ? rect.top - visibleTop
    : rect.bottom - visibleBottom;
  return true;
}

export function deriveAppViewportState(
  viewport: AppViewportSnapshot,
  layoutHeight: number,
  editing: boolean,
  focusBaselineHeight: number | null,
): AppViewportState {
  const visibleHeight = Math.min(viewport.height, layoutHeight);
  return {
    visibleHeight,
    bottomInset: Math.max(0, layoutHeight - viewport.height - viewport.offsetTop),
    editing,
    keyboardOpen: editing && focusBaselineHeight !== null && visibleHeight < focusBaselineHeight,
  };
}

export function writeAppViewportCssVariables(
  target: HTMLElement,
  viewport: AppViewportSnapshot,
  layoutHeight: number,
  editing = false,
  focusBaselineHeight: number | null = null,
) {
  // 部分 Android WebView / 厂商浏览器会暴露 VisualViewport，却仍返回收起浏览器栏
  // 后的大高度；innerHeight 在这些实现里反而是当前可见高度。两者取小，宁可留下
  // 少量可滚动空间，也不能把底栏放到屏幕外并被 body 的 overflow-hidden 截断。
  const state = deriveAppViewportState(viewport, layoutHeight, editing, focusBaselineHeight);
  target.style.setProperty("--app-visual-viewport-height", `${state.visibleHeight}px`);
  target.style.setProperty("--app-visual-viewport-offset-top", `${viewport.offsetTop}px`);
  target.style.setProperty("--app-visual-viewport-bottom-inset", `${state.bottomInset}px`);
  target.dataset.appEditing = state.editing ? "true" : "false";
  target.dataset.appKeyboardOpen = state.keyboardOpen ? "true" : "false";
  return state;
}

/**
 * 移动端可见视口的唯一浏览器接线点。
 *
 * CSS 的 100dvh 负责 SSR 首屏；hydration 后用 Visual Viewport 的真实像素值
 * 覆盖它。编辑焦点与聚焦前高度也在这里归约，业务组件只消费根节点状态，
 * 不再各自判断软键盘或注册第二套视口监听。
 */
export function useAppViewportState(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const target = document.documentElement;
    const viewport = window.visualViewport;
    let animationFrame = 0;
    let focusFrame = 0;
    let editing = isEditableTarget(document.activeElement);
    let focusBaselineHeight = editing ? Math.max(viewport?.height ?? 0, window.innerHeight) : null;
    let resetBaseline = false;

    const write = () => {
      animationFrame = 0;
      if (resetBaseline) {
        focusBaselineHeight = editing ? Math.max(viewport?.height ?? 0, window.innerHeight) : null;
        resetBaseline = false;
      }
      const state = writeAppViewportCssVariables(
        target,
        viewport ?? { height: window.innerHeight, offsetTop: 0 },
        window.innerHeight,
        editing,
        focusBaselineHeight,
      );
      if (state.keyboardOpen) {
        // CSS 变量写入后读取布局，并在同一帧只校正所属业务滚动面。键盘动画
        // 后不再追加第二帧的整页 scrollIntoView，避免可见的二次跳动。
        ensureEditableTargetVisible(
          document.activeElement,
          viewport ?? { height: window.innerHeight, offsetTop: 0 },
        );
      }
    };
    const scheduleWrite = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(write);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isEditableTarget(event.target)) return;
      if (focusFrame) {
        window.cancelAnimationFrame(focusFrame);
        focusFrame = 0;
      }
      const wasEditing = editing;
      editing = true;
      // 键盘打开后切换输入框仍属于同一轮编辑，必须保留聚焦前高度；否则会
      // 把当前已缩小的视口误当成新基线，短暂恢复底栏并漏掉焦点定位。
      if (!wasEditing || focusBaselineHeight === null) {
        focusBaselineHeight = Math.max(viewport?.height ?? 0, window.innerHeight);
      }
      scheduleWrite();
    };
    const handleFocusOut = () => {
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = 0;
        editing = isEditableTarget(document.activeElement);
        if (!editing) focusBaselineHeight = null;
        scheduleWrite();
      });
    };
    const handleGeometryReset = () => {
      resetBaseline = true;
      scheduleWrite();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") handleGeometryReset();
    };

    write();
    viewport?.addEventListener("resize", scheduleWrite);
    viewport?.addEventListener("scroll", scheduleWrite);
    window.addEventListener("resize", scheduleWrite);
    window.addEventListener("pageshow", handleGeometryReset);
    window.addEventListener("orientationchange", handleGeometryReset);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
      viewport?.removeEventListener("resize", scheduleWrite);
      viewport?.removeEventListener("scroll", scheduleWrite);
      window.removeEventListener("resize", scheduleWrite);
      window.removeEventListener("pageshow", handleGeometryReset);
      window.removeEventListener("orientationchange", handleGeometryReset);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      target.style.removeProperty("--app-visual-viewport-height");
      target.style.removeProperty("--app-visual-viewport-offset-top");
      target.style.removeProperty("--app-visual-viewport-bottom-inset");
      delete target.dataset.appEditing;
      delete target.dataset.appKeyboardOpen;
    };
  }, [active]);
}
