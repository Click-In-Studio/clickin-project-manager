// 表格节点的 markdown 序列化（#694）。
//
// tiptap-markdown 0.9.0 内置的 table serializer 只在单元格 `textContent.trim()`
// 非空时才 renderInline——# 引用 chip（contentMention）是原子节点、textContent
// 恒为空串，单独占一格时整格内容被跳过，保存即丢；块级图片（WikiImage）直接
// 落在单元格里时 firstChild 不是段落，renderInline 一个子节点都没有，同样丢。
// 保真锁拦不住：它比的是加载往返，用户在编辑器里**新写**进去的引用从来没进过
// 存储形态，两边都没有，自然一致。
//
// 这里以同名节点扩展 Table 并自带 storage.markdown.serialize（与 WikiImage 同款
// 机制：tiptap-markdown 按扩展名取 spec，自带的覆盖内置的），只改两处：
//   ① 单元格「有内容」的判定改为：任一非文本子节点，或文本非空白；
//   ② 单元格首块是块级原子（图片）时按它自己的 serializer 写出，但吞掉它的
//      closeBlock——表格行内不能换行。
// 复杂表格（#526）改写具名容器，单元格使用同一 Markdown serializer。
// HTML 仅用于剪贴板 DOM，不再作为复杂表格的存储回退。
//
// 零 node 依赖，可进客户端包。
import type { Editor } from "@tiptap/core";
import type MarkdownIt from "markdown-it";
import { installTableContainers, serializeTableContainer } from "./tiptap-rich-table";
import { Table } from "@tiptap/extension-table";
import type { Node as PmNode } from "@tiptap/pm/model";

/** 只声明用到的 state 面；`inTable` 是 tiptap-markdown 子类字段，原版 state 运行期赋值即可 */
type TableMdState = {
  inTable?: boolean;
  closed: PmNode | null;
  write(s: string): void;
  ensureNewLine(): void;
  renderInline(parent: PmNode): void;
  render(node: PmNode, parent: PmNode, index: number): void;
  closeBlock(node: PmNode): void;
};

/** GFM 不能保留的网格、宽度、块内容转入富表格容器。 */
function hasSpan(cell: PmNode): boolean {
  return cell.attrs.colspan > 1 || cell.attrs.rowspan > 1
    || cell.attrs.colwidth?.some(Boolean) || !!cell.attrs.align
    || (cell.firstChild?.type.name !== "paragraph" && cell.firstChild?.type.name !== "image");
}
export function isMarkdownSerializable(table: PmNode): boolean {
  const rows: PmNode[] = [];
  table.forEach((r) => { rows.push(r); });
  const [head, ...body] = rows;
  if (!head) return false;
  const cells = (row: PmNode) => { const out: PmNode[] = []; row.forEach((c) => { out.push(c); }); return out; };
  if (cells(head).some((c) => c.type.name !== "tableHeader" || hasSpan(c) || c.childCount > 1)) return false;
  return !body.some((row) => cells(row).some((c) => c.type.name === "tableHeader" || hasSpan(c) || c.childCount > 1));
}

/** 段落里有没有值得写出的东西：任一非文本子节点（引用 chip、硬换行…），或非空白文本 */
export function hasRenderableInline(p: PmNode): boolean {
  let has = false;
  p.forEach((child) => {
    if (!child.isText || (child.text ?? "").trim()) has = true;
  });
  return has;
}

export const MarkdownTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(this: { editor: Editor }, state: TableMdState, node: PmNode) {
          if (!isMarkdownSerializable(node)) {
            // 按行 write，保留父级引用/列表的缩进；不把整表压进一行。
            for (const line of serializeTableContainer(this.editor, node).split("\n")) {
              state.write(line + "\n");
            }
            state.closeBlock(node);
            return;
          }
          state.inTable = true;
          node.forEach((row, _rowPos, i) => {
            state.write("| ");
            row.forEach((cell, _cellPos, j) => {
              if (j) state.write(" | ");
              const first = cell.firstChild;
              if (!first) return;
              if (first.isAtom) {
                // 块级原子（图片）：走它自己的 serializer，但不许它关块换行。
                // 非原子的非文本块（列表等）维持上游行为：renderInline 逐子节点渲染
                state.render(first, cell, 0);
                state.closed = null;
              } else if (hasRenderableInline(first)) {
                state.renderInline(first);
              }
            });
            state.write(" |");
            state.ensureNewLine();
            if (!i) {
              const delimiterRow = Array.from({ length: row.childCount }).map(() => "---").join(" | ");
              state.write(`| ${delimiterRow} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          setup(this: { editor: Editor }, md: MarkdownIt) {
            installTableContainers(md, this.editor);
          },
        },
      },
    };
  },
});
