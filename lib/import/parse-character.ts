import type { ParsedChar, CharKind } from "./types";

/**
 * Detect the kind of a character name and extract note if present.
 *
 * Heuristics:
 *   - Names with parenthesized suffix like "张三（备注）" → note
 *   - Names with uppercase ASCII suffix like "女VO", "甲A" → note (suffix is annotation)
 *   - Names containing aggregate indicators → aggregate
 *   - Plain names → normal
 */
export function parseCharacter(raw: string): ParsedChar {
  const s = raw.trim();

  // Parenthetical note: 张三（备注）or 张三(备注)
  const parenMatch = s.match(/^(.+?)[（(](.+?)[）)]\s*$/);
  if (parenMatch) {
    const name = parenMatch[1].trim();
    const note = parenMatch[2].trim();
    const kind: CharKind = /们|全体|合唱|合|众|群/.test(name) ? "aggregate" : "note";
    return { raw: s, name, kind, note };
  }

  // Uppercase suffix annotation: "女VO" → name="女", note="VO"
  // Only split when the prefix contains at least one non-ASCII character (CJK),
  // so pure-ASCII names like "AI" or "ENS" are left intact.
  const suffixMatch = s.match(/^(.+?)([A-Z]{1,4})$/);
  if (suffixMatch && suffixMatch[1].trim() && /[^\x00-\x7F]/.test(suffixMatch[1])) {
    const name = suffixMatch[1].trim();
    const note = suffixMatch[2];
    const kind: CharKind = /们|全体|合唱|合|众|群/.test(name) ? "aggregate" : "note";
    return { raw: s, name, kind, note };
  }

  // Aggregate indicators
  if (/们|全体|合唱|合|众|群/.test(s)) {
    return { raw: s, name: s, kind: "aggregate" };
  }

  return { raw: s, name: s, kind: "normal" };
}

/**
 * Guess if this is an aggregate character based on name.
 * Used when user hasn't specified kind explicitly.
 */
export function guessIsAggregate(name: string): boolean {
  return /们|全体|合唱|合|众|群/.test(name);
}

/**
 * Deduplicate and collect unique character names from a list of raw cell values.
 * Each cell may contain multiple characters separated by common delimiters.
 */
export function collectCharacters(rawValues: string[]): ParsedChar[] {
  const seen = new Set<string>();
  const result: ParsedChar[] = [];

  for (const raw of rawValues) {
    if (!raw?.trim()) continue;
    // Split on common delimiters: comma, Chinese comma, slash, newline
    const parts = raw.split(/[,，\n]+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const parsed = parseCharacter(trimmed);
      if (!seen.has(parsed.name)) {
        seen.add(parsed.name);
        result.push(parsed);
      }
    }
  }
  return result;
}
