// Anchor kinds:
//   block — precise character offset within a block's content string
//           offset 0 = before first char, content.length = after last char
//   gap   — the visual whitespace rendered between two consecutive blocks
//           afterBlockId = the block that immediately precedes the gap
//           afterBlockId null = gap before the very first block

export type CueAnchor =
  | { kind: "block"; blockId: string; offset: number }
  | { kind: "gap"; afterBlockId: string | null };

// Point cue: start and end are identical.
export type Cue = {
  id: string;
  cueListId: string;
  number: string;
  name: string;
  content: string;
  start: CueAnchor;
  end: CueAnchor;
  warning: boolean;
};

// ─── Drift helpers ────────────────────────────────────────────────────────────

/** Levenshtein distance (capped at max for efficiency). */
function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (a.length === 0) return Math.min(b.length, cap);
  if (b.length === 0) return Math.min(a.length, cap);
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(cur + 1, prev[j] + 1, prev[j - 1] + cost);
      prev[j - 1] = cur;
      cur = next;
    }
    prev[b.length] = cur;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - editDistance(a, b, maxLen) / maxLen;
}

export type DriftResult = {
  startOffset: number;
  endOffset: number;
  warning: boolean;
};

/**
 * Adjust a same-block range anchor after block content changes.
 * Implements the three-tier algorithm:
 *  1. Exact text match   → move silently
 *  2. Fuzzy match ≥ 0.5  → move + warn
 *  3. No match < 0.3     → expand to whole block + warn
 *
 * For point cues (startOffset === endOffset) or when there is no selected
 * text to match, falls back to LCS offset adjustment.
 */
export function adjustBlockAnchor(
  oldContent: string,
  newContent: string,
  startOffset: number,
  endOffset: number,
): DriftResult {
  const oldText = oldContent.slice(startOffset, endOffset);

  // ── Point cue or empty selection: LCS offset shift ────────────────────────
  if (oldText.length === 0) {
    const adjusted = lcsAdjust(oldContent, newContent, startOffset);
    return { startOffset: adjusted, endOffset: adjusted, warning: false };
  }

  // ── Case 1: exact match ────────────────────────────────────────────────────
  const exactIdx = newContent.indexOf(oldText);
  if (exactIdx !== -1) {
    return {
      startOffset: exactIdx,
      endOffset: exactIdx + oldText.length,
      warning: false,
    };
  }

  // ── Case 2 / 3: scan windows of same length for best fuzzy match ──────────
  const len = oldText.length;
  let bestSim = 0;
  let bestIdx = 0;
  // Try windows of the same length; if text shortened, also try smaller windows
  const windowLen = Math.min(len, newContent.length);
  for (let i = 0; i <= newContent.length - windowLen; i++) {
    const window = newContent.slice(i, i + windowLen);
    const sim = similarity(oldText, window);
    if (sim > bestSim) { bestSim = sim; bestIdx = i; }
  }

  if (bestSim >= 0.5) {
    return {
      startOffset: bestIdx,
      endOffset: bestIdx + windowLen,
      warning: true,
    };
  }

  // Case 3: expand to whole block
  return {
    startOffset: 0,
    endOffset: newContent.length,
    warning: true,
  };
}

/**
 * Simple LCS-based offset adjustment for a single offset in a changed block.
 * Finds common prefix + suffix, then snaps offsets inside the changed region
 * to the end of the new replacement.
 */
export function lcsAdjust(oldContent: string, newContent: string, offset: number): number {
  let pLen = 0;
  while (pLen < oldContent.length && pLen < newContent.length && oldContent[pLen] === newContent[pLen]) pLen++;

  let sLen = 0;
  while (
    sLen < oldContent.length - pLen &&
    sLen < newContent.length - pLen &&
    oldContent[oldContent.length - 1 - sLen] === newContent[newContent.length - 1 - sLen]
  ) sLen++;

  const delLen = oldContent.length - pLen - sLen;
  const insLen = newContent.length - pLen - sLen;

  if (offset <= pLen) return offset;
  if (offset <= pLen + delLen) return pLen + insLen; // snap to after replacement
  return offset + (insLen - delLen);
}
