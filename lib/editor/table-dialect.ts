// 富表格容器：行、格用具名边界，内容仍是同一套 Markdown。零 node 依赖。
// 先用 Markdown AST 隔离代码与转义，再认独占段落的 marker，禁止全文正则切格。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { REMARK_CJK_PLUGINS } from "./remark-cjk-friendly";

export type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
  [key: string]: unknown;
};
export type TableCell = {
  header: boolean;
  colspan: number;
  rowspan: number;
  colwidth: number[] | null;
  align: "left" | "center" | "right" | null;
  body: string;
  children?: MarkdownNode[];
};
export type RichTable = { rows: TableCell[][] };
export type TableRange = { start: number; end: number; table: RichTable };
export const TABLE_MARKER_RE = /^:::(table|row|cell|endcell|endrow|endtable)(?:[ \t]+(.*))?$/;
const parser = unified().use(remarkParse).use(remarkGfm).use([...REMARK_CJK_PLUGINS]);

export function parseMarkdownTree(source: string): MarkdownNode {
  return parser.parse(source) as unknown as MarkdownNode;
}

function marker(node: MarkdownNode | undefined, source: string): RegExpExecArray | null {
  if (node?.type !== "paragraph") return null;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null) return null;
  return TABLE_MARKER_RE.exec(source.slice(start, end).trimEnd());
}

export function parseCellOptions(raw = ""): Omit<TableCell, "body" | "children"> | null {
  const cell: Omit<TableCell, "body" | "children"> = {
    header: false, colspan: 1, rowspan: 1, colwidth: null, align: null,
  };
  const seen = new Set<string>();
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(header|colspan|rowspan|colwidth|align)=(\S+)$/.exec(token);
    if (!match || seen.has(match[1])) return null;
    const [, key, value] = match;
    seen.add(key);
    if (key === "header") {
      if (value !== "true" && value !== "false") return null;
      cell.header = value === "true";
    } else if (key === "align") {
      if (value !== "left" && value !== "center" && value !== "right") return null;
      cell.align = value;
    } else if (key === "colwidth") {
      if (!/^\d+(,\d+)*$/.test(value)) return null;
      cell.colwidth = value.split(",").map(Number);
      if (cell.colwidth.some(n => n < 0 || n > 10000)) return null;
    } else {
      if (!/^\d+$/.test(value)) return null;
      const n = Number(value);
      if (n < 1 || n > 1000) return null;
      if (key === "colspan") cell.colspan = n;
      else cell.rowspan = n;
    }
  }
  if (cell.colwidth && cell.colwidth.length !== cell.colspan) return null;
  return cell;
}

/** 显式验证逻辑网格，避免让编辑器自动修表后静默丢掉源结构。 */
export function tableGrid(table: RichTable): { width: number; columns: number[] } | null {
  if (!table.rows.length || table.rows.length > 1000) return null;
  const occupied: boolean[][] = Array.from({ length: table.rows.length }, () => []);
  const columns: number[] = [];
  let width = 0;
  let count = 0;
  for (let r = 0; r < table.rows.length; r++) {
    let c = 0;
    for (const cell of table.rows[r]) {
      if (++count > 20000 || cell.colspan < 1 || cell.rowspan < 1) return null;
      if (!Number.isInteger(cell.colspan) || !Number.isInteger(cell.rowspan)) return null;
      if (cell.colwidth && (cell.colwidth.length !== cell.colspan || cell.colwidth.some(w => !Number.isInteger(w) || w < 0 || w > 10000))) return null;
      while (occupied[r][c]) c++;
      if (c + cell.colspan > 200 || r + cell.rowspan > table.rows.length) return null;
      for (let y = r; y < r + cell.rowspan; y++) {
        for (let x = c; x < c + cell.colspan; x++) {
          if (occupied[y][x]) return null;
          occupied[y][x] = true;
        }
      }
      for (let i = 0; i < (cell.colwidth?.length ?? 0); i++) {
        const n = cell.colwidth![i];
        if (n && columns[c + i] && columns[c + i] !== n) return null;
        if (n) columns[c + i] = n;
      }
      c += cell.colspan;
    }
    width = Math.max(width, occupied[r].length);
  }
  if (!width || occupied.some(row => row.length !== width || Array.from({ length: width }, (_, i) => !row[i]).some(Boolean))) return null;
  return { width, columns: Array.from({ length: width }, (_, i) => columns[i] || 0) };
}

function readTable(kids: MarkdownNode[], start: number, source: string, depth = 0): { next: number; table: RichTable } | null {
  if (depth > 20) return null;
  const opening = marker(kids[start], source);
  if (opening?.[1] !== "table" || opening[2]) return null;
  const rows: TableCell[][] = [];
  let i = start + 1;
  while (marker(kids[i], source)?.[1] === "row") {
    if (marker(kids[i], source)?.[2]) return null;
    i++;
    const row: TableCell[] = [];
    while (marker(kids[i], source)?.[1] === "cell") {
      const attrs = parseCellOptions(marker(kids[i], source)?.[2]);
      if (!attrs) return null;
      const open = kids[i++];
      const contentStart = i;
      // 格内 table 是独立嵌套容器；代码里的具名边界由 Markdown AST 隔离。
      while (i < kids.length && marker(kids[i], source)?.[1] !== "endcell") {
        const m = marker(kids[i], source);
        if (m?.[1] === "table") {
          const nested = readTable(kids, i, source, depth + 1);
          if (!nested) return null;
          i = nested.next;
        } else {
          if (m) return null;
          i++;
        }
      }
      if (!kids[i] || marker(kids[i], source)?.[2]) return null;
      const body = source.slice(open.position!.end.offset, kids[i].position!.start.offset).replace(/^\s*\n/, "").trimEnd();
      row.push({ ...attrs, body, children: kids.slice(contentStart, i) });
      i++;
    }
    if (marker(kids[i], source)?.[1] !== "endrow" || marker(kids[i], source)?.[2]) return null;
    rows.push(row);
    i++;
  }
  if (marker(kids[i], source)?.[1] !== "endtable" || marker(kids[i], source)?.[2]) return null;
  const table = { rows };
  return tableGrid(table) ? { next: i + 1, table } : null;
}

export function cellOptions(cell: TableCell): string {
  const parts: string[] = [];
  if (cell.header) parts.push("header=true");
  if (cell.colspan !== 1) parts.push(`colspan=${cell.colspan}`);
  if (cell.rowspan !== 1) parts.push(`rowspan=${cell.rowspan}`);
  if (cell.colwidth?.some(Boolean)) parts.push(`colwidth=${cell.colwidth.join(",")}`);
  if (cell.align) parts.push(`align=${cell.align}`);
  return parts.length ? " " + parts.join(" ") : "";
}

export function serializeRichTable(table: RichTable): string {
  const parts = [":::table"];
  for (const row of table.rows) {
    parts.push(":::row");
    for (const cell of row) {
      parts.push(`:::cell${cellOptions(cell)}`);
      if (cell.body.trim()) parts.push(cell.body.trimEnd());
      parts.push(":::endcell");
    }
    parts.push(":::endrow");
  }
  parts.push(":::endtable");
  return parts.join("\n\n");
}

/** 与编辑器、AI 校验共用同一个边界解释；代码里的假 marker 不返回。 */
export function richTableRanges(source: string): TableRange[] {
  if (!source.includes(":::table")) return [];
  const root = parseMarkdownTree(source);
  const ranges: TableRange[] = [];
  const walk = (parent: MarkdownNode) => {
    const kids = parent.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const parsed = readTable(kids, i, source);
      if (parsed) {
        ranges.push({ start: kids[i].position!.start.offset!, end: kids[parsed.next - 1].position!.end.offset!, table: parsed.table });
        i = parsed.next - 1;
      } else if (kids[i].children) walk(kids[i]);
    }
  };
  walk(root);
  return ranges;
}

/** 给 remark 创建真实的 table/row/cell 树，格内现有插件继续处理原 children。 */
export function transformRichTables(root: MarkdownNode, source: string): void {
  const kids = root.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const parsed = readTable(kids, i, source);
    if (!parsed) {
      transformRichTables(kids[i], source);
      continue;
    }
    const table: MarkdownNode = {
      type: "richTable", position: { start: kids[i].position!.start, end: kids[parsed.next - 1].position!.end }, data: { hName: "table", hProperties: { className: ["wiki-rich-table"] } },
      children: parsed.table.rows.map(row => ({
        type: "richTableRow", data: { hName: "tr" }, children: row.map(cell => ({
          type: "richTableCell", tableCell: cell,
          data: { hName: cell.header ? "th" : "td", hProperties: {
            colSpan: cell.colspan, rowSpan: cell.rowspan,
            ...(cell.align ? { style: `text-align:${cell.align}` } : {}),
            ...(cell.colwidth ? { dataColwidth: cell.colwidth.join(",") } : {}),
          } }, children: cell.children,
        })),
      })),
    };
    transformRichTables(table, source);
    kids.splice(i, parsed.next - i, table);
  }
}

export function richTableProblems(source: string): string[] {
  const root = parseMarkdownTree(source);
  transformRichTables(root, source);
  const problems: string[] = [];
  const walk = (node: MarkdownNode) => {
    if (marker(node, source)) problems.push("表格边界或网格不完整：检查 table / row / cell 的具名闭合、独占段落、跨度与列数。");
    node.children?.forEach(walk);
  };
  walk(root);
  return [...new Set(problems)];
}
