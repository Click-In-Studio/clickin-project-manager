// 可视化编辑只重写变化的顶层块。源码范围来自 Markdown AST，不猜测空行分段。
// 表格内部由稳定 serializer 保证按格 diff；无法一一对应时显式退回 canonical。
import { diffArrays } from "diff";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { parseMarkdownTree, transformRichTables } from "./table-dialect";
import { EMPTY_PARAGRAPH_MD, isVisuallyEmptyParagraph } from "./tiptap-empty-paragraph";
import { checkFidelity } from "../wiki/fidelity";

type Serialize = (content: Fragment) => string;
export function preserveMarkdownSource(source: string, before: PmNode, after: PmNode, serialize: Serialize): string {
  const previous: string[] = [];
  const next: string[] = [];
  // 单独序列化空段会误以为它是独生块，必须保留真实文档里的父级上下文。
  const block = (n: PmNode, parent: PmNode) => parent.childCount > 1 && isVisuallyEmptyParagraph(n)
    ? EMPTY_PARAGRAPH_MD : serialize(Fragment.from(n)).trimEnd();
  before.forEach(n => previous.push(block(n, before)));
  after.forEach(n => next.push(block(n, after)));
  if (previous.length === next.length && previous.every((s, i) => s === next[i])) return source;
  const tree = parseMarkdownTree(source);
  transformRichTables(tree, source);
  const blocks = tree.children ?? [];
  if (blocks.length !== previous.length || blocks.some(b => b.position?.start.offset == null || b.position.end.offset == null)) {
    return serialize(after.content);
  }
  // 数量相同不等于逐块对应：一段多图会拆块，分栏又会合块，增减可能刚好抵消。
  if (blocks.some((b, i) => checkFidelity(source.slice(b.position!.start.offset!, b.position!.end.offset!), previous[i]).lossy)) {
    return serialize(after.content);
  }
  const patches: { start: number; end: number; replacement: string }[] = [];
  let index = 0;
  let pending: { from: number; to: number; lines: string[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const start = blocks[pending.from]?.position?.start.offset ?? source.length;
    const end = pending.to > pending.from ? blocks[pending.to - 1].position!.end.offset! : start;
    let replacement = pending.lines.join("\n\n");
    if (replacement && start === source.length && start > 0) replacement = "\n\n" + replacement;
    if (replacement && start === end && start < source.length) replacement += "\n\n";
    patches.push({ start, end, replacement });
    pending = null;
  };
  for (const part of diffArrays(previous, next)) {
    if (part.added || part.removed) {
      pending ??= { from: index, to: index, lines: [] };
      if (part.added) pending.lines.push(...part.value);
      else { index += part.value.length; pending.to = index; }
    } else { flush(); index += part.value.length; }
  }
  flush();
  let result = source;
  for (const patch of patches.reverse()) result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  return result;
}
