import type { ParsedSceneNum } from "./types";

/**
 * Parse a raw scene number cell into structured parent/child numbers and names.
 *
 * Handles:
 *   "1"         → parent 1 (no child)
 *   "01"        → parent 01 (pure numeric — treat as top-level)
 *   "1-1"       → parent 1, child 1-1
 *   "1-1 供养"  → parent 1, child 1-1, childName "供养"
 *   "1选择-1"   → parent 1, parentName "选择", child 1-1
 *   "1选择"     → parent 1, parentName "选择" (no child)
 *   "00"/"01"   → pure numeric top-level acts (isTopLevel pure-number pattern)
 */
export function parseSceneNum(raw: string): ParsedSceneNum | null {
  const s = raw.trim();
  if (!s) return null;

  // Patterns:
  //   topLevel: digit(s) optionally followed by CJK/alpha name, no dash
  //   child: digit(s)[name]-digit(s) optionally followed by space+name

  // Match: optional leading number + optional name + "-" + trailing number + optional space name
  // e.g. "1选择-1", "1-1", "1-1 供养", "2-3a 场景名"
  const childMatch = s.match(/^(\d+)([^\d\-]*)[-–](\d+(?:[a-z]?))(?:\s+(.+))?$/i);
  if (childMatch) {
    const parentNum = childMatch[1];
    const parentName = childMatch[2].trim() || null;
    const childSuffix = childMatch[3];
    const childName = childMatch[4]?.trim() || null;
    return {
      raw: s,
      parentNum,
      parentName,
      childNum: `${parentNum}-${childSuffix}`,
      childName,
    };
  }

  // Top-level: digits + optional CJK/alpha name, no dash
  // e.g. "1", "01", "1选择", "一"
  const topMatch = s.match(/^(\d+)([^\d\-]*)$/);
  if (topMatch) {
    const parentNum = topMatch[1];
    const parentName = topMatch[2].trim() || null;
    return {
      raw: s,
      parentNum,
      parentName,
      childNum: null,
      childName: null,
    };
  }

  // Fallback: treat the whole thing as a child-only num (e.g. "一-1" or exotic formats)
  return {
    raw: s,
    parentNum: null,
    parentName: null,
    childNum: s,
    childName: null,
  };
}

/**
 * Collect all unique parent numbers implied by a list of parsed scene nums.
 * Ensures parents are created before children.
 */
export function collectParents(parsed: ParsedSceneNum[]): { num: string; name: string | null }[] {
  const seen = new Set<string>();
  const parents: { num: string; name: string | null }[] = [];
  for (const p of parsed) {
    if (p.parentNum && !seen.has(p.parentNum)) {
      seen.add(p.parentNum);
      parents.push({ num: p.parentNum, name: p.parentName });
    }
  }
  return parents;
}
