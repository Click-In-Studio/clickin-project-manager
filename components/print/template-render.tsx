"use client";

/**
 * 模版引擎的渲染器（docs/script-template-engine.md §3）：把 plan 产出的 LayoutItem
 * 画成 DOM。**只有这一份**——打印预览、预览的隐藏测量层、编辑器的分页线测量层
 * 都用它；此前预览与测量层各有一份 renderBlock，必须手工保持一致。
 *
 * 样式全部从模版的 TextStyle / Frame 来（内联 style），不再写 Tailwind 类：
 * 模版是数据，渲染器不能认识「center」「compact」这些名字。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { mdToHtml } from "@/lib/script-md";
import type { LayoutItem, ResolvedSlot, TextStyle, Variant } from "@/lib/script-template";

const FACE_VAR: Record<TextStyle["face"], string> = {
  script: "var(--font-script)",
  stage: "var(--font-stage)",
  lyric: "var(--font-lyric)",
};

export function textStyleCss(style: TextStyle): React.CSSProperties {
  return {
    fontFamily: FACE_VAR[style.face],
    fontSize: style.fontSize,
    lineHeight: `${style.lineHeight}px`,
    fontWeight: style.weight === "bold" ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textTransform: style.case === "upper" ? "uppercase" : undefined,
    letterSpacing: style.letterSpacing,
    color: style.color,
    textAlign: style.align,
    whiteSpace: style.whiteSpace === "pre-wrap" ? "pre-wrap" : undefined,
  };
}

/** 槽的 HTML：content 走 mdToHtml（行内舞台指示、粗体），其余按纯文本 */
function slotHtml(slot: ResolvedSlot, suffix: string, delimOpen: string, delimClose: string): { html: string } | { text: string } {
  const hasContent = slot.parts.some((p) => p.field === "content");
  if (hasContent) {
    // legacy-center：括号提示与正文拼成一段一起走 mdToHtml，括号因此拿到行内舞台指示样式
    const joined = slot.parts.map((p) => `${p.before}${p.raw}${p.after}`).join(slot.slot.joiner ?? "\n") + suffix;
    return { html: mdToHtml(joined, delimOpen, delimClose) || "　" };
  }
  return { text: slot.text + suffix };
}

function isSlotVisible(slot: ResolvedSlot, v: Variant): boolean {
  if (v.hidden.has(slot.slot.id)) return false;
  const isContent = slot.parts.some((p) => p.field === "content");
  if (slot.empty && (slot.slot.hideIfEmpty ?? true) && !isContent) return false;
  return true;
}

function getElementLineBounds(el: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  range.detach();
  if (rects.length === 0) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }
  const lines: DOMRect[] = [];
  for (const rect of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(rect.top - last.top) < 2) {
      const left = Math.min(last.left, rect.left);
      const top = Math.min(last.top, rect.top);
      const right = Math.max(last.right, rect.right);
      const bottom = Math.max(last.bottom, rect.bottom);
      lines[lines.length - 1] = new DOMRect(left, top, right - left, bottom - top);
    } else {
      lines.push(new DOMRect(rect.left, rect.top, rect.width, rect.height));
    }
  }
  return lines;
}

export type TemplateItemViewProps = {
  item: LayoutItem;
  variant: "normal" | "pageTop";
  stageDelimOpen: string;
  stageDelimClose: string;
  /** px，块前间距（分页器已决定本页首块为 0） */
  gapBefore?: number;
  /** 渲染层的外沿微调（同一说话人的连续块把外沿分摊到首尾），不影响测量 */
  paddingOverride?: { top: number; bottom: number };
  /** 槽间光学对齐改变了高度时通知（测量层据此重测） */
  onLayoutChange?: () => void;
};

export function TemplateItemView(props: TemplateItemViewProps) {
  const { item, variant, stageDelimOpen, stageDelimClose, gapBefore = 0, paddingOverride, onLayoutChange } = props;
  const v = variant === "pageTop" ? item.pageTop : item.normal;
  const paddingTop = paddingOverride?.top ?? v.paddingTop;
  const paddingBottom = paddingOverride?.bottom ?? v.paddingBottom;

  if (item.kind === "sceneHeading" && item.style.decoration === "rule-lines") {
    return (
      <div className="flex items-center" style={{ gap: 12, paddingTop, paddingBottom }}>
        <div className="h-px flex-1 bg-zinc-200" />
        <div className="flex items-baseline" style={{ gap: item.style.frame.gapX }}>
          {item.slots.filter((s) => isSlotVisible(s, v)).map((s) => (
            <span key={s.slot.id} style={textStyleCss(s.slot.style)}>{s.text}</span>
          ))}
        </div>
        <div className="h-px flex-1 bg-zinc-200" />
      </div>
    );
  }

  const visible = item.slots.filter((s) => isSlotVisible(s, v) && !s.slot.inline);
  const inlinePrefix = item.slots
    .filter((s) => isSlotVisible(s, v) && s.slot.inline)
    .map((s) => s.text + (v.suffix[s.slot.id] ?? ""))
    .join("");
  const single = item.style.frame.columns.length === 1;

  return (
    <div className="w-full" style={{ paddingTop, paddingBottom }}>
      {gapBefore > 0 && <div aria-hidden="true" style={{ height: gapBefore }} />}
      {single
        ? <StackedSlots slots={visible} v={v} inlinePrefix={inlinePrefix} delimOpen={stageDelimOpen} delimClose={stageDelimClose} />
        : <GridSlots item={item} slots={visible} v={v} inlinePrefix={inlinePrefix} delimOpen={stageDelimOpen} delimClose={stageDelimClose} onLayoutChange={onLayoutChange} />}
    </div>
  );
}

function SlotText({ slot, v, inlinePrefix, delimOpen, delimClose, style, innerRef }: {
  slot: ResolvedSlot; v: Variant; inlinePrefix: string; delimOpen: string; delimClose: string;
  style?: React.CSSProperties; innerRef?: React.Ref<HTMLDivElement>;
}) {
  const isContent = slot.parts.some((p) => p.field === "content");
  const rendered = slotHtml(slot, v.suffix[slot.slot.id] ?? "", delimOpen, delimClose);
  const css: React.CSSProperties = { ...textStyleCss(slot.slot.style), ...style };
  // data-slot / data-face 只给诊断与测试用（print-consistency 探针按面统计元素与计算字体）
  if ("html" in rendered) {
    const html = isContent && inlinePrefix ? `${inlinePrefix}${rendered.html}` : rendered.html;
    return <div ref={innerRef} className="w-full min-w-0 break-words" style={css} data-slot={slot.slot.id} data-face={slot.slot.style.face} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div ref={innerRef} className="max-w-full break-words" style={css} data-slot={slot.slot.id} data-face={slot.slot.style.face}>{rendered.text}</div>;
}

/** 单列：槽按行序纵向堆叠（legacy-center：角色名一行、正文一段） */
function StackedSlots({ slots, v, inlinePrefix, delimOpen, delimClose }: {
  slots: ResolvedSlot[]; v: Variant; inlinePrefix: string; delimOpen: string; delimClose: string;
}) {
  const ordered = [...slots].sort((a, b) => a.slot.box.row - b.slot.box.row);
  return (
    <>
      {ordered.map((s) => (
        <SlotText key={s.slot.id} slot={s} v={v} inlinePrefix={inlinePrefix} delimOpen={delimOpen} delimClose={delimClose}
          style={s.slot.marginBottom ? { marginBottom: s.slot.marginBottom } : undefined} />
      ))}
    </>
  );
}

/**
 * 多列网格（legacy-compact：角色名左栏、括号提示与正文右栏）。
 * 空行折叠：模版把正文放第 2 行，但没有括号提示时它应贴着角色名（第 1 行）——
 * 只有含可见槽的行才占行号，其余行上移。
 */
function GridSlots({ item, slots, v, inlinePrefix, delimOpen, delimClose, onLayoutChange }: {
  item: LayoutItem; slots: ResolvedSlot[]; v: Variant; inlinePrefix: string; delimOpen: string; delimClose: string;
  onLayoutChange?: () => void;
}) {
  const frame = item.style.frame;
  const columns = frame.columns.map((c) => (c.width.endsWith("fr") ? `minmax(0,${c.width})` : c.width)).join(" ");
  // 行折叠只看「占行」的槽；侧栏标签（rowSpan all）贯穿全部行，不算
  const rowsInUse = [...new Set(slots.filter((s) => s.slot.box.rowSpan !== "all").map((s) => s.slot.box.row))].sort((a, b) => a - b);
  const rowIndex = new Map(rowsInUse.map((row, i) => [row, i + 1]));
  const rowCount = Math.max(1, rowsInUse.length);

  // 光学对齐：某槽首行对齐另一槽末行（legacy-compact 正文首行对齐角色名末行）
  const refs = useRef(new Map<string, HTMLDivElement | null>());
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const lastNotified = useRef<string>("");
  const alignPairs = slots.filter((s) => s.slot.alignFirstLineTo && slots.some((t) => t.slot.id === s.slot.alignFirstLineTo));
  // 首行槽：该行里最先出现的可见槽（legacy：有括号提示时它是首行，否则正文是首行）
  const firstRow = rowsInUse[0];
  const firstRowSlots = slots.filter((s) => s.slot.box.row === firstRow && s.slot.box.rowSpan !== "all");

  useLayoutEffect(() => {
    if (alignPairs.length === 0) return;
    const next: Record<string, number> = {};
    for (const s of alignPairs) {
      const targetId = s.slot.alignFirstLineTo!;
      // 对齐的是「与目标同一行的那个槽」的首行——legacy 里有括号提示时对齐的是提示行
      const firstLineSlot = firstRowSlots.find((t) => t.slot.id !== targetId) ?? s;
      const targetEl = refs.current.get(targetId);
      const lineEl = refs.current.get(firstLineSlot.slot.id);
      if (!targetEl || !lineEl) continue;
      const targetLines = getElementLineBounds(targetEl);
      const lines = getElementLineBounds(lineEl);
      const targetLine = targetLines[targetLines.length - 1];
      const currentLine = lines[0];
      if (!targetLine || !currentLine) continue;
      const opticalOffset = slots.find((t) => t.slot.id === targetId)?.slot.opticalOffsetY ?? 0;
      const targetCenter = targetLine.top + targetLine.height / 2 - opticalOffset;
      const currentCenter = currentLine.top + currentLine.height / 2;
      const prevOffset = offsets[firstLineSlot.slot.id] ?? 0;
      next[firstLineSlot.slot.id] = Math.max(0, Math.round(prevOffset + targetCenter - currentCenter));
    }
    setOffsets((prev) => {
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const k of keys) if (Math.abs((prev[k] ?? 0) - (next[k] ?? 0)) >= 1) return next;
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, v, slots.map((s) => s.text).join(" "), offsets]);

  useEffect(() => {
    if (!onLayoutChange) return;
    const key = JSON.stringify(offsets);
    if (lastNotified.current === key) return;
    lastNotified.current = key;
    onLayoutChange();
  }, [offsets, onLayoutChange]);

  return (
    <div className="grid items-start text-left" style={{ gridTemplateColumns: columns, gridTemplateRows: `repeat(${rowCount}, auto)`, columnGap: frame.gapX }}>
      {slots.map((s) => {
        const spanAll = s.slot.box.rowSpan === "all";
        const row = spanAll ? 1 : rowIndex.get(s.slot.box.row)!;
        const offset = offsets[s.slot.id];
        const cellStyle: React.CSSProperties = {
          gridColumn: s.slot.box.colSpan ? `${s.slot.box.col} / span ${s.slot.box.colSpan}` : String(s.slot.box.col),
          gridRow: spanAll ? "1 / -1" : typeof s.slot.box.rowSpan === "number" ? `${row} / span ${s.slot.box.rowSpan}` : String(row),
          minWidth: 0,
          alignSelf: "start",
          textAlign: s.slot.style.align,
        };
        const textStyle: React.CSSProperties = {};
        if (offset) textStyle.marginTop = offset;
        if (s.slot.opticalOffsetY) textStyle.transform = `translateY(${s.slot.opticalOffsetY}px)`;
        return (
          <div key={s.slot.id} style={cellStyle}>
            <SlotText slot={s} v={v} inlinePrefix={inlinePrefix} delimOpen={delimOpen} delimClose={delimClose}
              style={textStyle} innerRef={(el) => { refs.current.set(s.slot.id, el); }} />
          </div>
        );
      })}
    </div>
  );
}

// ── 测量 ─────────────────────────────────────────────────────────────────────

export function measureKey(item: LayoutItem, variant: "normal" | "pageTop"): string {
  return `${item.id}|${variant}`;
}

function variantsDiffer(item: LayoutItem): boolean {
  if (item.kind !== "block") return false;
  const a = item.normal;
  const b = item.pageTop;
  if (a.paddingTop !== b.paddingTop || a.paddingBottom !== b.paddingBottom) return true;
  if (a.hidden.size !== b.hidden.size || [...a.hidden].some((id) => !b.hidden.has(id))) return true;
  return JSON.stringify(a.suffix) !== JSON.stringify(b.suffix);
}

/** 一个项需要测哪些变体：pageTop 与 normal 有差异时才多测一次 */
export function variantsToMeasure(item: LayoutItem): Array<"normal" | "pageTop"> {
  return variantsDiffer(item) ? ["normal", "pageTop"] : ["normal"];
}

/**
 * 隐藏测量层：把项渲染进屏幕外容器，调用方读 `[data-mid]` 的 offsetHeight。
 * 宽度必须等于页内容宽——换行点就是分页点。
 */
export function TemplateMeasureLayer({ items, contentWidth, stageDelimOpen, stageDelimClose, measureRef, onLayoutChange }: {
  items: LayoutItem[];
  contentWidth: number;
  stageDelimOpen: string;
  stageDelimClose: string;
  measureRef: React.RefObject<HTMLDivElement | null>;
  onLayoutChange?: () => void;
}) {
  return (
    <div ref={measureRef} aria-hidden="true" style={{ position: "fixed", left: -9999, top: 0, width: contentWidth, visibility: "hidden" }}>
      {items.map((item) => (
        <div key={item.id}>
          {variantsToMeasure(item).map((variant) => (
            <div key={variant} data-mid={measureKey(item, variant)}>
              <TemplateItemView item={item} variant={variant} stageDelimOpen={stageDelimOpen} stageDelimClose={stageDelimClose} onLayoutChange={onLayoutChange} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function readMeasuredHeights(root: HTMLElement, into: Record<string, number> = {}): Record<string, number> {
  root.querySelectorAll<HTMLElement>("[data-mid]").forEach((node) => {
    if (node.dataset.mid) into[node.dataset.mid] = node.offsetHeight;
  });
  return into;
}

/** 测量结果 → 分页器的取高函数；没测到的（不该发生）给一个保守估计 */
export function heightOfMeasured(heights: Record<string, number>): (item: LayoutItem, variant: "normal" | "pageTop") => number {
  return (item, variant) => {
    const exact = heights[measureKey(item, variant)];
    if (exact !== undefined) return exact;
    const normal = heights[measureKey(item, "normal")];
    if (normal !== undefined) return normal;
    return item.kind === "sceneHeading" ? 52 : 60;
  };
}

/**
 * 同一说话人的连续块（角色名被省略的一串）把块外沿分摊到首尾：首块 pt 保留 pb 归零，
 * 末块 pt 归零 pb 保留，中间全零。总高不变（测量按各块自己的外沿），只是视觉上把
 * 一串连续台词收拢——legacy 预览的做法，原样保留。
 */
export function runPaddingOverrides(
  placed: Array<{ item: LayoutItem; variant: "normal" | "pageTop" }>,
): Map<string, { top: number; bottom: number }> {
  const overrides = new Map<string, { top: number; bottom: number }>();
  let nextHidden = false;
  let hasNext = false;
  for (let i = placed.length - 1; i >= 0; i--) {
    const { item, variant } = placed[i];
    if (item.kind !== "block") continue;
    const v = variant === "pageTop" ? item.pageTop : item.normal;
    const hidden = v.hidden.has("character");
    if (!hidden && hasNext && nextHidden) overrides.set(item.id, { top: v.paddingTop, bottom: 0 });
    if (hidden && (!hasNext || !nextHidden)) overrides.set(item.id, { top: 0, bottom: item.style.padding.bottom });
    nextHidden = hidden;
    hasNext = true;
  }
  return overrides;
}
