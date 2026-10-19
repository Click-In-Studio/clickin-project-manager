/** 文本坐标统一为零起始 UTF-16 单元，区间首含尾不含。 */
export interface TextWindow { offset?: number; length?: number }
export const TEXT_WINDOW_MAX = 80_000;
export function textWindow(text: string, window: TextWindow = {}, defaultLength = 8000) {
  const offset = window.offset ?? 0, length = window.length ?? defaultLength;
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length || !Number.isInteger(length) || length < 1 || length > TEXT_WINDOW_MAX)
    throw new Error(`窗口无效：0 ≤ offset ≤ ${text.length}，1 ≤ length ≤ ${TEXT_WINDOW_MAX}；单位 UTF-16，首含尾不含。`);
  const end = Math.min(text.length, offset + length);
  return { offset, end, total: text.length, nextOffset: end < text.length ? end : null, text: text.slice(offset, end) };
}
export function formatTextWindow(text: string, window: TextWindow = {}, defaultLength = 8000): string {
  const value = textWindow(text, window, defaultLength);
  return `${JSON.stringify({ ...value, text: undefined, unit: "UTF-16", interval: "[offset,end)" })}\n${value.text}`
    + (value.nextOffset === null ? "" : `\n（有省略；继续读取 offset=${value.nextOffset}）`);
}
export function searchText(text: string, query: string, limit = 20, offset = 0): string {
  if (!query) throw new Error("query 不能为空");
  textWindow(text, { offset, length: 1 });
  const matches = []; let cursor = offset;
  const cap = Math.max(1, Math.min(50, limit));
  while (matches.length < cap) {
    const at = text.indexOf(query, cursor);
    if (at < 0) break;
    const from = Math.max(0, at - 80), to = Math.min(text.length, at + Math.min(query.length, 200) + 160);
    matches.push({ offset: at, end: at + query.length, contextOffset: from, context: text.slice(from, to) });
    cursor = at + query.length;
  }
  return JSON.stringify({ unit: "UTF-16", total: text.length, matches, nextOffset: text.indexOf(query, cursor) >= 0 ? cursor : null });
}
