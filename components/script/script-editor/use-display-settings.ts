"use client";

import { useState, useRef, useLayoutEffect, useCallback } from "react";
import { readDisplayCookie, writeDisplayCookie, type DisplaySettings } from "./display-settings";

/**
 * 显示设置（cookie 持久化）+ 行号列宽度测量（按最长行号文本量两处 span）。
 * 从 ScriptEditor 主函数体原样搬出（#487 S4）。
 */
export function useDisplaySettings({ maxLineIndexText }: { maxLineIndexText: string }) {
  const lineIndexMeasureRef = useRef<HTMLSpanElement | null>(null);
  const lineIndexMinMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [lineIndexWidth, setLineIndexWidth] = useState(0);
  const [lineIndexMinWidth, setLineIndexMinWidth] = useState(0);

  const [display, setDisplay] = useState<DisplaySettings>(readDisplayCookie);
  useLayoutEffect(() => {
    if (!display.lineNumbers) {
      setLineIndexWidth(0);
      setLineIndexMinWidth(0);
      return;
    }
    const el = lineIndexMeasureRef.current;
    const minEl = lineIndexMinMeasureRef.current;
    if (!el || !minEl) return;
    const measure = () => {
      const width = Math.ceil(el.getBoundingClientRect().width);
      const minWidth = Math.ceil(minEl.getBoundingClientRect().width);
      setLineIndexWidth((prev) => prev === width ? prev : width);
      setLineIndexMinWidth((prev) => prev === minWidth ? prev : minWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(minEl);
    return () => observer.disconnect();
  }, [display.lineNumbers, maxLineIndexText]);
  const lineIndexWidthStyle = display.lineNumbers && lineIndexWidth > 0
    ? `${lineIndexWidth}px`
    : undefined;
  const markerLineIndexWidthStyle = display.lineNumbers && (lineIndexWidth > 0 || lineIndexMinWidth > 0)
    ? `${Math.max(lineIndexWidth, lineIndexMinWidth)}px`
    : undefined;
  const toggleDisplay = useCallback((key: keyof DisplaySettings) => {
    setDisplay(prev => {
      const next = { ...prev, [key]: !prev[key] };
      writeDisplayCookie(next);
      return next;
    });
  }, []);

  return {
    display, setDisplay, toggleDisplay,
    lineIndexMeasureRef, lineIndexMinMeasureRef, lineIndexWidth, lineIndexWidthStyle, markerLineIndexWidthStyle,
  };
}
