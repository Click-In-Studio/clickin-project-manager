// 表格边界不参与逐行拼接：独立格可合并，结构冲突保留两份供作者选择。
import { cellOptions, richTableRanges, serializeRichTable } from "./table-dialect";

export function tableMergeUnits(source: string): string[] {
  if (!source.includes(":::table")) return source.split("\n");
  const ranges = richTableRanges(source);
  const units: string[] = [];
  let at = 0;
  for (const range of ranges) {
    const start = source.lastIndexOf("\n", range.start - 1) + 1;
    const newline = source.indexOf("\n", range.end);
    const end = newline < 0 ? source.length : newline;
    if (start < at) continue;
    if (start > at) units.push(...source.slice(at, start - 1).split("\n"));
    units.push(source.slice(start, end));
    at = end + 1;
  }
  if (at <= source.length) units.push(...source.slice(at).split("\n"));
  return units;
}

export function mergeIndependentTableCells(base: string, mine: string, theirs: string): string | null {
  const parse = (source: string) => {
    const ranges = richTableRanges(source);
    return ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === source.length ? ranges[0].table : null;
  };
  const b = parse(base), m = parse(mine), t = parse(theirs);
  if (!b || !m || !t) return null;
  const structure = (table: typeof b) => JSON.stringify(table.rows.map(row => row.map(cellOptions)));
  if (structure(b) !== structure(m) || structure(b) !== structure(t)) return null;
  for (let r = 0; r < b.rows.length; r++) for (let c = 0; c < b.rows[r].length; c++) {
    const original = b.rows[r][c].body, left = m.rows[r][c].body, right = t.rows[r][c].body;
    if (left !== original && right !== original && left !== right) return null;
    m.rows[r][c].body = left === original ? right : left;
  }
  return serializeRichTable(m);
}
