import type { TextSegment } from "../../cue-export";

const BASE = "https://open.feishu.cn/open-apis";

async function parseResponse(res: Response): Promise<{ code: number; msg: string } & Record<string, unknown>> {
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`飞书 API 返回非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return data as { code: number; msg: string } & Record<string, unknown>;
}

async function feishuGet<T>(
  path: string,
  token: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await parseResponse(res);
  if (data.code !== 0) throw Object.assign(new Error(data.msg), { feishuCode: data.code });
  return data as unknown as T;
}

async function feishuPut<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(res);
  if (data.code !== 0) throw Object.assign(new Error(data.msg), { feishuCode: data.code });
  return data as unknown as T;
}

function parseWikiToken(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const m = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function resolveWikiToSheet(wikiUrl: string, userToken: string): Promise<string> {
  const wikiToken = parseWikiToken(wikiUrl);
  if (!wikiToken) throw new Error("无法解析 Wiki 链接");

  const data = await feishuGet<{
    data: { node: { obj_token: string; obj_type: string } };
  }>("/wiki/v2/spaces/get_node", userToken, { token: wikiToken, obj_type: "wiki" });

  const { obj_type, obj_token } = data.data.node;
  if (obj_type !== "sheet") {
    throw new Error(`此 Wiki 页面不是电子表格（类型: ${obj_type}）`);
  }
  return obj_token;
}

export async function getFirstSheetId(
  spreadsheetToken: string,
  userToken: string,
): Promise<{ sheetId: string; title: string }> {
  const data = await feishuGet<{
    data: {
      sheets: {
        sheet_id?: string;
        sheetId?: string;
        title: string;
        index: number;
      }[];
    };
  }>(`/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, userToken);

  const sheets = data.data.sheets ?? [];
  if (!sheets.length) throw new Error("该电子表格没有工作表");
  const sorted = [...sheets].sort((a, b) => a.index - b.index);
  const first = sorted[0];
  const sheetId = first.sheet_id ?? first.sheetId ?? "";
  if (!sheetId) throw new Error("无法读取工作表 ID");
  return { sheetId, title: first.title };
}

function colLetter(n: number): string {
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// ─── Rich text conversion ─────────────────────────────────────────────────────

type FeishuTextSegment = {
  text: string;
  type: "text";
  segmentStyle?: { underline: boolean };
};

function toFeishuSegments(segments: TextSegment[]): FeishuTextSegment[] {
  return segments
    .filter((s) => s.text.length > 0)
    .map((s) => ({
      text: s.text,
      type: "text" as const,
      ...(s.underline !== undefined ? { segmentStyle: { underline: s.underline } } : {}),
    }));
}

// ─── Write ────────────────────────────────────────────────────────────────────

export type CellValue = string | number | boolean | null | TextSegment[];

export async function writeSheetData(
  spreadsheetToken: string,
  sheetId: string,
  rows: CellValue[][],
  userToken: string,
): Promise<void> {
  if (rows.length === 0) return;
  const numCols = Math.max(...rows.map((r) => r.length));
  const range = `${sheetId}!A1:${colLetter(numCols)}${rows.length}`;

  const values = rows.map((row) =>
    row.map((cell) => (Array.isArray(cell) ? toFeishuSegments(cell) : cell)),
  );

  await feishuPut(`/sheets/v2/spreadsheets/${spreadsheetToken}/values`, userToken, {
    valueRange: { range, values },
  });
}
