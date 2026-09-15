"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import type { ScriptTextLayoutMode } from "@/lib/script/script-types";

export default function BlockStageComment({
  value,
  onChange,
  showAddButton = true,
  topGap,
  readOnly = false,
  stageDelimOpen,
  stageDelimClose,
  layoutMode = "center",
  placementClassName = "",
  onEditingChange,
  addButtonCenter = false,
  alignFirstLineToEnd = false,
  alignAddButtonToLineAnchor = false,
  onOverflowBelowChange,
  addButtonRevealOnHover = false,
  lineAnchorCenter,
  lineAnchorRowHeight,
  zeroHeightAddButton = false,
  manualOffsetYPx = 0,
  getEditorWidth,
}: {
  value?: string | null;
  onChange: (value: string | null) => void;
  showAddButton?: boolean;
  topGap?: "compact" | "leading";
  readOnly?: boolean;
  stageDelimOpen: string;
  stageDelimClose: string;
  layoutMode?: ScriptTextLayoutMode;
  placementClassName?: string;
  onEditingChange?: (editing: boolean) => void;
  addButtonCenter?: boolean;
  alignFirstLineToEnd?: boolean;
  alignAddButtonToLineAnchor?: boolean;
  onOverflowBelowChange?: (height: number) => void;
  addButtonRevealOnHover?: boolean;
  lineAnchorCenter?: number;
  lineAnchorRowHeight?: number;
  zeroHeightAddButton?: boolean;
  manualOffsetYPx?: number;
  getEditorWidth?: () => number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const skipBlurCommitRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [lineAnchorShift, setLineAnchorShift] = useState(0);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const text = value?.trim() ?? "";

  const commit = () => {
    const next = draft.trim();
    onChange(next || null);
    skipBlurCommitRef.current = false;
    setEditing(false);
    onEditingChange?.(false);
  };
  const openEditor = () => {
    skipBlurCommitRef.current = false;
    setDraft(value ?? "");
    setEditorWidth(getEditorWidth?.() ?? null);
    setEditing(true);
    onEditingChange?.(true);
  };
  const topGapClass = topGap === "leading" ? "mt-2 " : topGap === "compact" ? "-mt-1 " : "";
  const compactLayout = layoutMode === "compact";
  const alignClass = compactLayout ? "justify-start text-left" : "justify-center text-center";
  const addButtonAlignClass = addButtonCenter ? "justify-center" : alignClass;
  const stageCommentLeadingClass = "leading-normal";
  const stageCommentTextClass = `font-stage text-sm italic text-zinc-400 ${compactLayout ? "text-left" : ""} ${stageCommentLeadingClass} whitespace-pre-wrap`;
  const rootTranslateY = ((alignFirstLineToEnd || alignAddButtonToLineAnchor) ? lineAnchorShift : 0) + manualOffsetYPx;
  const rootStyle: React.CSSProperties | undefined = rootTranslateY !== 0
    ? { transform: `translateY(${rootTranslateY}px)` }
    : undefined;
  const addButtonStyle: React.CSSProperties | undefined = zeroHeightAddButton
    ? { transform: "translateY(-0.75rem)" }
    : undefined;

  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useLayoutEffect(() => {
    if (!alignFirstLineToEnd && !alignAddButtonToLineAnchor) {
      setLineAnchorShift(0);
      onOverflowBelowChange?.(0);
      return;
    }
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const target = alignFirstLineToEnd
        ? el.querySelector<HTMLElement>("[data-stage-comment-body='true']")
        : addButtonRef.current;
      if (!target) {
        setLineAnchorShift(0);
        onOverflowBelowChange?.(0);
        return;
      }
      const rootRect = el.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const lineHeight = alignFirstLineToEnd
        ? parseFloat(window.getComputedStyle(target).lineHeight)
        : targetRect.height;
      const firstLineCenter = targetRect.top - rootRect.top + (Number.isFinite(lineHeight) ? lineHeight : targetRect.height) / 2;
      if (lineAnchorCenter === undefined) {
        setLineAnchorShift(0);
        onOverflowBelowChange?.(0);
        return;
      }
      const shift = Math.round(lineAnchorCenter - firstLineCenter);
      const rowHeight = Math.max(lineAnchorRowHeight ?? 0, rootRect.height);
      setLineAnchorShift(shift);
      onOverflowBelowChange?.(
        alignFirstLineToEnd ? Math.max(0, Math.ceil(shift + rootRect.height - rowHeight)) : 0
      );
    };
    measure();
    if (alignAddButtonToLineAnchor && !alignFirstLineToEnd) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    alignFirstLineToEnd,
    alignAddButtonToLineAnchor,
    editing,
    draft,
    text,
    readOnly,
    showAddButton,
    onOverflowBelowChange,
    lineAnchorCenter,
    lineAnchorRowHeight,
  ]);

  if (editing && !readOnly) {
    return (
      <div ref={rootRef} style={rootStyle} className={`${topGapClass}mb-0.5 flex ${alignClass} ${placementClassName}`}>
        <textarea
          data-stage-comment-body="true"
          ref={textareaRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (skipBlurCommitRef.current) {
              skipBlurCommitRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === "Escape") {
              e.preventDefault();
              skipBlurCommitRef.current = true;
              setDraft(value ?? "");
              setEditing(false);
              onEditingChange?.(false);
            }
          }}
          placeholder="在此输入演员提示/补充舞台提示"
          rows={1}
          style={editorWidth ? { width: editorWidth } : undefined}
          className={`${editorWidth ? "shrink-0" : "w-full max-w-xs"} ${compactLayout ? "min-h-[1.125rem]" : "min-h-7"} ${stageCommentLeadingClass} resize-none overflow-hidden border-b border-zinc-200 bg-transparent px-1 ${compactLayout ? "text-left" : "text-center"} font-stage text-sm italic text-zinc-500 outline-none placeholder:text-zinc-300 focus:border-zinc-400`}
        />
      </div>
    );
  }

  if (text) {
    const label = text
      .split(/\r\n|\r|\n/)
      .map((line) => `${stageDelimOpen}${line}${stageDelimClose}`)
      .join("\n");
    return (
      <div ref={rootRef} style={rootStyle} className={`${topGapClass}mb-0.5 flex ${alignClass} ${placementClassName}`}>
        {readOnly ? (
          <span data-stage-comment-body="true" className={stageCommentTextClass}>{label}</span>
        ) : (
          <button
            data-stage-comment-body="true"
            type="button"
            onClick={openEditor}
            className={`${stageCommentTextClass} transition-colors hover:text-zinc-600`}
          >
            {label}
          </button>
        )}
      </div>
    );
  }

  if (readOnly || !showAddButton) return null;
  return (
    <div
      ref={rootRef}
      style={rootStyle}
      className={`${zeroHeightAddButton ? "mb-0 h-0 overflow-visible" : "mb-1"} flex ${addButtonAlignClass} ${placementClassName}`}
    >
      <button
        ref={addButtonRef}
        type="button"
        onClick={openEditor}
        title="添加演员提示/补充舞台提示"
        aria-label="添加演员提示/补充舞台提示"
        style={addButtonStyle}
        className={`relative flex h-4 w-4 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-zinc-100 hover:text-zinc-500 ${
          addButtonRevealOnHover ? "opacity-0 transition-opacity group-hover:opacity-100" : ""
        }`}
      >
        <span aria-hidden className="absolute left-1/2 top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-current" />
        <span aria-hidden className="absolute left-1/2 top-1/2 h-px w-[5px] -translate-x-1/2 -translate-y-1/2 rounded bg-current" />
        <span aria-hidden className="absolute left-1/2 top-1/2 h-[5px] w-px -translate-x-1/2 -translate-y-1/2 rounded bg-current" />
      </button>
    </div>
  );
}
