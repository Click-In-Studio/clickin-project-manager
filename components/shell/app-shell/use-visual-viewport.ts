"use client";

import { useEffect, type RefObject } from "react";

type AppViewportSnapshot = {
  height: number;
  offsetTop: number;
};

export function writeAppViewportCssVariables(
  target: HTMLElement,
  viewport: AppViewportSnapshot,
  layoutHeight: number,
) {
  // 部分 Android WebView / 厂商浏览器会暴露 VisualViewport，却仍返回收起浏览器栏
  // 后的大高度；innerHeight 在这些实现里反而是当前可见高度。两者取小，宁可留下
  // 少量可滚动空间，也不能把底栏放到屏幕外并被 body 的 overflow-hidden 截断。
  const visibleHeight = Math.min(viewport.height, layoutHeight);
  const bottomInset = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
  target.style.setProperty("--app-visual-viewport-height", `${visibleHeight}px`);
  target.style.setProperty("--app-visual-viewport-offset-top", `${viewport.offsetTop}px`);
  target.style.setProperty("--app-visual-viewport-bottom-inset", `${bottomInset}px`);
}

/**
 * 移动端可见视口的唯一浏览器接线点。
 *
 * CSS 的 100dvh 负责 SSR 首屏；hydration 后用 Visual Viewport 的真实像素值
 * 覆盖它，兼容动态地址栏实现不完整的浏览器。这里只发布几何量，不判断软键盘
 * 或编辑态；输入法行为由 #727 在同一入口上归约。
 */
export function useVisualViewportCssVariables(targetRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const target = targetRef.current;
    if (!target) return;

    const viewport = window.visualViewport;
    let animationFrame = 0;

    const write = () => {
      animationFrame = 0;
      writeAppViewportCssVariables(
        target,
        viewport ?? { height: window.innerHeight, offsetTop: 0 },
        window.innerHeight,
      );
    };
    const scheduleWrite = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(write);
    };

    write();
    viewport?.addEventListener("resize", scheduleWrite);
    viewport?.addEventListener("scroll", scheduleWrite);
    window.addEventListener("resize", scheduleWrite);
    window.addEventListener("pageshow", scheduleWrite);
    document.addEventListener("visibilitychange", scheduleWrite);

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      viewport?.removeEventListener("resize", scheduleWrite);
      viewport?.removeEventListener("scroll", scheduleWrite);
      window.removeEventListener("resize", scheduleWrite);
      window.removeEventListener("pageshow", scheduleWrite);
      document.removeEventListener("visibilitychange", scheduleWrite);
    };
  }, [active, targetRef]);
}
