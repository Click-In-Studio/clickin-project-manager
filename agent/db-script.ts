import { getScriptEditorPool } from "./db";

export type ScriptBlockRow = {
  id:            string;
  lineNum:       number;
  pageNum:       number | null; // null when no page map requested
  type:          "dialogue" | "stage" | "lyric";
  content:       string;
  rehearsalMark: string | null;
  sceneName:     string | null;
  sceneNumber:   string | null;
  characters:    string[];
};

// ── Page map computation (mirrors lib/script-page.ts, no lib imports) ─────────

const LINE_HEIGHT         = 28;
const FONT_SIZE           = 14;
const CHAR_NAME_HEIGHT    = 22;
const SCENE_HEADER_HEIGHT = 44;

// Usable content height per layout (height - marginTop - marginBottom)
const LAYOUT_CONTENT_H: Record<string, number> = {
  "a4":          1123 - 90 - 90,
  "letter":      1056 - 90 - 90,
  "a3-2col":     1123 - 90 - 90,
  "tablet-2col": 1056 - 90 - 90,
};
// Content width per layout (width - 2*marginX)
const LAYOUT_CONTENT_W: Record<string, number> = {
  "a4":          794  - 150,
  "letter":      816  - 150,
  "a3-2col":     794  - 150,
  "tablet-2col": 816  - 150,
};

type LightBlock = {
  id: string; type: "dialogue" | "stage"; lyric: boolean;
  content: string; sceneId: string | null; characterIds: string[];
};

function estimateLines(text: string, upl: number): number {
  if (!text.trim()) return 1;
  let total = 0;
  for (const para of text.split("\n")) {
    let units = 0, lineCount = 1;
    for (const ch of para) {
      units += /[⺀-⿿　-鿿豈-﫿︰-﹏]/.test(ch) ? 1 : 0.5;
      if (units > upl) { lineCount++; units = /[⺀-⿿　-鿿豈-﫿︰-﹏]/.test(ch) ? 1 : 0.5; }
    }
    total += lineCount;
  }
  return total || 1;
}

function sameChars(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a); return b.every(x => s.has(x));
}

function computePageMapFromBlocks(
  blocks: LightBlock[],
  layout = "a4",
): Record<string, number> {
  const maxH = LAYOUT_CONTENT_H[layout] ?? LAYOUT_CONTENT_H["a4"];
  const upl  = Math.floor((LAYOUT_CONTENT_W[layout] ?? LAYOUT_CONTENT_W["a4"]) / FONT_SIZE);
  const map: Record<string, number> = {};
  let page = 1, used = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], prev = i > 0 ? blocks[i - 1] : null;
    if (b.sceneId && b.sceneId !== prev?.sceneId) {
      if (used > 0 && used + SCENE_HEADER_HEIGHT > maxH) { page++; used = 0; }
      used += SCENE_HEADER_HEIGHT;
    }
    const hideCharName = !!(
      prev && prev.type === "dialogue" && b.type === "dialogue" &&
      b.characterIds.length > 0 && prev.lyric !== b.lyric && sameChars(prev.characterIds, b.characterIds)
    );
    const charH = b.type === "dialogue" && b.characterIds.length > 0 && !hideCharName ? CHAR_NAME_HEIGHT : 0;
    // Strip markdown markers for line estimation
    const text = b.content.replace(/\*\*/g, "").replace(/__/g, "").replace(/\n/g, "\n");
    const h = charH + estimateLines(text, upl) * LINE_HEIGHT + 8;
    if (used > 0 && used + h > maxH) { page++; used = 0; }
    map[b.id] = page;
    used += h;
  }
  return map;
}

export async function getPageMapForProduction(
  productionId: string,
  layout = "a4",
): Promise<Record<string, number>> {
  const pool = getScriptEditorPool();

  // Use server-cached page map when available (written by server-cache after each flush)
  const prodRes = await pool.query<{ page_map: Record<string, Record<string, number>> | null }>(
    "SELECT page_map FROM production WHERE id = $1",
    [productionId],
  );
  const stored = prodRes.rows[0]?.page_map;
  if (stored && stored[layout] && Object.keys(stored[layout]).length > 0) {
    return stored[layout];
  }

  // Fall back to on-demand computation from blocks
  const blocksRes = await pool.query<{
    id: string; type: string; content: string; scene_id: string | null;
  }>(
    `SELECT id, type, content, scene_id FROM script WHERE production_id = $1 ORDER BY sort_key`,
    [productionId],
  );
  if ((blocksRes.rowCount ?? 0) === 0) return {};
  const ids = blocksRes.rows.map(r => r.id);
  const charRes = await pool.query<{ script_id: string; character_id: string }>(
    `SELECT script_id, character_id FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position`,
    [ids],
  );
  const charMap = new Map<string, string[]>();
  for (const r of charRes.rows) {
    if (!charMap.has(r.script_id)) charMap.set(r.script_id, []);
    charMap.get(r.script_id)!.push(r.character_id);
  }
  const blocks: LightBlock[] = blocksRes.rows.map(r => ({
    id: r.id,
    type: r.type === "stage" ? "stage" : "dialogue",
    lyric: r.type === "lyric",
    content: r.content,
    sceneId: r.scene_id,
    characterIds: charMap.get(r.id) ?? [],
  }));
  return computePageMapFromBlocks(blocks, layout);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

// CTE that assigns 1-based line numbers to all blocks in a production.
const lineNumCTE = `
  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY sort_key) AS line_num
    FROM script WHERE production_id = $1
  )
`;

async function attachCharacters(
  pool: ReturnType<typeof getScriptEditorPool>,
  rows: Omit<ScriptBlockRow, "characters">[],
): Promise<ScriptBlockRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const res = await pool.query<{ script_id: string; char_name: string }>(
    `SELECT sc.script_id, c.name AS char_name
     FROM script_character sc
     JOIN character c ON c.id = sc.character_id
     WHERE sc.script_id = ANY($1::text[])
     ORDER BY sc.script_id, sc.position`,
    [ids],
  );
  const charMap = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!charMap.has(r.script_id)) charMap.set(r.script_id, []);
    charMap.get(r.script_id)!.push(r.char_name);
  }
  return rows.map(r => ({ ...r, characters: charMap.get(r.id) ?? [] }));
}

type RawBlockRow = {
  id: string; line_num: string; type: string; content: string;
  rehearsal_mark: string | null; scene_name: string | null; scene_number: string | null;
};

function toBlockRow(r: RawBlockRow): Omit<ScriptBlockRow, "characters"> {
  return {
    id:            r.id,
    lineNum:       parseInt(r.line_num, 10),
    pageNum:       null,
    type:          r.type as ScriptBlockRow["type"],
    content:       r.content,
    rehearsalMark: r.rehearsal_mark,
    sceneName:     r.scene_name,
    sceneNumber:   r.scene_number,
  };
}

const selectCols = `s.id, o.line_num, s.type, s.content, s.rehearsal_mark,
  sc.name AS scene_name, sc.num AS scene_number`;
const joinClause = `JOIN ordered o ON o.id = s.id LEFT JOIN scene sc ON sc.id = s.scene_id`;

export async function getBlockById(
  productionId: string,
  blockId:      string,
): Promise<ScriptBlockRow | null> {
  const pool = getScriptEditorPool();
  const res = await pool.query<RawBlockRow>(
    `${lineNumCTE}
     SELECT ${selectCols} FROM script s ${joinClause}
     WHERE s.production_id = $1 AND s.id = $3`,
    [productionId, productionId, blockId],
  );
  if (res.rowCount === 0) return null;
  const [row] = await attachCharacters(pool, res.rows.map(toBlockRow));
  return row;
}

export async function getBlockByLine(
  productionId: string,
  lineNum:      number,
): Promise<ScriptBlockRow | null> {
  const pool = getScriptEditorPool();
  const res = await pool.query<RawBlockRow>(
    `${lineNumCTE}
     SELECT ${selectCols} FROM script s ${joinClause}
     WHERE s.production_id = $1 AND o.line_num = $2`,
    [productionId, lineNum],
  );
  if (res.rowCount === 0) return null;
  const [row] = await attachCharacters(pool, res.rows.map(toBlockRow));
  return row;
}

export async function searchBlocks(
  productionId: string,
  query:        string,
  page:         number | null = null,
  limit         = 20,
): Promise<ScriptBlockRow[]> {
  const pool = getScriptEditorPool();
  const res = await pool.query<RawBlockRow>(
    `${lineNumCTE}
     SELECT ${selectCols} FROM script s ${joinClause}
     WHERE s.production_id = $1 AND s.content ILIKE $2
     ORDER BY o.line_num LIMIT $3`,
    [productionId, `%${query}%`, limit * (page ? 5 : 1)],
  );
  const rows = await attachCharacters(pool, res.rows.map(toBlockRow));

  if (page === null) return rows;

  // Filter by page: compute page map and attach page numbers
  const pageMap = await getPageMapForProduction(productionId);
  const withPage = rows.map(r => ({ ...r, pageNum: pageMap[r.id] ?? null }));
  return withPage.filter(r => r.pageNum === page).slice(0, limit);
}

export async function getBlockCount(productionId: string): Promise<number> {
  const pool = getScriptEditorPool();
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM script WHERE production_id = $1`,
    [productionId],
  );
  return parseInt(res.rows[0].count, 10);
}

// ── Block query (filtered) ─────────────────────────────────────────────────────

export type QueryBlocksFilter = {
  page?:          number | null;
  type?:          "dialogue" | "stage" | "lyric" | null;
  scene?:         string | null;  // partial match on scene name or number
  rehearsalMark?: string | null;  // partial match
  limit?:         number;
};

export async function queryBlocks(
  productionId: string,
  filter: QueryBlocksFilter,
): Promise<ScriptBlockRow[]> {
  const pool = getScriptEditorPool();
  const { page, type, scene, rehearsalMark, limit = 30 } = filter;

  const params: unknown[] = [productionId];
  const conditions: string[] = [];

  if (type) {
    const dbType = type === "lyric" ? "lyric" : type;
    params.push(dbType);
    conditions.push(`s.type = $${params.length}::block_type`);
  }
  if (scene) {
    params.push(`%${scene}%`);
    const p = params.length;
    conditions.push(`(sc.name ILIKE $${p} OR sc.num ILIKE $${p})`);
  }
  if (rehearsalMark) {
    params.push(`%${rehearsalMark}%`);
    conditions.push(`s.rehearsal_mark ILIKE $${params.length}`);
  }

  const whereExtra = conditions.length ? " AND " + conditions.join(" AND ") : "";
  // Overfetch when filtering by page so we have enough candidates after post-filtering
  params.push(page != null ? limit * 15 : limit);

  const res = await pool.query<RawBlockRow>(
    `${lineNumCTE}
     SELECT ${selectCols} FROM script s ${joinClause}
     WHERE s.production_id = $1${whereExtra}
     ORDER BY o.line_num LIMIT $${params.length}`,
    params,
  );

  const rows = await attachCharacters(pool, res.rows.map(toBlockRow));
  if (page == null) return rows;

  const pageMap = await getPageMapForProduction(productionId);
  return rows
    .map(r => ({ ...r, pageNum: pageMap[r.id] ?? null }))
    .filter(r => r.pageNum === page)
    .slice(0, limit);
}

// ── Script meta ───────────────────────────────────────────────────────────────

export type PageRangeEntry = {
  pageNum:    number;
  firstLine:  number;
  lastLine:   number;
  blockCount: number;
};

export type ScriptMetaResult = {
  productionName:  string;
  pageLayout:      string;
  stageDelimOpen:  string;
  stageDelimClose: string;
  totalBlocks:     number;
  totalScenes:     number;
  totalCharacters: number;
  totalPages:      number;
  pageRanges:      PageRangeEntry[];   // per-page line ranges
  lineToPage:      Record<number, number>; // line_num → page_num
};

export async function getScriptMeta(productionId: string): Promise<ScriptMetaResult | null> {
  const pool = getScriptEditorPool();

  const prodRes = await pool.query<{
    name:          string;
    script_config: Record<string, string> | null;
    page_map:      Record<string, Record<string, number>> | null;
    block_count:   string;
    scene_count:   string;
    char_count:    string;
  }>(
    `SELECT p.name, p.script_config, p.page_map,
       (SELECT COUNT(*) FROM script    WHERE production_id = p.id)::text AS block_count,
       (SELECT COUNT(*) FROM scene     WHERE production_id = p.id)::text AS scene_count,
       (SELECT COUNT(*) FROM character WHERE production_id = p.id)::text AS char_count
     FROM production p WHERE p.id = $1`,
    [productionId],
  );
  if (prodRes.rowCount === 0) return null;

  const pr = prodRes.rows[0];
  const layout      = pr.script_config?.pageLayout      ?? "a4";
  const delimOpen   = pr.script_config?.stageDelimOpen  ?? "（";
  const delimClose  = pr.script_config?.stageDelimClose ?? "）";
  const totalBlocks = parseInt(pr.block_count, 10);
  const totalScenes = parseInt(pr.scene_count, 10);
  const totalChars  = parseInt(pr.char_count, 10);

  // Resolve page map (from stored cache or on-demand)
  let rawMap: Record<string, number> = {};
  const stored = pr.page_map;
  if (stored && stored[layout] && Object.keys(stored[layout]).length > 0) {
    rawMap = stored[layout];
  } else {
    rawMap = await getPageMapForProduction(productionId, layout);
  }

  if (Object.keys(rawMap).length === 0) {
    return {
      productionName: pr.name, pageLayout: layout, stageDelimOpen: delimOpen,
      stageDelimClose: delimClose, totalBlocks, totalScenes, totalCharacters: totalChars,
      totalPages: 0, pageRanges: [], lineToPage: {},
    };
  }

  // Join page map with line numbers via a single SQL query
  const joinRes = await pool.query<{ line_num: string; page_num: string }>(
    `WITH blocks_ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY sort_key) AS line_num
       FROM script WHERE production_id = $1
     ),
     page_entries AS (
       SELECT key AS block_id, value::int AS page_num
       FROM jsonb_each_text($2::jsonb)
     )
     SELECT bo.line_num::text, pe.page_num::text
     FROM page_entries pe
     JOIN blocks_ordered bo ON bo.id = pe.block_id
     ORDER BY bo.line_num`,
    [productionId, JSON.stringify(rawMap)],
  );

  const lineToPage: Record<number, number> = {};
  const pageAgg = new Map<number, { first: number; last: number; count: number }>();

  for (const r of joinRes.rows) {
    const ln = parseInt(r.line_num, 10);
    const pn = parseInt(r.page_num, 10);
    lineToPage[ln] = pn;
    const agg = pageAgg.get(pn);
    if (!agg) pageAgg.set(pn, { first: ln, last: ln, count: 1 });
    else { agg.last = Math.max(agg.last, ln); agg.count++; }
  }

  const pageRanges: PageRangeEntry[] = Array.from(pageAgg.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageNum, { first, last, count }]) => ({
      pageNum, firstLine: first, lastLine: last, blockCount: count,
    }));

  return {
    productionName: pr.name, pageLayout: layout, stageDelimOpen: delimOpen,
    stageDelimClose: delimClose, totalBlocks, totalScenes, totalCharacters: totalChars,
    totalPages: pageRanges.length > 0 ? pageRanges[pageRanges.length - 1].pageNum : 0,
    pageRanges, lineToPage,
  };
}

// ── Scenes ────────────────────────────────────────────────────────────────────

export type SceneRow = {
  id:               string;
  number:           string;
  name:             string | null;
  parentId:         string | null;
  synopsis:         string | null;
  actionLine:       string | null;
  music:            string | null;
  stageNotes:       string | null;
  expectedDuration: number | null; // minutes
  blockCount:       number;
};

export async function getScenesForProduction(productionId: string): Promise<SceneRow[]> {
  const pool = getScriptEditorPool();
  const res = await pool.query<{
    id: string; num: string; name: string | null; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: number | null; block_count: string;
  }>(
    `SELECT sc.id, sc.num, sc.name, sc.parent_id,
            sc.synopsis, sc.action_line, sc.music, sc.stage_notes, sc.expected_duration,
            COUNT(s.id)::text AS block_count
     FROM scene sc
     LEFT JOIN script s ON s.scene_id = sc.id AND s.production_id = $1
     WHERE sc.production_id = $1
     GROUP BY sc.id
     ORDER BY sc.sort_order`,
    [productionId],
  );
  return res.rows.map(r => ({
    id:               r.id,
    number:           r.num,
    name:             r.name,
    parentId:         r.parent_id,
    synopsis:         r.synopsis,
    actionLine:       r.action_line,
    music:            r.music,
    stageNotes:       r.stage_notes,
    expectedDuration: r.expected_duration,
    blockCount:       parseInt(r.block_count, 10),
  }));
}

// ── Comments ──────────────────────────────────────────────────────────────────

export type AgentComment = {
  id:         string;
  contextId:  string;
  parentId:   string | null;
  openId:     string;
  authorName: string;
  body:       string;
  mentions:   Array<{ openId: string; name: string }>;
  createdAt:  string;
};

type CommentRow = {
  id: string; context_id: string; parent_id: string | null;
  open_id: string; author_name: string; body: string;
  mentions: Array<{ openId: string; name: string }>; created_at: Date;
};

function rowToAgentComment(r: CommentRow): AgentComment {
  return {
    id:         r.id,
    contextId:  r.context_id,
    parentId:   r.parent_id,
    openId:     r.open_id,
    authorName: r.author_name,
    body:       r.body,
    mentions:   r.mentions ?? [],
    createdAt:  r.created_at.toISOString(),
  };
}

export async function getBlockComments(productionId: string, blockId: string): Promise<AgentComment[]> {
  const pool = getScriptEditorPool();
  const res = await pool.query<CommentRow>(
    `SELECT id, context_id, parent_id, open_id, author_name, body, mentions, created_at
     FROM comment
     WHERE production_id = $1 AND context_type = 'block' AND context_id = $2
     ORDER BY created_at ASC`,
    [productionId, blockId],
  );
  return res.rows.map(rowToAgentComment);
}

export async function getMentionsToday(productionId: string, openId: string): Promise<AgentComment[]> {
  const pool = getScriptEditorPool();
  // "Today" is defined as on or after midnight Beijing time (UTC+8)
  const res = await pool.query<CommentRow>(
    `SELECT id, context_id, parent_id, open_id, author_name, body, mentions, created_at
     FROM comment
     WHERE production_id = $1
       AND context_type = 'block'
       AND mentions @> jsonb_build_array(jsonb_build_object('openId', $2::text))
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
     ORDER BY created_at DESC`,
    [productionId, openId],
  );
  return res.rows.map(rowToAgentComment);
}

// ── Characters ────────────────────────────────────────────────────────────────

export type CharacterRow = {
  id:          string;
  name:        string;
  roleType:    string | null;
  gender:      string | null;
  biography:   string | null;
  isAggregate: boolean;
  members:     string[]; // names of member characters (for aggregate chars)
  blockCount:  number;
};

export async function getCharactersForProduction(productionId: string): Promise<CharacterRow[]> {
  const pool = getScriptEditorPool();
  const res = await pool.query<{
    id: string; name: string; role_type: string | null; gender: string | null;
    biography: string | null; is_aggregate: boolean; block_count: string;
  }>(
    `SELECT c.id, c.name, c.role_type, c.gender, c.biography, c.is_aggregate,
            COUNT(DISTINCT sc.script_id)::text AS block_count
     FROM character c
     LEFT JOIN script_character sc ON sc.character_id = c.id
     WHERE c.production_id = $1
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
    [productionId],
  );

  if (res.rows.length === 0) return [];

  // Fetch aggregate members
  const aggregateIds = res.rows.filter(r => r.is_aggregate).map(r => r.id);
  const memberMap = new Map<string, string[]>();
  if (aggregateIds.length > 0) {
    const membRes = await pool.query<{ aggregate_id: string; member_name: string }>(
      `SELECT ca.aggregate_id, c.name AS member_name
       FROM character_aggregate ca
       JOIN character c ON c.id = ca.member_id
       WHERE ca.aggregate_id = ANY($1::text[])
       ORDER BY ca.aggregate_id, c.name`,
      [aggregateIds],
    );
    for (const r of membRes.rows) {
      if (!memberMap.has(r.aggregate_id)) memberMap.set(r.aggregate_id, []);
      memberMap.get(r.aggregate_id)!.push(r.member_name);
    }
  }

  return res.rows.map(r => ({
    id:          r.id,
    name:        r.name,
    roleType:    r.role_type,
    gender:      r.gender,
    biography:   r.biography,
    isAggregate: r.is_aggregate,
    members:     memberMap.get(r.id) ?? [],
    blockCount:  parseInt(r.block_count, 10),
  }));
}
