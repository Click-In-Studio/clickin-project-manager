// 格内 children 保持 Markdown AST，让已有样式、分栏、引用渲染继续生效。
import { transformRichTables, tableGrid, type MarkdownNode, type TableCell } from "./table-dialect";

export default function remarkTables() {
  return (root: unknown, file: { value?: unknown }) => {
    const tree = root as MarkdownNode;
    transformRichTables(tree, String(file.value ?? ""));
    const decorate = (node: MarkdownNode) => {
      node.children?.forEach(decorate);
      if (node.type !== "richTable") return;
      const rows = node.children ?? [];
      const grid = tableGrid({ rows: rows.map(row => (row.children ?? []).map(c => c.tableCell as TableCell)) });
      if (grid?.columns.some(Boolean)) {
        const width = grid.columns.reduce((sum, w) => sum + (w || 25), 0);
        (node.data!.hProperties as Record<string, unknown>).style = `${grid.columns.every(Boolean) ? "width" : "min-width"}:${width}px`;
      }
      node.children = [...(grid?.columns.some(Boolean) ? [{
        type: "richTableColumns", data: { hName: "colgroup" },
        children: grid.columns.map(w => ({
          type: "richTableColumn", data: { hName: "col", hProperties: w ? { style: `width:${w}px` } : {} },
        })),
      }] : []), { type: "richTableBody", data: { hName: "tbody" }, children: rows },
      ];
    };
    decorate(tree);
  };
}
