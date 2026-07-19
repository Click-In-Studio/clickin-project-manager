import type { Block } from "./script-types";
import type { PageLayout, ScriptTextLayoutMode } from "./script-types";
import {
  isMarkerBlock,
  withLegacyOwnershipProjection,
  withMarkerOwnership,
} from "./script-marker-blocks";
import type { MarkerOwnershipDirty, MarkerOwnershipRange } from "./script-marker-ownership-cache";

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

const LINE_HEIGHT    = 28;  // leading-7 (1.75rem)
const FONT_SIZE      = 14;  // text-sm (0.875rem at 16px base)
const CHAR_NAME_HEIGHT   = 22;  // text-sm (20px) + mb-0.5 (2px)
const SCENE_HEADER_HEIGHT = 44; // py-3 (24px) + text-sm content (20px)
export const COMPACT_TEXT_SIDE_WIDTH_REM = 9.5;
const REM_SIZE = 16;

function contentWidth(cfg: PageConfig): number {
  return cfg.width - 2 * cfg.marginX;
}
function contentHeight(cfg: PageConfig): number {
  return cfg.height - cfg.marginTop - cfg.marginBottom;
}
function unitsPerLine(cfg: PageConfig, textLayoutMode: ScriptTextLayoutMode = "center"): number {
  const width = contentWidth(cfg);
  const compactTextWidth = textLayoutMode === "compact"
    ? width - COMPACT_TEXT_SIDE_WIDTH_REM * REM_SIZE
    : width;
  return Math.max(1, Math.floor(compactTextWidth / FONT_SIZE));
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function estimateLines(text: string, upl: number): number {
  if (!text.trim()) return 1;
  let total = 0;
  for (const paragraph of text.split("\n")) {
    let units = 0;
    let lineCount = 1;
    for (const ch of paragraph) {
      const isCJK = /[⺀-⿿　-鿿豈-﫿︰-﹏]/.test(ch);
      units += isCJK ? 1 : 0.5;
      if (units > upl) {
        lineCount++;
        units = isCJK ? 1 : 0.5;
      }
    }
    total += lineCount;
  }
  return total || 1;
}

function sameCharacters(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

function charNameHidden(block: Block, prev: Block | null): boolean {
  if (block.forceShowCharacterName) return false;
  if (!prev || prev.type !== "dialogue" || block.type !== "dialogue") return false;
  if (block.sceneId !== prev.sceneId) return false;
  if (block.rehearsalMark !== prev.rehearsalMark) return false;
  return sameCharacters(prev.characterIds, block.characterIds);
}

type PaginationHeightFeature = {
  normalHeight: number;
  forcedHeight: number;
  startsScene: boolean;
};

function paginationHeightFeature(block: Block, prev: Block | null, upl: number): PaginationHeightFeature {
  const text = stripHtml(block.content);
  const stageComment = (block.stageComment ?? "").trim();
  const stageCommentText = block.type === "dialogue" && block.characterIds.length > 0 && stageComment
    ? stageComment.split(/\r\n|\r|\n/).map(line => `（${line}）`).join("\n")
    : "";
  const lines = estimateLines(stageCommentText ? `${stageCommentText}\n${text}` : text, upl);
  const hasCharacterName = block.type === "dialogue" && block.characterIds.length > 0;
  const hideCharName = charNameHidden(block, prev);
  const normalPadding = block.type === "stage" || hideCharName ? 0 : 8; // 8px = py-1 wrapper
  const forcedPadding = block.type === "stage" ? 0 : 8;
  return {
    normalHeight: lines * LINE_HEIGHT + normalPadding + (hasCharacterName && !hideCharName ? CHAR_NAME_HEIGHT : 0),
    forcedHeight: lines * LINE_HEIGHT + forcedPadding + (hasCharacterName ? CHAR_NAME_HEIGHT : 0),
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
  const upl = unitsPerLine(cfg, textLayoutMode);
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

    const feature = paginationHeightFeature(block, prev, upl);
    if (feature.startsScene) {
      if (used > 0 && used + SCENE_HEADER_HEIGHT > maxH) {
        page++;
        used = 0;
        hasBlockOnPage = false;
      }
      used += SCENE_HEADER_HEIGHT;
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
  const upl = unitsPerLine(cfg, textLayoutMode);
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
        const feature = paginationHeightFeature(current.block, current.previousBlock, upl);
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
      : paginationHeightFeature(block, entries[i].previousBlock, upl);
    if (heightFeature.startsScene) {
      if (used > 0 && used + SCENE_HEADER_HEIGHT > maxH) {
        page++;
        used = 0;
        hasBlockOnPage = false;
      }
      used += SCENE_HEADER_HEIGHT;
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
