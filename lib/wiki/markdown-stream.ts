// 流式展示只缓存完整块；末块仍交给同一套 Markdown 文法，不修补用户原文。
import { parseMarkdownTree, type MarkdownNode } from "@/lib/editor/table-dialect";
import { COLS_OPEN_RE, COLS_CLOSE_RE } from "@/lib/editor/tiptap-columns";

export type MarkdownTableModel = {
  header: string[];
  align: Array<"left" | "right" | "center" | null>;
  rows: string[][];
  after: string;
};
export type MarkdownPiece = { source: string; table?: MarkdownTableModel };

function cells(source: string, row: MarkdownNode, width?: number): string[] {
  const result = (row.children ?? []).map(cell => {
    let raw = source.slice(cell.position!.start.offset, cell.position!.end.offset);
    if (raw.startsWith("|")) raw = raw.slice(1);
    // 没写末尾分隔符时，最后的 \| 可能属于单元格文字。
    if (raw.endsWith("|") && (raw.slice(0, -1).match(/\\+$/)?.[0].length ?? 0) % 2 === 0) raw = raw.slice(0, -1);
    return raw.trim();
  });
  return width === undefined ? result : Array.from({ length: width }, (_, i) => result[i] ?? "");
}

/** 普通 GFM 表格每个完整物理行独立解析；引用定义由外层保留整篇语境。 */
class TableStream {
  private source = "";
  private pending = "";
  private processed = 0;
  private headerLines: string[] = [];
  private prefix = "";
  private header: string[] = [];
  private align: MarkdownTableModel["align"] = [];
  private rows: string[][] = [];
  end: number | null = null;

  private row(line: string): string[] | null {
    const source = this.prefix + line;
    const nodes = parseMarkdownTree(source).children ?? [];
    const table = nodes[0];
    return nodes.length === 1 && table?.type === "table" && table.children?.[1]
      ? cells(source, table.children[1], this.header.length) : null;
  }

  update(source: string): MarkdownTableModel {
    this.pending += source.slice(this.source.length);
    this.source = source;
    let newline: number;
    while (this.end === null && (newline = this.pending.indexOf("\n")) >= 0) {
      const raw = this.pending.slice(0, newline + 1);
      if (this.headerLines.length < 2) {
        if (this.headerLines.length === 0 && !raw.trim()) {
          this.processed += raw.length;
          this.pending = this.pending.slice(raw.length);
          continue;
        }
        this.headerLines.push(raw);
        if (this.headerLines.length === 2) {
          this.prefix = this.headerLines.join("");
          const table = parseMarkdownTree(this.prefix).children![0];
          this.header = cells(this.prefix, table.children![0]);
          this.align = table.align as MarkdownTableModel["align"];
        }
      } else {
        const row = this.row(raw);
        if (!row) { this.end = this.processed; break; }
        this.rows.push(row);
      }
      this.processed += raw.length;
      this.pending = this.pending.slice(raw.length);
    }
    // 分隔行在 EOF 也已能确立表头，不必等待下一次换行。
    if (this.headerLines.length === 1 && this.pending) {
      const prefix = this.headerLines[0] + this.pending;
      const table = parseMarkdownTree(prefix).children?.[0];
      if (table?.type === "table") return {
        header: cells(prefix, table.children![0]),
        align: table.align as MarkdownTableModel["align"], rows: [], after: "",
      };
    }
    const pending = this.end === null && this.pending ? this.row(this.pending) : null;
    return {
      header: this.header, align: this.align,
      rows: pending ? [...this.rows, pending] : [...this.rows],
      after: this.end !== null || pending ? "" : this.pending,
    };
  }
}

function nodeText(source: string, node: MarkdownNode): string {
  return source.slice(node.position!.start.offset, node.position!.end.offset).trim();
}

function groups(source: string): Array<{ start: number; end: number; type: string }> {
  const nodes = parseMarkdownTree(source).children ?? [];
  const result: Array<{ start: number; end: number; type: string }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    const text = nodeText(source, node);
    const table = node.type === "paragraph" && text === ":::table";
    const columns = node.type === "paragraph" && COLS_OPEN_RE.test(text);
    if (!table && !columns) { result.push({ start, end, type: node.type }); continue; }
    // 容器内的空行与子节点不构成外层分块边界；代码里的 marker 也不参与。
    let depth = 1, close = source.length;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].type !== "paragraph") continue;
      const marker = nodeText(source, nodes[j]);
      if (table && marker === ":::table") depth++;
      if ((table && marker === ":::endtable") || (columns && COLS_CLOSE_RE.test(marker))) {
        if (--depth === 0) { close = nodes[j].position!.end.offset!; i = j; break; }
      }
      if (j === nodes.length - 1) i = j;
    }
    if (depth > 0) i = nodes.length;
    result.push({ start, end: close, type: "container" });
  }
  return result;
}

export class MarkdownStream {
  private source = "";
  private offset = 0;
  private stable: MarkdownPiece[] = [];
  private table: TableStream | null = null;

  update(source: string): MarkdownPiece[] {
    if (!source.startsWith(this.source)) {
      this.offset = 0;
      this.stable = [];
      this.table = null;
    }
    this.source = source;
    // 定义可能回头改变前面段落；不能把已收到的块误当作语义永不变化。
    if (/^[ \t]{0,3}\[[^\]\r\n]+\]:/m.test(source)) return [{ source }];
    let tail = source.slice(this.offset);
    if (this.table) {
      const table = this.table.update(tail);
      if (this.table.end === null) return [...this.stable, { source: tail, table }];
      const end = this.table.end;
      this.stable.push({ source: tail.slice(0, end), table });
      this.offset += end;
      this.table = null;
      tail = source.slice(this.offset);
    }
    const parts = groups(tail);
    let advance = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const end = parts[i + 1].start;
      this.stable.push({ source: tail.slice(advance, end) });
      advance = end;
    }
    this.offset += advance;
    tail = tail.slice(advance);
    if (!tail) return [...this.stable];
    if (parts.at(-1)?.type === "table") {
      this.table = new TableStream();
      return [...this.stable, { source: tail, table: this.table.update(tail) }];
    }
    return [...this.stable, { source: tail }];
  }
}

/** CommonMark 的围栏必须同字符且至少同长度；EOF 的未闭合围栏仍是合法代码块。 */
export function openCodeFence(source: string): boolean {
  const lines = source.trimStart().split(/\r?\n/);
  const opening = /^(`{3,}|~{3,})(.*)$/.exec(lines[0]);
  if (!opening) return false;
  const fence = opening[1];
  return !lines.slice(1).some(line => {
    const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return closing && closing[1][0] === fence[0] && closing[1].length >= fence.length;
  });
}

/** 把围栏状态随 AST 传到代码组件，不让渲染组件闭包随正文更新而更换身份。 */
export function remarkCodeFences() {
  return (root: unknown, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (node: MarkdownNode) => {
      if (node.type === "code" && node.position) {
        const start = node.position.start.offset!;
        const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
        const quotes = prefix.match(/>/g)?.length ?? 0;
        // AST 位置从围栏本身开始，后续物理行却仍带引用块前缀。
        const raw = source.slice(start, node.position.end.offset).split("\n").map((line, index) => {
          if (index > 0) for (let i = 0; i < quotes; i++) line = line.replace(/^ {0,3}>[ \t]?/, "");
          return line;
        }).join("\n");
        if (openCodeFence(raw)) node.data = { ...node.data, hProperties: { ...node.data?.hProperties as object, "data-open-fence": true } };
      }
      node.children?.forEach(visit);
    };
    visit(root as MarkdownNode);
  };
}
