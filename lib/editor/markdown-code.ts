// 基于 Markdown AST 隔离代码；支持任意长度的反引号、波浪围栏及缩进代码。
import { parseMarkdownTree, type MarkdownNode } from "./table-dialect";

export function mapMarkdownOutsideCode(source: string, change: (text: string) => string, keepCode = true): string {
  const ranges: { start: number; end: number }[] = [];
  const walk = (node: MarkdownNode) => {
    if ((node.type === "code" || node.type === "inlineCode") && node.position?.start.offset != null && node.position.end.offset != null) {
      ranges.push({ start: node.position.start.offset, end: node.position.end.offset });
    } else node.children?.forEach(walk);
  };
  walk(parseMarkdownTree(source));
  let at = 0;
  let out = "";
  for (const { start, end } of ranges) {
    out += change(source.slice(at, start)) + (keepCode ? source.slice(start, end) : "\n");
    at = end;
  }
  return out + change(source.slice(at));
}
export const markdownOutsideCode = (source: string): string => mapMarkdownOutsideCode(source, s => s, false);
