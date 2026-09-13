/**
 * 估算器：从 LayoutItem 的几何算高，不碰 DOM（docs/script-template-engine.md §3）。
 *
 * 每个可见、非 inline、非空的槽：行数 = estimateLines(文字, floor(列宽 / 字号))，
 * 高 = 行数 × 行高 + 下外边距；同一行里的槽取最大；各行相加再加块外沿。
 * inline 槽（「角色：」前缀）不占行，只把自己的宽度扣在 content 首行上。
 *
 * legacy 兼容开关见 EstimateOptions：两个「不准」是存量页码的一部分，不能顺手修。
 */
import type { LayoutItem, Frame, ResolvedSlot, EstimateOptions, Variant } from "./types";
import { estimateLines, textUnits } from "./text";

const REM = 16;

function parseLength(width: string): { px: number } | { fr: number } | { auto: true } {
  if (width === "auto") return { auto: true };
  if (width.endsWith("fr")) return { fr: parseFloat(width) };
  if (width.endsWith("rem")) return { px: parseFloat(width) * REM };
  if (width.endsWith("px")) return { px: parseFloat(width) };
  return { px: parseFloat(width) };
}

/** 各列像素宽：fr 列平分「总宽 − 固定列 − 间距」；auto 列按 maxContent 估（调用方给） */
export function columnWidths(frame: Frame, totalWidth: number, autoWidths: number[] = []): number[] {
  const specs = frame.columns.map((c) => parseLength(c.width));
  const gaps = frame.gapX * Math.max(0, frame.columns.length - 1);
  let fixed = 0;
  let frSum = 0;
  specs.forEach((s, i) => {
    if ("px" in s) fixed += s.px;
    else if ("fr" in s) frSum += s.fr;
    else fixed += autoWidths[i] ?? 0;
  });
  const free = Math.max(0, totalWidth - fixed - gaps);
  return specs.map((s, i) => {
    if ("px" in s) return s.px;
    if ("fr" in s) return frSum > 0 ? (free * s.fr) / frSum : 0;
    return autoWidths[i] ?? 0;
  });
}

function slotWidth(frame: Frame, widths: number[], slot: ResolvedSlot): number {
  const { col, colSpan = 1 } = slot.slot.box;
  let w = 0;
  for (let i = col - 1; i < Math.min(frame.columns.length, col - 1 + colSpan); i++) w += widths[i];
  w += frame.gapX * Math.max(0, colSpan - 1);
  return w;
}

export function estimateItemHeight(
  item: LayoutItem,
  variant: "normal" | "pageTop",
  contentWidth: number,
  options: EstimateOptions,
): number {
  const v: Variant = variant === "pageTop" ? item.pageTop : item.normal;
  const frame = item.style.frame;
  // auto 列：按该列里最宽的槽文字估 max-content
  const autoWidths = frame.columns.map((c, i) => {
    if (c.width !== "auto") return 0;
    let max = 0;
    for (const s of item.slots) {
      if (s.slot.box.col - 1 !== i || s.slot.inline) continue;
      max = Math.max(max, textUnits(s.text) * s.slot.style.fontSize);
    }
    return max;
  });
  const widths = columnWidths(frame, contentWidth - (item.style.estimateWidthInset ?? 0), autoWidths);

  const rowHeights = new Map<number, number>();
  let standalone = 0;
  let sideLabel = 0; // rowSpan "all" 的槽：与各行之和取大

  const visible = (s: ResolvedSlot) => {
    if (v.hidden.has(s.slot.id)) return false;
    const isContent = s.parts.some((p) => p.field === "content");
    // 场次标题：估算器拿不到场次表，槽文字是空的，但它仍占一行（legacy SCENE_HEADER_HEIGHT 的口径）
    if (s.empty && (s.slot.hideIfEmpty ?? true) && !isContent && item.kind !== "sceneHeading") return false;
    return true;
  };
  const slotText = (s: ResolvedSlot) => s.text + (v.suffix[s.slot.id] ?? "");
  const hasBlockSlotInRow = (row: number) => item.slots.some((t) => visible(t) && !t.slot.inline && t.slot.box.row === row);

  // inline 槽：同行有占格槽 → 前缀并入该行的 content 首行；同行全是 inline → 连成一条文字流占一行
  const prefixUnitsByRow = new Map<number, number>();
  const inlineRows = new Map<number, ResolvedSlot[]>();
  for (const s of item.slots) {
    if (!visible(s) || !s.slot.inline) continue;
    const row = s.slot.box.row;
    if (hasBlockSlotInRow(row)) prefixUnitsByRow.set(row, (prefixUnitsByRow.get(row) ?? 0) + textUnits(slotText(s)));
    else inlineRows.set(row, [...(inlineRows.get(row) ?? []), s]);
  }
  for (const [row, slots] of inlineRows) {
    const first = slots[0];
    const width = slotWidth(frame, widths, first) - (first.slot.indent?.left ?? 0) - (first.slot.indent?.right ?? 0);
    const fontSize = Math.max(...slots.map((t) => t.slot.style.fontSize));
    const lineHeight = Math.max(...slots.map((t) => t.slot.style.lineHeight));
    const upl = Math.max(1, Math.floor(width / fontSize));
    const text = slots.map(slotText).join(" ");
    const h = estimateLines(text, upl) * lineHeight + Math.max(0, ...slots.map((t) => t.slot.marginBottom ?? 0));
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, h));
  }

  for (const s of item.slots) {
    if (!visible(s) || s.slot.inline) continue;
    const isContent = s.parts.some((p) => p.field === "content");
    // legacy quirk：角色名固定按 22px 计，无视它在哪一列
    if (s.slot.id === "character" && options.characterSlotHeight !== undefined) {
      standalone += options.characterSlotHeight;
      continue;
    }
    const width = slotWidth(frame, widths, s) - (s.slot.indent?.left ?? 0) - (s.slot.indent?.right ?? 0);
    const upl = Math.max(1, Math.floor(width / s.slot.style.fontSize));
    let text = slotText(s);
    const prefixUnits = isContent ? (prefixUnitsByRow.get(s.slot.box.row) ?? 0) : 0;
    const firstLineUnits = prefixUnits + (s.slot.indent?.firstLine ?? 0) / s.slot.style.fontSize;
    if (firstLineUnits > 0) {
      // 前缀 / 首行缩进吃掉首行：用等量全角字占位
      text = "　".repeat(Math.ceil(firstLineUnits)) + text;
    }
    const lines = item.kind === "sceneHeading" ? 1 : estimateLines(text, upl);
    const h = lines * s.slot.style.lineHeight + (s.slot.marginBottom ?? 0);
    if (s.slot.box.rowSpan === "all") {
      sideLabel = Math.max(sideLabel, h);
      continue;
    }
    const row = s.slot.box.row;
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, h));
  }
  let rows = 0;
  for (const h of rowHeights.values()) rows += h;
  return standalone + v.paddingTop + v.paddingBottom + Math.max(rows, sideLabel);
}
