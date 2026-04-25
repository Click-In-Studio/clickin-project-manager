import type { Block, Character, Scene, ScriptState } from "./script-types";

const BASE = "https://open.feishu.cn/open-apis";

// ─── URL parsing ──────────────────────────────────────────────────────────────

/** Extract wiki node token from a Feishu wiki URL. */
export function parseWikiUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const match = url.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Resolve a wiki node token to a Bitable appToken. Throws if the node is not a bitable. */
export async function resolveWikiToken(wikiToken: string, userToken: string): Promise<string> {
  const data = await feishuGet<{
    data: { node: { obj_token: string; obj_type: string } };
  }>("/wiki/v2/spaces/get_node", userToken, { token: wikiToken, obj_type: "wiki" });

  if (data.data.node.obj_type !== "bitable") {
    throw new Error(`此 Wiki 页面不是多维表格（类型: ${data.data.node.obj_type}）`);
  }
  return data.data.node.obj_token;
}

/** Return the first table ID from a Bitable app. */
export async function getFirstTable(appToken: string, userToken: string): Promise<string> {
  const data = await feishuGet<{
    data: { items: { table_id: string }[] };
  }>(`/bitable/v1/apps/${appToken}/tables`, userToken);

  const first = data.data.items[0];
  if (!first) throw new Error("该多维表格没有数据表");
  return first.table_id;
}

// ─── Feishu API types ─────────────────────────────────────────────────────────

type FieldOption = { id: string; name: string; color?: number };

type FieldInfo = {
  field_id: string;
  field_name: string;
  type: number;
  property?: { options?: FieldOption[] };
};

// field_name → FieldInfo for the five required columns
export type FieldMap = {
  剧本: FieldInfo;
  段落: FieldInfo;
  角色: FieldInfo;
  排练记号: FieldInfo;
  类型: FieldInfo;
};

export type ValidationResult =
  | { ok: true; fieldMap: FieldMap }
  | { ok: false; errors: string[] };

// Raw record from the Bitable records API
type RawRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

// ─── Field validation ─────────────────────────────────────────────────────────

// Type codes: 1 = Text, 3 = SingleSelect, 4 = MultiSelect
const REQUIRED: Record<keyof FieldMap, number[] | null> = {
  剧本: null,       // any type (typically multi-line text)
  段落: [3],        // must be single-select (options = scene list)
  角色: [4],        // must be multi-select (options = character list)
  排练记号: null,   // any type (typically text)
  类型: [3],        // must be single-select: 歌词 | 台词 | 舞台提示
};

export function validateSchema(fields: FieldInfo[]): ValidationResult {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const errors: string[] = [];
  const found: Partial<FieldMap> = {};

  for (const [name, allowedTypes] of Object.entries(REQUIRED) as [keyof FieldMap, number[] | null][]) {
    const field = byName.get(name);
    if (!field) {
      errors.push(`缺少列 "${name}"`);
      continue;
    }
    if (allowedTypes && !allowedTypes.includes(field.type)) {
      const typeLabel: Record<number, string> = { 1: "多行文本", 3: "单选", 4: "多选" };
      const expected = allowedTypes.map((t) => typeLabel[t] ?? `类型${t}`).join("/");
      const actual = typeLabel[field.type] ?? `类型${field.type}`;
      errors.push(`列 "${name}" 类型应为 ${expected}，实际为 ${actual}`);
      continue;
    }
    found[name] = field;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, fieldMap: found as FieldMap };
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function feishuGet<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as { code: number; msg: string } & T;
  if (data.code !== 0) throw Object.assign(new Error(data.msg), { feishuCode: data.code });
  return data;
}

/** Fetch all field definitions for a table (handles pagination). */
export async function getTableFields(
  appToken: string,
  tableId: string,
  token: string
): Promise<FieldInfo[]> {
  const all: FieldInfo[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = { page_size: "100" };
    if (pageToken) params.page_token = pageToken;

    const data = await feishuGet<{
      data: { items: FieldInfo[]; has_more: boolean; page_token?: string };
    }>(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, token, params);

    all.push(...data.data.items);
    pageToken = data.data.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  return all;
}

/** Fetch all records (handles pagination, up to 500 per page). */
export async function getAllRecords(
  appToken: string,
  tableId: string,
  token: string
): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = { page_size: "500" };
    if (pageToken) params.page_token = pageToken;

    const data = await feishuGet<{
      data: { items: RawRecord[]; has_more: boolean; page_token?: string };
    }>(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, token, params);

    all.push(...data.data.items);
    pageToken = data.data.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  return all;
}

// ─── Data conversion ──────────────────────────────────────────────────────────

// Feishu returns select field values as plain strings (option names), not {id,name}
// objects. Text fields may also be plain strings rather than the [{type,text}] array
// format described in some API versions. We handle both.

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return (value as Array<{ text?: string }>)
    .map((s) => s.text ?? "")
    .join("");
}

function extractSelectName(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (typeof value === "object" && value !== null) {
    // Handle {name, ...} or {text, ...} object shapes
    const o = value as Record<string, unknown>;
    const n = o["name"] ?? o["text"] ?? o["value"];
    return typeof n === "string" ? n || null : null;
  }
  return null;
}

function extractMultiSelectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const name = extractSelectName(item);
    return name ? [name] : [];
  });
}

/** Split a raw scene option name like "01 开场" or "1-1 第一场" into number + name. */
function parseSceneName(raw: string): { number: string; name: string } {
  const m = raw.match(/^(\d+(?:-\d+)?)\s+(.*)/);
  if (m) return { number: m[1], name: m[2].trim() };
  return { number: "", name: raw.trim() };
}

/**
 * Convert Feishu table fields + records into a ScriptState.
 * If sortFieldName is given, records are sorted by that field's value
 * (records missing the value are placed at the end in their original order).
 */
export function toScriptState(
  fieldMap: FieldMap,
  records: RawRecord[],
  sortFieldName?: string
): ScriptState {
  // Sort by lex key when the sort field is present
  let ordered = records;
  if (sortFieldName) {
    const withIdx = records.map((r, i) => ({ r, i }));
    withIdx.sort((a, b) => {
      const ka = extractText(a.r.fields[sortFieldName]) || null;
      const kb = extractText(b.r.fields[sortFieldName]) || null;
      if (ka && kb) return ka < kb ? -1 : ka > kb ? 1 : 0;
      if (ka) return -1; // records with a key come first
      if (kb) return 1;
      return a.i - b.i;  // stable: keep original order for ties
    });
    ordered = withIdx.map(x => x.r);
  }

  // Use option name as the local ID — names are unique within a field and are
  // what Feishu hands back in record values (plain strings, not option IDs).
  const scenes: Scene[] = (fieldMap.段落.property?.options ?? []).map((opt) => {
    const { number, name } = parseSceneName(opt.name);
    return { id: opt.name, number, name };
  });

  const characters: Character[] = (fieldMap.角色.property?.options ?? []).map((opt) => ({
    id: opt.name,
    name: opt.name,
  }));

  const blocks: Block[] = ordered.map((record): Block => {
    const f = record.fields;

    const sceneId = extractSelectName(f["段落"]);
    const characterIds = extractMultiSelectNames(f["角色"]);
    const content = extractText(f["剧本"]);
    const rehearsalMark = extractText(f["排练记号"]).trim() || null;

    const 类型Name = extractSelectName(f["类型"]) ?? "台词";
    const blockType = 类型Name === "舞台提示" ? "stage" : "dialogue";
    const lyric = 类型Name === "歌词";

    return {
      id: record.record_id,
      type: blockType,
      content,
      characterIds,
      lyric,
      sceneId,
      rehearsalMark,
    };
  });

  return { blocks, characters, scenes };
}

/**
 * Extract lex sort keys from raw records.
 * Returns a map of record_id → sort key string (only valid keys are included).
 */
export function extractSortKeys(records: RawRecord[], sortFieldName: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    const key = extractText(r.fields[sortFieldName]).trim();
    if (key) map.set(r.record_id, key);
  }
  return map;
}

// ─── Write helpers ────────────────────────────────────────────────────────────

async function feishuPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { code: number; msg: string } & T;
  if (data.code !== 0) throw Object.assign(new Error(data.msg), { feishuCode: data.code });
  return data;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build the 5 managed field values for a block (for batch_create / batch_update). */
export function blockToFields(
  block: Block,
  scenes: Scene[],
  characters: Character[]
): Record<string, unknown> {
  const scene = block.sceneId ? scenes.find((s) => s.id === block.sceneId) : null;
  const charNames = block.characterIds
    .map((cid) => characters.find((c) => c.id === cid)?.name)
    .filter((n): n is string => n !== undefined);
  const typeName = block.type === "stage" ? "舞台提示" : block.lyric ? "歌词" : "台词";
  return {
    剧本: block.content,
    段落: scene?.id ?? null,
    角色: charNames,
    排练记号: block.rehearsalMark ?? "",
    类型: typeName,
  };
}

/** Create records in bulk; returns new Feishu record IDs in input order. */
export async function batchCreateRecords(
  appToken: string,
  tableId: string,
  token: string,
  fieldsList: Record<string, unknown>[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const batch of chunk(fieldsList, 500)) {
    const data = await feishuPost<{ data: { records: { record_id: string }[] } }>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      token,
      { records: batch.map((fields) => ({ fields })) }
    );
    ids.push(...data.data.records.map((r) => r.record_id));
  }
  return ids;
}

/** Update existing records (only the supplied fields, other columns are untouched). */
export async function batchUpdateRecords(
  appToken: string,
  tableId: string,
  token: string,
  updates: { record_id: string; fields: Record<string, unknown> }[]
): Promise<void> {
  for (const batch of chunk(updates, 500)) {
    await feishuPost(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      token,
      { records: batch }
    );
  }
}

/** Delete records by ID. */
export async function batchDeleteRecords(
  appToken: string,
  tableId: string,
  token: string,
  recordIds: string[]
): Promise<void> {
  for (const batch of chunk(recordIds, 500)) {
    await feishuPost(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
      token,
      { records: batch }
    );
  }
}

// ─── Contact sheet ────────────────────────────────────────────────────────────

// Feishu field types used in contact sheet:
// 1 = Text, 4 = MultiSelect, 11 = Person, 17 = Attachment

export type ContactFieldMap = {
  姓名: FieldInfo;
  人员: FieldInfo | null; // type 11: directly carries open_id, skip name search when present
  邮箱: FieldInfo | null;
  电话: FieldInfo | null;
  照片: FieldInfo | null;
  职位: FieldInfo;
};

export type ContactValidationResult =
  | { ok: true; fieldMap: ContactFieldMap }
  | { ok: false; errors: string[] };

export type ContactRow = {
  name: string;
  feishuOpenId: string | null; // from 人员 column when available
  email: string | null;
  phone: string | null;
  photoUrl: string | null; // first attachment only
  roles: string[];
};

export function validateContactSchema(fields: FieldInfo[]): ContactValidationResult {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const errors: string[] = [];

  const nameField = byName.get("姓名");
  const rolesField = byName.get("职位");

  if (!nameField) errors.push('缺少列 "姓名"');
  if (!rolesField) errors.push('缺少列 "职位"');
  else if (rolesField.type !== 4) errors.push('"职位" 列类型必须为多选');

  if (errors.length > 0) return { ok: false, errors };

  const personField = byName.get("人员");

  return {
    ok: true,
    fieldMap: {
      姓名: nameField!,
      人员: personField?.type === 11 ? personField : null,
      邮箱: byName.get("邮箱") ?? null,
      电话: byName.get("电话") ?? null,
      照片: byName.get("照片") ?? null,
      职位: rolesField!,
    },
  };
}

// Person field value: [{id: open_id, name: "..."}, ...]
function extractPersonOpenId(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as Record<string, unknown>;
  const id = first["id"];
  return typeof id === "string" && id ? id : null;
}

// Attachment field: extract the stable file_token (not the URL, which requires auth).
// The token is passed to /api/media?token=... for proxied access.
function extractAttachmentToken(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as Record<string, unknown>;
  const token = first["file_token"];
  return typeof token === "string" && token ? token : null;
}

export function toContactRows(
  fieldMap: ContactFieldMap,
  records: RawRecord[],
  validRoles: Set<string>
): { rows: ContactRow[]; errors: string[] } {
  const rows: ContactRow[] = [];
  const errors: string[] = [];

  for (const record of records) {
    const f = record.fields;
    const name = extractText(f[fieldMap.姓名.field_name]).trim();
    if (!name) continue; // skip blank rows silently

    const rawRoles = extractMultiSelectNames(f[fieldMap.职位.field_name]);
    const roles = rawRoles.filter((r) => validRoles.has(r));
    const unknownRoles = rawRoles.filter((r) => !validRoles.has(r));

    if (unknownRoles.length > 0) {
      errors.push(`"${name}": 未知职位 ${unknownRoles.map((r) => `"${r}"`).join("、")}`);
    }
    if (roles.length === 0) {
      errors.push(`"${name}": 职位为空，已跳过`);
      continue;
    }

    rows.push({
      name,
      feishuOpenId: fieldMap.人员 ? extractPersonOpenId(f[fieldMap.人员.field_name]) : null,
      email: fieldMap.邮箱 ? extractText(f[fieldMap.邮箱.field_name]).trim() || null : null,
      phone: fieldMap.电话 ? extractText(f[fieldMap.电话.field_name]).trim() || null : null,
      photoUrl: fieldMap.照片 ? extractAttachmentToken(f[fieldMap.照片.field_name]) : null,
      roles,
    });
  }

  return { rows, errors };
}
