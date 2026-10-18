import { runInNewContext } from "node:vm";

export type LineRange = { startLine?: number; endLine?: number };
export type TextMatch = { start: number; end: number; text: string; replacement: string };
export type WikiPatchEdit = LineRange & {
  oldText: string;
  newText: string;
  matchMode?: "literal" | "regex";
  flags?: string;
  occurrence?: "single" | "all";
  expectedMatches?: number;
};

/** 行号只用于定位，永不混入 Markdown；范围按同一次读取的正文计算，首尾包含。 */
export function lineWindow(body: string, range: LineRange = {}) {
  const lines = body.split("\n");
  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? lines.length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
      || startLine < 1 || endLine < startLine || startLine > lines.length || endLine > lines.length) {
    throw new Error(`行范围无效：文档共 ${lines.length} 行，请使用从 1 开始、首尾包含的范围。`);
  }
  const start = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
  const text = lines.slice(startLine - 1, endLine).join("\n");
  return { startLine, endLine, totalLines: lines.length, start, text };
}

// 正则仅接收数据，不拼接模型代码。整个匹配与捕获组展开受 VM 超时约束，
// 避免灾难性回溯占住 runner；输出数量也受限。不是执行任意代码的沙箱。
const REGEX_MATCHES = `
  const regex = new RegExp(pattern, flags + 'g');
  const matches = [];
  let outputSize = 0;
  text.replace(regex, (...args) => {
    if (matches.length >= limit) throw new Error('匹配数量过多，请缩小范围');
    const named = typeof args[args.length - 1] === 'object' ? args.pop() : undefined;
    args.pop(); // 完整输入；只保留偏移与捕获组
    const start = args.pop();
    const [whole, ...captures] = args;
    if (!whole.length) throw new Error('不支持零长度正则匹配，请匹配实际原文');
    const replacement = newText.replace(/\\$(\\$|&|[0-9]{1,2}|<[^>]+>)/g, (raw, key) => {
      if (key === '$') return '$';
      if (key === '&') return whole;
      if (key[0] === '<') return named && Object.hasOwn(named, key.slice(1, -1)) ? (named[key.slice(1, -1)] ?? '') : raw;
      const n = Number(key);
      if (n > 0 && n <= captures.length) return captures[n - 1] ?? '';
      if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) <= captures.length) return (captures[Number(key[0]) - 1] ?? '') + key[1];
      return raw;
    });
    outputSize += replacement.length;
    if (outputSize > 5000000) throw new Error('替换结果过大，请缩小范围');
    matches.push({ start, end: start + whole.length, text: whole, replacement });
    return whole;
  });
  matches;
`;

export function textMatches(
  text: string, pattern: string, newText = "", mode: "literal" | "regex" = "literal", flags = "", limit = 10000,
): TextMatch[] {
  if (!pattern) throw new Error("匹配内容不能为空；插入请匹配插入位置附近的原文并在新文中保留它。");
  if (mode !== "literal" && mode !== "regex") throw new Error("patch 只允许 literal 或 regex 匹配，不允许模糊匹配。");
  if (mode === "regex") {
    if (!/^(?!.*(.).*\1)[imsu]*$/.test(flags)) throw new Error("正则 flags 只允许不重复的 i、m、s、u；全部替换使用 occurrence=all。");
    if (pattern.length > 2000) throw new Error("正则过长，请缩小表达式。");
    try {
      return runInNewContext(REGEX_MATCHES, { text, pattern, newText, flags, limit }, { timeout: 200 }) as TextMatch[];
    } catch (error) {
      throw new Error(`正则匹配失败或超时：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (flags) throw new Error("字面量匹配不接受正则 flags。");
  const matches: TextMatch[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(pattern, cursor);
    if (start < 0) return matches;
    if (matches.length >= limit) throw new Error("匹配数量过多，请缩小范围。");
    matches.push({ start, end: start + pattern.length, text: pattern, replacement: newText });
    cursor = start + pattern.length;
  }
}

/** 所有修改以原始正文为基准；拒绝重叠，不让数组顺序悄悄改变后续定位。 */
export function applyWikiPatch(body: string, edits: WikiPatchEdit[]) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error("每批需提供 1–100 项修改。");
  const replacements: TextMatch[] = [];
  const counts: number[] = [];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") throw new Error(`第 ${index + 1} 项需提供 oldText 和 newText 字符串。`);
    if (edit.occurrence !== undefined && edit.occurrence !== "single" && edit.occurrence !== "all") throw new Error("occurrence 只允许 single 或 all。");
    const window = lineWindow(body, edit);
    const matches = textMatches(window.text, edit.oldText, edit.newText, edit.matchMode, edit.flags);
    if (!matches.length) throw new Error(`第 ${index + 1} 项未匹配原文；请 search 后重试，未做任何修改。`);
    if (edit.occurrence !== "all" && matches.length !== 1) throw new Error(`第 ${index + 1} 项匹配到 ${matches.length} 处；请限定行范围或显式使用 occurrence=all。`);
    if (edit.expectedMatches !== undefined && (!Number.isInteger(edit.expectedMatches) || edit.expectedMatches < 1 || edit.expectedMatches !== matches.length)) {
      throw new Error(`第 ${index + 1} 项命中 ${matches.length} 处，与 expectedMatches 不符。`);
    }
    counts.push(matches.length);
    replacements.push(...matches.map(m => ({ ...m, start: m.start + window.start, end: m.end + window.start })));
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].start < replacements[i - 1].end) throw new Error("修改范围重叠，请合并为一项修改；整批未执行。");
  }
  const size = body.length + replacements.reduce((n, m) => n + m.replacement.length - (m.end - m.start), 0);
  if (size > 5_000_000) throw new Error("修改结果过大，请缩小范围。");
  const chunks: string[] = [];
  let cursor = 0;
  for (const match of replacements) {
    chunks.push(body.slice(cursor, match.start), match.replacement);
    cursor = match.end;
  }
  chunks.push(body.slice(cursor));
  const nextBody = chunks.join("");
  if (nextBody === body) throw new Error("修改前后正文相同，未提交提议。");
  return { body: nextBody, counts };
}

/** search 的命中位置批量映射，避免对每个匹配重复切割整篇长文。 */
export function lineLocator(body: string) {
  const starts = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === "\n") starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
}

function grams(text: string): Set<string> {
  const value = text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return new Set(value.length < 2 ? [value] : Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
}

/** 模糊仅找候选行：返回原文，后续 patch 仍需精确匹配。 */
export function fuzzyLineMatches(text: string, query: string) {
  if (!query.trim()) throw new Error("搜索内容不能为空。");
  const needle = grams(query);
  return text.split("\n").flatMap((line, index) => {
    const haystack = grams(line);
    const common = [...needle].filter(g => haystack.has(g)).length;
    const score = line.includes(query) ? 1 : 2 * common / (needle.size + haystack.size);
    return score >= 0.45 ? [{ index, score }] : [];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}
