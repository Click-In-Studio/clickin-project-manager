import React from "react";
import type { Scene } from "@/lib/script/script-types";
import { SCRIPT_TOC_RAIL_NUMBER_SLOT_REM } from "./constants";

/** Returns the workspace scroll container element, or document.documentElement as fallback. */
export function getScrollEl(): HTMLElement {
  return (typeof document !== 'undefined' ? document.getElementById('workspace-scroll') as HTMLElement | null : null)
    ?? (typeof document !== 'undefined' ? document.documentElement : { scrollTop: 0, clientHeight: 720, getBoundingClientRect: () => ({ top: 0, bottom: 720 }) } as unknown as HTMLElement);
}

/** Computes visible bounds of the scroll container in viewport coordinates. */
export function getScrollMetrics() {
  const el = getScrollEl();
  const isRoot = el === document.documentElement;
  if (isRoot) {
    const ch = typeof window !== 'undefined' ? window.innerHeight : 720;
    return { el, scrollTop: typeof window !== 'undefined' ? window.scrollY : 0, clientHeight: ch, viewTop: 0, viewBottom: ch };
  }
  const rect = el.getBoundingClientRect();
  return { el, scrollTop: el.scrollTop, clientHeight: el.clientHeight, viewTop: rect.top, viewBottom: rect.bottom };
}

export function scrollContainerBy(opts: ScrollToOptions) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('workspace-scroll');
  if (el) el.scrollBy(opts); else window.scrollBy(opts);
}

export function scrollElementIntoView(
  element: HTMLElement,
  align: ScrollLogicalPosition,
  viewportTopRatio?: number,
) {
  if (viewportTopRatio === undefined) {
    element.scrollIntoView({ behavior: "instant", block: align });
    return;
  }
  const blockElement = element.closest<HTMLElement>("[data-bwrap]") ?? element;
  const { clientHeight, viewTop } = getScrollMetrics();
  const targetTop = viewTop + clientHeight * viewportTopRatio;
  const delta = blockElement.getBoundingClientRect().top - targetTop;
  if (Math.abs(delta) >= 0.5) scrollContainerBy({ top: delta, behavior: "instant" });
}

let scriptTocMeasureElement: HTMLSpanElement | null = null;
let scriptTocMeasureCache: {
  scenes: Scene[];
  rootFontSizePx: number;
  chapterNumberSlotWidthPx: number;
  sceneNumberSlotWidthPx: number;
} | null = null;

export function measureScriptTocNumberWidths(scenes: Scene[], rootFontSizePx: number): {
  chapterNumberSlotWidthPx: number;
  sceneNumberSlotWidthPx: number;
} {
  const minimumNumberSlotWidthPx = SCRIPT_TOC_RAIL_NUMBER_SLOT_REM * rootFontSizePx;
  if (scriptTocMeasureCache?.scenes === scenes && scriptTocMeasureCache.rootFontSizePx === rootFontSizePx) {
    return scriptTocMeasureCache;
  }
  if (typeof document === "undefined" || scenes.length === 0) {
    return {
      chapterNumberSlotWidthPx: minimumNumberSlotWidthPx,
      sceneNumberSlotWidthPx: minimumNumberSlotWidthPx,
    };
  }

  let chapterNumberSlotWidthPx = minimumNumberSlotWidthPx;
  let sceneNumberSlotWidthPx = minimumNumberSlotWidthPx;
  const numberFontSizePx = 0.75 * rootFontSizePx;
  scriptTocMeasureElement ??= document.createElement("span");
  const measureElement = scriptTocMeasureElement;
  if (!measureElement.isConnected) document.body.appendChild(measureElement);
  Object.assign(measureElement.style, {
    position: "fixed",
    top: "-9999px",
    left: "-9999px",
    visibility: "hidden",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    fontFamily: window.getComputedStyle(document.body).fontFamily,
    fontSize: `${numberFontSizePx}px`,
    fontWeight: "700",
    letterSpacing: `${0.05 * numberFontSizePx}px`,
  });

  for (const scene of scenes) {
    measureElement.textContent = scene.number || "—";
    const measuredNumberWidthPx = measureElement.getBoundingClientRect().width;
    if (scene.parentId === null) {
      chapterNumberSlotWidthPx = Math.max(chapterNumberSlotWidthPx, measuredNumberWidthPx);
    } else {
      sceneNumberSlotWidthPx = Math.max(sceneNumberSlotWidthPx, measuredNumberWidthPx);
    }
  }

  scriptTocMeasureCache = {
    scenes,
    rootFontSizePx,
    chapterNumberSlotWidthPx,
    sceneNumberSlotWidthPx,
  };
  return scriptTocMeasureCache;
}

export function clearTimeoutMap(timers: Map<string, ReturnType<typeof setTimeout>>) {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
}

export function markProgrammaticScroll(
  suppressRef: React.MutableRefObject<boolean>,
  frameRef: React.MutableRefObject<number | null>,
) {
  suppressRef.current = true;
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current);
  }
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      suppressRef.current = false;
    });
  });
}
