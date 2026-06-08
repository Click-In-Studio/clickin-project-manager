import type { Block } from "./script-types";
import type { PageLayout, ScriptTextLayoutMode } from "./script-types";

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

function estimateBlockHeight(block: Block, prev: Block | null, upl: number, forceCharName = false): number {
  const text = stripHtml(block.content);
  const stageComment = (block.stageComment ?? "").trim();
  const stageCommentText = block.type === "dialogue" && block.characterIds.length > 0 && stageComment
    ? stageComment.split(/\r\n|\r|\n/).map(line => `（${line}）`).join("\n")
    : "";
  const lines = estimateLines(stageCommentText ? `${stageCommentText}\n${text}` : text, upl);
  const hideCharName = !forceCharName && charNameHidden(block, prev);
  const charNameH =
    block.type === "dialogue" && block.characterIds.length > 0 && (forceCharName || !hideCharName)
      ? CHAR_NAME_HEIGHT : 0;
  const wrapperPaddingH = block.type === "stage" || hideCharName ? 0 : 8; // 8px = py-1 wrapper
  return charNameH + lines * LINE_HEIGHT + wrapperPaddingH;
}

/**
 * Returns a mapping of blockId → page number (1-based).
 * Mirrors the layout algorithm in computePrintPages (ScriptEditor.tsx).
 */
export function computePageMap(
  blocks: Block[],
  layout: PageLayout = "a4",
  textLayoutMode: ScriptTextLayoutMode = "center",
): Record<string, number> {
  const cfg = PAGE_CONFIGS[layout];
  const upl = unitsPerLine(cfg, textLayoutMode);
  const maxH = contentHeight(cfg);

  const pageMap: Record<string, number> = {};
  let page = 1;
  let used = 0;
  let hasBlockOnPage = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const prev = i > 0 ? blocks[i - 1] : null;

    if (block.sceneId && block.sceneId !== prev?.sceneId) {
      if (used > 0 && used + SCENE_HEADER_HEIGHT > maxH) {
        page++;
        used = 0;
        hasBlockOnPage = false;
      }
      used += SCENE_HEADER_HEIGHT;
    }

    let h = estimateBlockHeight(block, prev, upl, !hasBlockOnPage);
    if (used > 0 && used + h > maxH) {
      page++;
      used = 0;
      hasBlockOnPage = false;
      h = estimateBlockHeight(block, prev, upl, true);
    }
    pageMap[block.id] = page;
    used += h;
    hasBlockOnPage = true;
  }

  return pageMap;
}
