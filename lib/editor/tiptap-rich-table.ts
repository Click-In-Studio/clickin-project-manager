// 表格容器在编辑器侧的接线：复用完整 Markdown parser 解析每个单元格。
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import type MarkdownIt from "markdown-it";
import { richTableRanges, serializeRichTable, tableGrid, type RichTable, type TableCell } from "./table-dialect";

const patched = new WeakSet<MarkdownIt>();
type MarkdownStorage = {
  parser: { parse(text: string): string };
  serializer: { serialize(node: PmNode): string };
};
function storage(editor: Editor): MarkdownStorage {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;
}

export function serializeTableContainer(editor: Editor, node: PmNode): string {
  const rows: TableCell[][] = [];
  node.forEach(row => {
    const cells: TableCell[] = [];
    row.forEach(cell => {
      cells.push({
        header: cell.type.name === "tableHeader", colspan: cell.attrs.colspan || 1,
        rowspan: cell.attrs.rowspan || 1, colwidth: cell.attrs.colwidth || null,
        align: cell.attrs.align || null, body: storage(editor).serializer.serialize(cell),
      });
    });
    rows.push(cells);
  });
  return serializeRichTable({ rows });
}

export function tableContainerHtml(table: RichTable, render: (body: string) => string): string {
  const grid = tableGrid(table)!;
  const cols = grid.columns.map(w => `<col${w ? ` style="width:${w}px"` : ""}>`).join("");
  const rows = table.rows.map(row => `<tr>${row.map(cell => {
    const tag = cell.header ? "th" : "td";
    const width = cell.colwidth ? ` colwidth="${cell.colwidth.join(",")}"` : "";
    const align = cell.align ? ` style="text-align:${cell.align}"` : "";
    return `<${tag} colspan="${cell.colspan}" rowspan="${cell.rowspan}"${width}${align}>${render(cell.body) || "<p></p>"}</${tag}>`;
  }).join("")}</tr>`).join("");
  return `<table><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`;
}

export function installTableContainers(md: MarkdownIt, editor: Editor): void {
  if (patched.has(md)) return;
  patched.add(md);
  md.block.ruler.before("fence", "wiki_rich_table", (state, start, end, silent) => {
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (line !== ":::table") return false;
    const input = state.getLines(start, end, state.blkIndent, false);
    const range = richTableRanges(input).find(r => r.start === 0);
    if (!range) return false;
    if (silent) return true;
    const consumed = input.slice(0, range.end).split("\n").length;
    const token = state.push("html_block", "", 0);
    token.content = tableContainerHtml(range.table, body => storage(editor).parser.parse(body));
    token.map = [start, start + consumed];
    state.line = start + consumed;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote"] });
}
