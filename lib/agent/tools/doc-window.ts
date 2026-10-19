import type { DocxDoc } from "@/lib/doc-extract/docx";
import type { PdfDoc } from "@/lib/doc-extract/pdf";
import { formatTextWindow, type TextWindow } from "./text-window";

export interface DocWindow extends TextWindow {
  block?: number; page?: number; row?: number; column?: number; line?: number; noteId?: string;
}
export function tableText(rows: string[][]): string {
  return rows.map((row, i) => `[row=${i}] ` + row.map((cell, j) => `[column=${j}] ${cell}`).join(" | ")).join("\n");
}
/** 文档锚点仍用原块/页；内部字符窗口只作用于选定对象，不改变原坐标。 */
export function readDocWindow(loaded: { kind: "docx"; doc: DocxDoc } | { kind: "pdf"; doc: PdfDoc }, window: DocWindow): string {
  let text: string; let locator: string;
  const index = (value: number | undefined, size: number, label: string) => {
    if (!Number.isInteger(value) || value! < 0 || value! >= size) throw new Error(`${label}无效，范围 0-${size - 1}`);
    return value!;
  };
  if (loaded.kind === "docx") {
    if (window.noteId !== undefined) {
      const note = loaded.doc.footnotes[window.noteId];
      if (note === undefined) throw new Error("脚注/尾注不存在");
      text = note; locator = `noteId=${window.noteId}`;
    } else {
      const block = index(window.block, loaded.doc.items.length, "块号");
      const item = loaded.doc.items[block]; locator = `block=${block}`;
      if (item.kind === "p") text = item.text;
      else if (window.row !== undefined) {
        const row = index(window.row, item.rows.length, "表格行号"); locator += ` row=${row} totalRows=${item.rows.length} nextRow=${row + 1 < item.rows.length ? row + 1 : null}`;
        if (window.column !== undefined) {
          const column = index(window.column, item.rows[row].length, "列号");
          text = item.rows[row][column]; locator += ` column=${column} totalColumns=${item.rows[row].length}`;
        } else text = item.rows[row].map((cell, column) => `[column=${column}] ${cell}`).join("\n");
      } else text = tableText(item.rows);
    }
  } else {
    if (!Number.isInteger(window.page) || window.page! < 1 || window.page! > loaded.doc.pages.length) throw new Error("page 必须是有效的一起始页序");
    const page = loaded.doc.pages[window.page! - 1]; locator = `page=${window.page}`;
    if (window.line !== undefined) {
      const line = index(window.line, page.lines.length, "页内行号");
      text = page.lines[line].text; locator += ` line=${line} totalLines=${page.lines.length} nextLine=${line + 1 < page.lines.length ? line + 1 : null}`;
    } else text = page.lines.map((line, i) => `[p${page.n}.${i}] ${line.text}`).join("\n");
  }
  return `${locator}（block/row/column/line 零起始，page 一起始）\n${formatTextWindow(text, window)}`;
}
