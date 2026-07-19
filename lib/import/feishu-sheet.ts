import type { SheetMeta, SheetData, SheetCell } from "./types";

const BASE = "https://open.feishu.cn/open-apis";

// ─── URL parsing ──────────────────────────────────────────────────────────────

/** Extract spreadsheet token from a direct sheet URL or wiki URL. Returns null if not recognized. */
export function parseSheetUrl(input: string): { kind: "direct"; token: string } | { kind: "wiki"; wikiToken: string } | null {
  try {
    const url = new URL(input.trim());
    // Direct sheet: /sheets/TOKEN or /sheets/TOKEN/...
    const sheetMatch = url.pathname.match(/\/sheets\/([A-Za-z0-9]+)/);
    if (sheetMatch) return { kind: "direct", token: sheetMatch[1] };
    // Wiki: /wiki/TOKEN
    const wikiMatch = url.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) return { kind: "wiki", wikiToken: wikiMatch[1] };
    return null;
  } catch {
    return null;
  }
}

/** Resolve wiki token to a spreadsheet token. Throws if the node is not a sheet. */
export async function resolveWikiToSheetToken(wikiToken: string, userToken: string): Promise<string> {
  const data = await feishuGet<{
    data: { node: { obj_token: string; obj_type: string } };
  }>("/wiki/v2/spaces/get_node", userToken, { token: wikiToken, obj_type: "wiki" });

  const node = data.data.node;
  if (node.obj_type !== "sheet") {
    throw new Error(`此 Wiki 页面不是电子表格（类型: ${node.obj_type}）`);
  }
  return node.obj_token;
}

// ─── Sheet metadata ────────────────────────────────────────────────────────────

export async function listSheets(spreadsheetToken: string, userToken: string): Promise<SheetMeta[]> {
  // v2 metainfo API — returns camelCase fields directly
  const data = await feishuGet<{
    data: { sheets: { sheetId: string; title: string; rowCount: number; columnCount: number }[] };
  }>(`/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`, userToken);

  return data.data.sheets.map(s => ({
    sheetId: s.sheetId,
    title: s.title,
    rowCount: s.rowCount,
    columnCount: s.columnCount,
  }));
}

// ─── Sheet data ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000; // rows per paginated request

/**
 * Fetch all sheet rows via paginated range requests.
 * The Feishu API limits how many rows are returned per call, so we page through
 * in blocks of PAGE_SIZE until a short (or empty) page signals the end of data.
 */
export async function getSheetValues(
  spreadsheetToken: string,
  sheetId: string,
  userToken: string,
  maxRow?: number,
): Promise<string[][]> {
  const allRows: string[][] = [];
  let start = 1;
  const t0 = Date.now();

  for (let page = 0; page < 50; page++) {
    const end = maxRow ? Math.min(start + PAGE_SIZE - 1, maxRow) : start + PAGE_SIZE - 1;
    const range = `${sheetId}!A${start}:ZZ${end}`;
    console.log(`[feishu-sheet] page ${page + 1}: fetching range ${range}`);
    const pt = Date.now();

    const data = await feishuGet<{
      data: { valueRange: { values?: (string | number | boolean | null)[][] } };
    }>(
      `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`,
      userToken,
      { valueRenderOption: "FormattedValue" },
    );

    const rows = data.data.valueRange.values ?? [];
    console.log(`[feishu-sheet] page ${page + 1}: got ${rows.length} rows in ${Date.now() - pt}ms`);
    allRows.push(...rows.map(row => row.map(cell => (cell == null ? "" : String(cell)))));

    if (rows.length < PAGE_SIZE || (maxRow && end >= maxRow)) break;
    start += PAGE_SIZE;
  }

  console.log(`[feishu-sheet] total: ${allRows.length} rows in ${Date.now() - t0}ms`);
  return allRows;
}

/**
 * Parse raw sheet values into headers + data rows.
 * The first non-empty row is treated as the header row.
 * Returns column labels as either the header text or a column letter (A, B, ...).
 */
export function parseSheetData(rawRows: string[][]): SheetData {
  let columnCount = 0;
  let headerRowIdx: number | null = null;
  for (let rowIdx = 0; rowIdx < rawRows.length; rowIdx++) {
    const row = rawRows[rowIdx];
    for (let i = row.length - 1; i >= 0; i--) {
      if (!row[i].trim()) continue;
      columnCount = Math.max(columnCount, i + 1);
      headerRowIdx ??= rowIdx;
      break;
    }
  }

  const effectiveHeaderRowIdx = headerRowIdx ?? 0;
  const sourceHeader = rawRows[effectiveHeaderRowIdx] ?? [];
  const rawHeader = Array.from({ length: columnCount }, (_, idx) => sourceHeader[idx] ?? "");
  const headers = rawHeader.map((cell, idx) => cell.trim() || colLetter(idx));
  const rows: SheetCell[][] = rawRows.slice(effectiveHeaderRowIdx + 1).map(
    row => row.slice(0, columnCount).map(c => c.trim() || null)
  );

  return { headers, rows, rawHeaders: rawHeader.map(c => c.trim() || null) };
}

function colLetter(idx: number): string {
  let s = "";
  idx++;
  while (idx > 0) {
    s = String.fromCharCode(64 + (idx % 26 || 26)) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

// ─── Feishu API helper ─────────────────────────────────────────────────────────

async function feishuGet<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data: { code: number; msg: string } & T;
  try {
    data = JSON.parse(text) as { code: number; msg: string } & T;
  } catch {
    throw new Error(`Feishu返回无效响应 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (data.code !== 0) throw Object.assign(new Error(data.msg || `Feishu error ${data.code}`), { feishuCode: data.code });
  return data;
}
