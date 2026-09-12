import type { Block, Character } from "../script/script-types";
import type { Cue } from "./cue-types";

export type TextSegment = { text: string; underline?: boolean };

const CTX = 15;

/** Text before offset, stopping at any preceding newline, then truncating. */
function truncBefore(text: string, offset: number): string {
  if (offset <= 0) return "";
  const before = text.slice(0, offset);
  const lastNl = before.lastIndexOf("\n");
  const clean = lastNl >= 0 ? before.slice(lastNl + 1) : before;
  if (clean.length <= CTX) return clean;
  return "…" + clean.slice(-CTX);
}

/** Text after offset, stopping at the next newline, then truncating. */
function truncAfter(text: string, offset: number): string {
  if (offset >= text.length) return "";
  const after = text.slice(offset);
  const firstNl = after.indexOf("\n");
  const clean = firstNl >= 0 ? after.slice(0, firstNl) : after;
  if (clean.length <= CTX) return clean;
  return clean.slice(0, CTX) + "…";
}

/** The selected slice, stripping newlines and truncating for display. */
function selectedText(content: string, start: number, end: number): string {
  const raw = content.slice(start, end);
  const firstNl = raw.indexOf("\n");
  const clean = firstNl >= 0 ? raw.slice(0, firstNl) + "…" : raw;
  return clean.length > 20 ? clean.slice(0, 20) + "…" : clean;
}

function charPrefix(block: Block, charMap: Map<string, string>): string {
  if (block.type === "stage") return "";
  const first = block.characterIds[0];
  return first ? (charMap.get(first) ?? "") + "：" : "";
}

function seg(text: string, underline?: boolean): TextSegment {
  return underline ? { text, underline: true } : { text };
}

/**
 * Format a cue's position as an array of text segments.
 * Segments with underline=true represent the cue's extent / anchor point.
 *
 * - Point cue:        prefix + context + [·] + context
 * - Same-block range: prefix + context + [selected text] + context
 * - Cross-block:      startPrefix + context + [tail of start block] → [head of end block] + context
 * - Gap:              blockA tail ↓ blockB head  (no underline — gap is structural)
 */
export function formatCuePosition(
  cue: Cue,
  blocks: Block[],
  characters: Character[],
): TextSegment[] {
  const charMap = new Map(characters.map((c) => [c.id, c.name]));
  const blockMap = new Map(blocks.map((b) => [b.id, b]));

  const { start, end } = cue;

  // ── Gap ──────────────────────────────────────────────────────────────────────
  if (start.kind === "gap") {
    const idx = blocks.findIndex((b) => b.id === start.afterBlockId);
    const before = idx >= 0 ? blocks[idx] : null;
    const after = idx >= 0 && idx + 1 < blocks.length ? blocks[idx + 1] : null;
    const parts: TextSegment[] = [];
    if (before) parts.push(seg(charPrefix(before, charMap) + truncBefore(before.content, before.content.length)));
    parts.push(seg(" ↓ "));
    if (after) parts.push(seg(charPrefix(after, charMap) + truncAfter(after.content, 0)));
    return parts;
  }

  const startBlock = blockMap.get(start.blockId);
  if (!startBlock) return [seg("（位置缺失）")];

  const prefix = charPrefix(startBlock, charMap);

  // ── Same block ────────────────────────────────────────────────────────────────
  if (end.kind === "block" && end.blockId === start.blockId) {
    const before = truncBefore(startBlock.content, start.offset);
    const after = truncAfter(startBlock.content, end.offset);

    if (start.offset === end.offset) {
      // Point cue — underline a space to mark the insertion point
      return [
        seg(prefix + before),
        seg(" ", true),
        seg(after),
      ].filter((s) => s.text.length > 0);
    }

    // Range — underline the selected text
    const sel = selectedText(startBlock.content, start.offset, end.offset);
    return [
      seg(prefix + before),
      seg(sel, true),
      seg(after),
    ].filter((s) => s.text.length > 0);
  }

  // ── Cross-block range ─────────────────────────────────────────────────────────
  const startBefore = truncBefore(startBlock.content, start.offset);
  const startTail = truncAfter(startBlock.content, start.offset);

  let endPrefix = "";
  let endHead = "";
  let endAfter = "";

  if (end.kind === "block") {
    const endBlock = blockMap.get(end.blockId);
    if (endBlock) {
      endPrefix = charPrefix(endBlock, charMap);
      endHead = truncBefore(endBlock.content, end.offset);
      endAfter = truncAfter(endBlock.content, end.offset);
    }
  } else {
    // end is gap — use the block that follows the gap
    const idx = blocks.findIndex((b) => b.id === end.afterBlockId);
    const after = idx >= 0 && idx + 1 < blocks.length ? blocks[idx + 1] : null;
    if (after) {
      endPrefix = charPrefix(after, charMap);
      endAfter = truncAfter(after.content, 0);
    }
  }

  return [
    seg(prefix + startBefore),
    ...(startTail ? [seg(startTail, true)] : []),
    seg(" → "),
    ...(endPrefix ? [seg(endPrefix)] : []),
    ...(endHead ? [seg(endHead, true)] : []),
    ...(endAfter ? [seg(endAfter)] : []),
  ].filter((s) => s.text.length > 0);
}
