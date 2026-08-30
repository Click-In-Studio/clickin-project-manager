import type { Block } from "./script-types";
import type { PageLayout, ScriptTextLayoutMode } from "./script-types";
import {
  isMarkerBlock,
  withLegacyOwnershipProjection,
  withMarkerOwnership,
} from "./script-marker-blocks";
import type { MarkerOwnershipDirty, MarkerOwnershipRange } from "./script-marker-ownership-cache";
// 估算器改吃模版引擎（docs/script-template-engine.md）：块的高度由模版的几何算出，
// 角色名省略 / 页首补名 / 说话人间距都是模版规则。legacy 模版逐字节复现此前的输出
// （tests/fixtures/legacy-script-page.ts 是旧实现原文，测试拿它当参照）。
import { estimateItemHeight, planBlock, planSceneHeading, templateForTextLayoutMode, type PlanContext, type ScriptTemplate } from "./script-template";

// ── Print page config — single source of truth shared with ScriptEditor ───────

export type PageConfig = {
  width: number;
  height: number;
  marginX: number;
  marginTop: number;
  marginBottom: number;
  headerHeight: number;
  footerHeight: number;
  cols: 1 | 2; // 2 = two columns printed side-by-side on one physical sheet
};

// A4 at 96 dpi (210×297 mm)
export const DEFAULT_PAGE_CONFIG: PageConfig = {
  width: 794, height: 1123,
  marginX: 75, marginTop: 90, marginBottom: 90,
  headerHeight: 28, footerHeight: 28,
  cols: 1,
};

export const PAGE_CONFIGS: Record<PageLayout, PageConfig> = {
  "a4": DEFAULT_PAGE_CONFIG,
  // Letter: 8.5×11 in at 96 dpi
  "letter": { width: 816, height: 1056, marginX: 75, marginTop: 90, marginBottom: 90, headerHeight: 28, footerHeight: 28, cols: 1 },
  // A3 landscape: two A4 columns side-by-side (1587×1123 px at 96 dpi)
  "a3-2col": { width: 794, height: 1123, marginX: 75, marginTop: 90, marginBottom: 90, headerHeight: 28, footerHeight: 28, cols: 2 },
  // Tablet landscape: two Letter columns side-by-side
  "tablet-2col": { width: 816, height: 1056, marginX: 75, marginTop: 90, marginBottom: 90, headerHeight: 28, footerHeight: 28, cols: 2 },
};

// ── Layout metrics derived from PageConfig ────────────────────────────────────

export const COMPACT_TEXT_SIDE_WIDTH_REM = 9.5;

function contentWidth(cfg: PageConfig): number {
  return cfg.width - 2 * cfg.marginX;
}
function contentHeight(cfg: PageConfig): number {
  return cfg.height - cfg.marginTop - cfg.marginBottom;
}

type PaginationHeightFeature = {
  normalHeight: number;
  forcedHeight: number;
  startsScene: boolean;
};

type EstimateContext = {
  plan: PlanContext;
  template: ScriptTemplate;
  contentWidth: number;
  /** 场次标题项的高度：估算器拿不到 scenes，按模版的一行计（legacy 44） */
  sceneHeadingHeight: number;
};

function estimateContext(cfg: PageConfig, template: ScriptTemplate): EstimateContext {
  // 估算器不知道演出的角色表 / 场次表 / 分隔符——今天也不知道：它按「角色名占一行、
  // 括号提示按 （） 包住」的口径估，legacy 模版把这个口径写成数据。
  const plan: PlanContext = { template, characters: [], scenes: [], stageDelimOpen: "（", stageDelimClose: "）" };
  const width = contentWidth(cfg);
  const heading = planSceneHeading("", null, plan);
  return {
    plan,
    template,
    contentWidth: width,
    sceneHeadingHeight: estimateItemHeight(heading, "normal", width, template.estimate),
  };
}

function paginationHeightFeature(block: Block, prev: Block | null, ctx: EstimateContext): PaginationHeightFeature {
  // 角色名文字估算器拿不到（没有角色表）：legacy 口径是「有角色就按一行算」，
  // 所以给 plan 一个占位角色名，让 character 槽非空
  const planBlockInput = block.characterIds.length > 0 && ctx.plan.characters.length === 0
    ? { ...ctx.plan, characters: block.characterIds.map((id) => ({ id, name: "角", isAggregate: false })) }
    : ctx.plan;
  const item = planBlock(block, prev, planBlockInput);
  return {
    normalHeight: estimateItemHeight(item, "normal", ctx.contentWidth, ctx.template.estimate),
    forcedHeight: estimateItemHeight(item, "pageTop", ctx.contentWidth, ctx.template.estimate),
    startsScene: !!block.sceneId && block.sceneId !== prev?.sceneId,
  };
}

type TextBlockEntry = {
  block: Block;
  previousBlock: Block | null;
  sourceIndex: number;
};

type EstimatedPageMapCacheEntry = {
  block: Block;
  blockId: string;
  previousBlock: Block | null;
  heightFeature: PaginationHeightFeature;
  page: number;
  usedAfter: number;
};

export type EstimatedPageMapCache = {
  layout: PageLayout;
  textLayoutMode: ScriptTextLayoutMode;
  blocksHaveMarkerOwnership: boolean;
  entries: EstimatedPageMapCacheEntry[];
  pageMap: Record<string, number>;
};

function textBlockEntries(
  blocks: Block[],
  blocksHaveMarkerOwnership: boolean,
): TextBlockEntry[] {
  const ownedBlocks = blocksHaveMarkerOwnership ? blocks : withMarkerOwnership(blocks);
  const projectedBlocks = withLegacyOwnershipProjection(ownedBlocks);
  const entries: TextBlockEntry[] = [];
  let previousTextBlock: Block | null = null;
  for (let i = 0; i < projectedBlocks.length; i++) {
    if (!isMarkerBlock(projectedBlocks[i])) {
      const block = projectedBlocks[i];
      entries.push({
        block,
        previousBlock: previousTextBlock,
        sourceIndex: i,
      });
      previousTextBlock = block;
    }
  }
  return entries;
}

function samePaginationHeightFeature(a: PaginationHeightFeature, b: PaginationHeightFeature): boolean {
  return a.normalHeight === b.normalHeight &&
    a.forcedHeight === b.forcedHeight &&
    a.startsScene === b.startsScene;
}

function normalizeDirtyRanges(dirty: MarkerOwnershipDirty, length: number): MarkerOwnershipRange[] | null {
  if (dirty === "full") return null;
  if (!dirty) return [];
  const ranges = Array.isArray(dirty) ? dirty : [dirty];
  const normalized = ranges
    .map((range) => ({
      ...range,
      start: Math.max(0, Math.min(length, range.start)),
      end: Math.max(0, Math.min(length, range.end)),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  const merged: MarkerOwnershipRange[] = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function firstEntryAtOrAfter(entries: Array<Pick<TextBlockEntry, "sourceIndex">>, sourceIndex: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid].sourceIndex < sourceIndex) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Returns a mapping of blockId → page number (1-based).
 * Mirrors the layout algorithm in computePrintPages (ScriptEditor.tsx).
 */
export function computePageMap(
  blocks: Block[],
  layout: PageLayout = "a4",
  textLayoutMode: ScriptTextLayoutMode = "center",
  blocksHaveMarkerOwnership = false,
): Record<string, number> {
  const cfg = PAGE_CONFIGS[layout];
  const ctx = estimateContext(cfg, templateForTextLayoutMode(textLayoutMode));
  const maxH = contentHeight(cfg);

  const pageMap: Record<string, number> = {};
  let page = 1;
  let used = 0;
  let hasBlockOnPage = false;
  let prevTextBlock: Block | null = null;

  const ownedBlocks = blocksHaveMarkerOwnership ? blocks : withMarkerOwnership(blocks);
  const textBlocks = withLegacyOwnershipProjection(ownedBlocks).filter((block) => !isMarkerBlock(block));
  for (let i = 0; i < textBlocks.length; i++) {
    const block = textBlocks[i];
    const prev = prevTextBlock;

    const feature = paginationHeightFeature(block, prev, ctx);
    if (feature.startsScene) {
      if (used > 0 && used + ctx.sceneHeadingHeight > maxH) {
        page++;
        used = 0;
        hasBlockOnPage = false;
      }
      used += ctx.sceneHeadingHeight;
    }

    let height = hasBlockOnPage ? feature.normalHeight : feature.forcedHeight;
    if (used > 0 && used + height > maxH) {
      page++;
      used = 0;
      hasBlockOnPage = false;
      height = feature.forcedHeight;
    }

    pageMap[block.id] = page;
    used += height;
    hasBlockOnPage = true;
    prevTextBlock = block;
  }

  return pageMap;
}

export function updateEstimatedPageMap(
  previous: EstimatedPageMapCache | null,
  blocks: Block[],
  layout: PageLayout = "a4",
  textLayoutMode: ScriptTextLayoutMode = "center",
  blocksHaveMarkerOwnership = false,
  dirty: MarkerOwnershipDirty = "full",
): EstimatedPageMapCache {
  const cfg = PAGE_CONFIGS[layout];
  const ctx = estimateContext(cfg, templateForTextLayoutMode(textLayoutMode));
  const maxH = contentHeight(cfg);
  const entries = textBlockEntries(blocks, blocksHaveMarkerOwnership);
  const ranges = normalizeDirtyRanges(dirty, blocks.length);
  const canReuse =
    previous &&
    ranges &&
    previous.layout === layout &&
    previous.textLayoutMode === textLayoutMode &&
    previous.blocksHaveMarkerOwnership === blocksHaveMarkerOwnership;

  let startTextIndex = 0;
  if (canReuse) {
    let firstFeatureChange = entries.length;
    const compareCandidate = (index: number): boolean => {
      const current = entries[index];
      const cached = previous.entries[index];
      if (!current && !cached) return false;
      if (!current || !cached || cached.blockId !== current.block.id) {
        firstFeatureChange = Math.min(firstFeatureChange, index);
        return true;
      }
      if (
        cached.block !== current.block ||
        cached.previousBlock !== current.previousBlock
      ) {
        const feature = paginationHeightFeature(current.block, current.previousBlock, ctx);
        if (!samePaginationHeightFeature(cached.heightFeature, feature)) {
          firstFeatureChange = Math.min(firstFeatureChange, index);
          return true;
        }
      }
      return false;
    };
    if (ranges.length === 0) {
      const length = Math.max(entries.length, previous.entries.length);
      for (let index = 0; index < length; index++) {
        if (compareCandidate(index)) break;
      }
    } else {
      const candidates = new Set<number>();
      for (const range of ranges) {
        const start = firstEntryAtOrAfter(entries, range.start);
        const end = firstEntryAtOrAfter(entries, range.end);
        for (let index = start; index <= end; index++) candidates.add(index);
      }
      for (const current of candidates) {
        compareCandidate(current);
      }
    }
    if (firstFeatureChange === entries.length && entries.length === previous.entries.length) return previous;
    if (firstFeatureChange === entries.length) {
      firstFeatureChange = Math.min(entries.length, previous.entries.length);
    }
    startTextIndex = Math.max(0, firstFeatureChange - 1);
    startTextIndex = Math.min(startTextIndex, previous.entries.length);
    const reusablePrefixEnd = Math.min(startTextIndex, previous.entries.length, entries.length);
    for (let i = 0; i < reusablePrefixEnd; i++) {
      const cached = previous.entries[i];
      const current = entries[i];
      if (cached.blockId !== current.block.id) {
        startTextIndex = i;
        break;
      }
    }
  }

  const pageMap: Record<string, number> = {};
  const nextEntries: EstimatedPageMapCacheEntry[] = [];
  let page = 1;
  let used = 0;
  let hasBlockOnPage = false;

  if (canReuse && startTextIndex > 0) {
    for (let i = 0; i < startTextIndex; i++) {
      const cached = previous.entries[i];
      nextEntries.push(cached);
      pageMap[cached.blockId] = cached.page;
    }
    const prefix = previous.entries[startTextIndex - 1];
    page = prefix.page;
    used = prefix.usedAfter;
    hasBlockOnPage = true;
  }

  for (let i = startTextIndex; i < entries.length; i++) {
    const { block } = entries[i];

    const cached = canReuse ? previous.entries[i] : null;
    const heightFeature = cached?.block === block && cached.previousBlock === entries[i].previousBlock
      ? cached.heightFeature
      : paginationHeightFeature(block, entries[i].previousBlock, ctx);
    if (heightFeature.startsScene) {
      if (used > 0 && used + ctx.sceneHeadingHeight > maxH) {
        page++;
        used = 0;
        hasBlockOnPage = false;
      }
      used += ctx.sceneHeadingHeight;
    }

    let height = hasBlockOnPage ? heightFeature.normalHeight : heightFeature.forcedHeight;
    if (used > 0 && used + height > maxH) {
      page++;
      used = 0;
      hasBlockOnPage = false;
      height = heightFeature.forcedHeight;
    }

    pageMap[block.id] = page;
    used += height;
    hasBlockOnPage = true;
    nextEntries.push({
      block,
      blockId: block.id,
      previousBlock: entries[i].previousBlock,
      heightFeature,
      page: pageMap[block.id],
      usedAfter: used,
    });
  }

  return {
    layout,
    textLayoutMode,
    blocksHaveMarkerOwnership,
    entries: nextEntries,
    pageMap,
  };
}
