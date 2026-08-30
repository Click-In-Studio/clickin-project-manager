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
  let inlinePrefixUnits = 0;
  for (const s of item.slots) {
    if (v.hidden.has(s.slot.id)) continue;
    if (s.empty && (s.slot.hideIfEmpty ?? true) && !s.parts.some((p) => p.field === "content")) continue;
    if (s.slot.inline) {
      inlinePrefixUnits += textUnits(s.text + (v.suffix[s.slot.id] ?? ""));
      continue;
    }
  }
  for (const s of item.slots) {
    if (v.hidden.has(s.slot.id) || s.slot.inline) continue;
    const isContent = s.parts.some((p) => p.field === "content");
    // 场次标题：估算器拿不到场次表，槽文字是空的，但它仍占一行（legacy SCENE_HEADER_HEIGHT 的口径）
    if (s.empty && (s.slot.hideIfEmpty ?? true) && !isContent && item.kind !== "sceneHeading") continue;
    // legacy quirk：角色名固定按 22px 计，无视它在哪一列
    if (s.slot.id === "character" && options.characterSlotHeight !== undefined) {
      standalone += options.characterSlotHeight;
      continue;
    }
    const width = slotWidth(frame, widths, s);
    const upl = Math.max(1, Math.floor(width / s.slot.style.fontSize));
    let text = s.text + (v.suffix[s.slot.id] ?? "");
    if (isContent && inlinePrefixUnits > 0) {
      // 前缀吃掉首行：用等量全角字占位
      text = "　".repeat(Math.ceil(inlinePrefixUnits)) + text;
    }
    const lines = item.kind === "sceneHeading" ? 1 : estimateLines(text, upl);
    const h = lines * s.slot.style.lineHeight + (s.slot.marginBottom ?? 0);
    const row = s.slot.box.row;
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, h));
  }
  let total = standalone + v.paddingTop + v.paddingBottom;
  for (const h of rowHeights.values()) total += h;
  return total;
}
