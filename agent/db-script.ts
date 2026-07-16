import { getScriptEditorPool } from "./db";
import { MARKER_TYPES_SQL, VERSION_OWNED_BLOCKS_CTE } from "../lib/script-marker-sql";
import { withMarkerSceneLabels, type MarkerLabelIndex } from "../lib/script-generated-labels";
import { ensureScriptMarkerMigration, getMarkerLabelIndex } from "../lib/db";

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
  versionId?: string | null,
): Promise<Record<string, number>> {
  const pool = getScriptEditorPool();
  const resolvedVersionId = versionId === undefined ? await getActiveVersionId(productionId) : versionId;

  const blocksRes = resolvedVersionId
    ? await pool.query<{
        id: string; snapshot_id: string; type: string; content: string; scene_id: string | null;
      }>(
        `${VERSION_OWNED_BLOCKS_CTE},
         version_snapshots AS (
           SELECT block_id, snapshot_id
           FROM script_version
           WHERE version_id = $1
         )
         SELECT ob.id, vs.snapshot_id, ob.type, ob.content, ob.scene_id
         FROM owned_blocks ob
         JOIN version_snapshots vs ON vs.block_id = ob.id
         WHERE ob.type NOT IN (${MARKER_TYPES_SQL})
         ORDER BY ob.sort_key`,
        [resolvedVersionId],
      )
    : await pool.query<{
        id: string; snapshot_id: string; type: string; content: string; scene_id: string | null;
      }>(
        `SELECT id, id AS snapshot_id, type::text AS type, content, scene_id
         FROM script
         WHERE production_id = $1 AND type::text NOT IN (${MARKER_TYPES_SQL})
         ORDER BY sort_key`,
        [productionId],
      );
  if ((blocksRes.rowCount ?? 0) === 0) return {};
  const ids = blocksRes.rows.map(r => r.snapshot_id);
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
    characterIds: charMap.get(r.snapshot_id) ?? [],
  }));
  return computePageMapFromBlocks(blocks, layout);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function getActiveVersionId(productionId: string): Promise<string | null> {
  const pool = getScriptEditorPool();
  const res = await pool.query<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM production WHERE id = $1",
    [productionId],
  );
  return res.rows[0]?.active_version_id ?? null;
}

async function getMigratedActiveVersionId(productionId: string): Promise<string | null> {
  const versionId = await getActiveVersionId(productionId);
  if (versionId) {
    const migration = await ensureScriptMarkerMigration(versionId, getScriptEditorPool());
    if (migration.status === "running") throw new Error("剧本数据正在更新，请稍后重试");
  }
  return versionId;
}

function versionedBlocksCTE(): string {
  return `${VERSION_OWNED_BLOCKS_CTE},
  version_snapshots AS (
    SELECT block_id, snapshot_id
    FROM script_version
    WHERE version_id = $1
  ),
  ordered AS (
    SELECT ob.id, vs.snapshot_id, ob.sort_key, ob.type, ob.content, ob.scene_id, ob.rehearsal_mark,
           ROW_NUMBER() OVER (ORDER BY ob.sort_key) AS line_num
    FROM owned_blocks ob
    JOIN version_snapshots vs ON vs.block_id = ob.id
    WHERE ob.type NOT IN (${MARKER_TYPES_SQL})
  )`;
}

function legacyBlocksCTE(): string {
  return `WITH ordered AS (
    SELECT id, id AS snapshot_id, sort_key, type::text AS type, content, scene_id, rehearsal_mark,
           ROW_NUMBER() OVER (ORDER BY sort_key) AS line_num
    FROM script
    WHERE production_id = $1 AND type::text NOT IN (${MARKER_TYPES_SQL})
  )`;
}

async function attachCharacters(
  pool: ReturnType<typeof getScriptEditorPool>,
  rows: Array<Omit<ScriptBlockRow, "characters"> & { snapshotId: string }>,
): Promise<ScriptBlockRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.snapshotId);
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
  return rows.map(({ snapshotId: _snapshotId, ...r }) => ({
    ...r,
    characters: charMap.get(_snapshotId) ?? [],
  }));
}

type RawBlockRow = {
  id: string; snapshot_id: string; line_num: string; type: string; content: string;
  rehearsal_mark: string | null; scene_id: string | null; scene_name: string | null; scene_number: string | null;
};

type BlockRowWithSnapshot = Omit<ScriptBlockRow, "characters"> & { snapshotId: string };
type BlockRowWithSceneId = BlockRowWithSnapshot & { sceneId: string | null };

function toBlockRow(r: RawBlockRow): BlockRowWithSceneId {
  return {
    id:            r.id,
    snapshotId:    r.snapshot_id,
    sceneId:       r.scene_id,
    lineNum:       parseInt(r.line_num, 10),
    pageNum:       null,
    type:          r.type as ScriptBlockRow["type"],
    content:       r.content,
    rehearsalMark: r.rehearsal_mark,
    sceneName:     r.scene_name,
    sceneNumber:   r.scene_number,
  };
}

const selectCols = `o.id, o.snapshot_id, o.line_num, o.type, o.content, o.rehearsal_mark,
  o.scene_id, sc.name AS scene_name, NULL::text AS scene_number`;
const versionedJoinClause = `LEFT JOIN scene_version sc ON sc.scene_id = o.scene_id AND sc.version_id = $1`;
const legacyJoinClause = `LEFT JOIN scene scene_anchor ON scene_anchor.id = o.scene_id
  LEFT JOIN production p ON p.id = scene_anchor.production_id
  LEFT JOIN scene_version sc ON sc.scene_id = scene_anchor.id AND sc.version_id = p.active_version_id`;

function sceneNumberMap(scenes: Array<{ id: string; number: string }>): Map<string, string> {
  return new Map(scenes.map((scene) => [scene.id, scene.number]));
}

async function getMarkerLabels(versionId: string) {
  return getMarkerLabelIndex(versionId, getScriptEditorPool());
}

async function getGeneratedSceneRows(
  productionId: string,
  resolvedVersionId: string | null,
): Promise<Array<{ id: string; number: string; name: string; parentId: string | null }>> {
  const pool = getScriptEditorPool();
  const [res, labels] = await Promise.all([pool.query<{ id: string; name: string | null; parent_id: string | null }>(
    resolvedVersionId
      ? `SELECT scene_id AS id, name, parent_id
         FROM scene_version
         WHERE version_id = $1
         ORDER BY sort_order`
      : `SELECT sc.id, COALESCE(sv.name, '') AS name, sv.parent_id
         FROM scene sc
         LEFT JOIN production p ON p.id = sc.production_id
         LEFT JOIN scene_version sv ON sv.scene_id = sc.id AND sv.version_id = p.active_version_id
         WHERE sc.production_id = $1
         ORDER BY COALESCE(sv.sort_order, 0), sc.id`,
    [resolvedVersionId ?? productionId],
  ), resolvedVersionId ? getMarkerLabels(resolvedVersionId) : null]);
  if (labels) {
    return res.rows.map((r) => ({
      id: r.id,
      number: labels.labelByMarkerId.get(r.id) ?? "",
      name: r.name ?? "",
      parentId: r.parent_id,
    }));
  }
  return withMarkerSceneLabels(res.rows.map((r) => ({
    id: r.id,
    number: "",
    name: r.name ?? "",
    parentId: r.parent_id,
  })));
}

async function applyGeneratedSceneNumbers(
  productionId: string,
  rows: BlockRowWithSceneId[],
  resolvedVersionId: string | null,
  numberMap?: Map<string, string>,
  precomputedRehearsalLabels?: MarkerLabelIndex,
): Promise<BlockRowWithSnapshot[]> {
  if (rows.length === 0) return [];
  const rehearsalLabels = precomputedRehearsalLabels
    ?? (resolvedVersionId && rows.some((row) => row.rehearsalMark)
      ? await getMarkerLabels(resolvedVersionId)
      : null);
  const generatedNumbers = rows.some((row) => row.sceneId)
    ? numberMap ?? sceneNumberMap(await getGeneratedSceneRows(productionId, resolvedVersionId))
    : null;
  return rows.map(({ sceneId, ...row }) => ({
    ...row,
    rehearsalMark: row.rehearsalMark && rehearsalLabels
      ? rehearsalLabels.rehearsalLabelByMarkerId.get(row.rehearsalMark) ?? null
      : row.rehearsalMark,
    sceneNumber: sceneId && generatedNumbers
      ? generatedNumbers.get(sceneId) ?? row.sceneNumber
      : row.sceneNumber,
  }));
}

export async function getBlockById(
  productionId: string,
  blockId:      string,
): Promise<ScriptBlockRow | null> {
  const pool = getScriptEditorPool();
  const resolvedVersionId = await getMigratedActiveVersionId(productionId);
  const res = await pool.query<RawBlockRow>(
    resolvedVersionId
      ? `${versionedBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${versionedJoinClause}
         WHERE o.id = $2`
      : `${legacyBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${legacyJoinClause}
         WHERE o.id = $2`,
    [resolvedVersionId ?? productionId, blockId],
  );
  if (res.rowCount === 0) return null;
  const numberedRows = await applyGeneratedSceneNumbers(productionId, res.rows.map(toBlockRow), resolvedVersionId);
  const [row] = await attachCharacters(pool, numberedRows);
  return row;
}

export async function getBlockByLine(
  productionId: string,
  lineNum:      number,
): Promise<ScriptBlockRow | null> {
  const pool = getScriptEditorPool();
  const resolvedVersionId = await getMigratedActiveVersionId(productionId);
  const res = await pool.query<RawBlockRow>(
    resolvedVersionId
      ? `${versionedBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${versionedJoinClause}
         WHERE o.line_num = $2`
      : `${legacyBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${legacyJoinClause}
         WHERE o.line_num = $2`,
    [resolvedVersionId ?? productionId, lineNum],
  );
  if (res.rowCount === 0) return null;
  const numberedRows = await applyGeneratedSceneNumbers(productionId, res.rows.map(toBlockRow), resolvedVersionId);
  const [row] = await attachCharacters(pool, numberedRows);
  return row;
}

export async function searchBlocks(
  productionId: string,
  query:        string,
  page:         number | null = null,
  limit         = 20,
): Promise<ScriptBlockRow[]> {
  const pool = getScriptEditorPool();
  const resolvedVersionId = await getMigratedActiveVersionId(productionId);
  const res = await pool.query<RawBlockRow>(
    resolvedVersionId
      ? `${versionedBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${versionedJoinClause}
         WHERE o.content ILIKE $2
         ORDER BY o.line_num LIMIT $3`
      : `${legacyBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${legacyJoinClause}
         WHERE o.content ILIKE $2
         ORDER BY o.line_num LIMIT $3`,
    [resolvedVersionId ?? productionId, `%${query}%`, limit * (page ? 5 : 1)],
  );
  const numberedRows = await applyGeneratedSceneNumbers(productionId, res.rows.map(toBlockRow), resolvedVersionId);
  const rows = await attachCharacters(pool, numberedRows);

  if (page === null) return rows;

  // Filter by page: compute page map and attach page numbers
  const pageMap = await getPageMapForProduction(productionId, undefined, resolvedVersionId);
  const withPage = rows.map(r => ({ ...r, pageNum: pageMap[r.id] ?? null }));
  return withPage.filter(r => r.pageNum === page).slice(0, limit);
}

export async function getBlockCount(productionId: string): Promise<number> {
  const pool = getScriptEditorPool();
  const versionId = await getActiveVersionId(productionId);
  const res = await pool.query<{ count: string }>(
    versionId
      ? `${VERSION_OWNED_BLOCKS_CTE}
         SELECT COUNT(*)::text AS count
         FROM owned_blocks
         WHERE type NOT IN (${MARKER_TYPES_SQL})`
      : `SELECT COUNT(*)::text AS count
         FROM script
         WHERE production_id = $1 AND type::text NOT IN (${MARKER_TYPES_SQL})`,
    [versionId ?? productionId],
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
  const resolvedVersionId = await getMigratedActiveVersionId(productionId);

  const params: unknown[] = [resolvedVersionId ?? productionId];
  const conditions: string[] = [];

  if (type) {
    const dbType = type === "lyric" ? "lyric" : type;
    params.push(dbType);
    conditions.push(`o.type = $${params.length}`);
  }
  const sceneFilter = scene?.toLocaleLowerCase() ?? null;
  let precomputedSceneNumberMap: Map<string, string> | undefined;
  let precomputedRehearsalLabels: MarkerLabelIndex | undefined;
  if (sceneFilter) {
    const generatedScenes = await getGeneratedSceneRows(productionId, resolvedVersionId);
    precomputedSceneNumberMap = sceneNumberMap(generatedScenes);
    const sceneIds = generatedScenes
      .filter((s) =>
        s.name.toLocaleLowerCase().includes(sceneFilter)
        || s.number.toLocaleLowerCase().includes(sceneFilter)
      )
      .map((s) => s.id);
    if (sceneIds.length === 0) return [];
    params.push(sceneIds);
    conditions.push(`o.scene_id = ANY($${params.length}::text[])`);
  }
  if (rehearsalMark) {
    if (resolvedVersionId) {
      precomputedRehearsalLabels = await getMarkerLabels(resolvedVersionId);
      const markerIds = [...precomputedRehearsalLabels.rehearsalLabelByMarkerId]
        .filter(([, label]) => label.includes(rehearsalMark.toUpperCase()))
        .map(([markerId]) => markerId);
      if (markerIds.length === 0) return [];
      params.push(markerIds);
      conditions.push(`o.rehearsal_mark = ANY($${params.length}::text[])`);
    } else {
      params.push(`%${rehearsalMark}%`);
      conditions.push(`o.rehearsal_mark ILIKE $${params.length}`);
    }
  }

  const whereExtra = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  // Overfetch when filtering by page so we have enough candidates after post-filtering
  params.push(page != null ? limit * 15 : limit);

  const res = await pool.query<RawBlockRow>(
    resolvedVersionId
      ? `${versionedBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${versionedJoinClause}
         ${whereExtra}
         ORDER BY o.line_num LIMIT $${params.length}`
      : `${legacyBlocksCTE()}
         SELECT ${selectCols} FROM ordered o ${legacyJoinClause}
         ${whereExtra}
     ORDER BY o.line_num LIMIT $${params.length}`,
    params,
  );

  const numberedRows = await applyGeneratedSceneNumbers(
    productionId,
    res.rows.map(toBlockRow),
    resolvedVersionId,
    precomputedSceneNumberMap,
    precomputedRehearsalLabels,
  );
  const rows = await attachCharacters(pool, numberedRows);
  if (page == null) return rows.slice(0, limit);

  const pageMap = await getPageMapForProduction(productionId, undefined, resolvedVersionId);
  return rows
    .map(r => ({ ...r, pageNum: pageMap[r.id] ?? null }))
    .filter(r => r.pageNum === page)
    .slice(0, limit);
}

// ── Script meta ───────────────────────────────────────────────────────────────


export type ScriptMetaResult = {
  productionName:  string;
  pageLayout:      string;
  stageDelimOpen:  string;
  stageDelimClose: string;
  totalBlocks:     number;
  totalScenes:     number;
  totalCharacters: number;
  totalPages:      number;
};

export async function getScriptMeta(productionId: string): Promise<ScriptMetaResult | null> {
  const pool = getScriptEditorPool();
  const resolvedVersionId = await getActiveVersionId(productionId);

  const prodRes = await pool.query<{
    name:          string;
    script_config: Record<string, string> | null;
  }>(
    `SELECT p.name, p.script_config
     FROM production p
     WHERE p.id = $1`,
    [productionId],
  );
  if (prodRes.rowCount === 0) return null;

  const pr = prodRes.rows[0];
  const layout      = pr.script_config?.pageLayout      ?? "a4";
  const delimOpen   = pr.script_config?.stageDelimOpen  ?? "（";
  const delimClose  = pr.script_config?.stageDelimClose ?? "）";

  const [rawMap, sceneCountRes, charCountRes] = await Promise.all([
    getPageMapForProduction(productionId, layout, resolvedVersionId),
    resolvedVersionId
      ? pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM scene_version WHERE version_id = $1",
          [resolvedVersionId],
        )
      : pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM scene WHERE production_id = $1",
          [productionId],
        ),
    resolvedVersionId
      ? pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM character_version WHERE version_id = $1",
          [resolvedVersionId],
        )
      : pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM character WHERE production_id = $1",
          [productionId],
        ),
  ]);

  const totalBlocks = Object.keys(rawMap).length;
  const totalScenes = parseInt(sceneCountRes.rows[0]?.count ?? "0", 10);
  const totalChars  = parseInt(charCountRes.rows[0]?.count ?? "0", 10);

  const totalPages = Object.keys(rawMap).length > 0
    ? Math.max(...Object.values(rawMap))
    : 0;

  return {
    productionName: pr.name, pageLayout: layout, stageDelimOpen: delimOpen,
    stageDelimClose: delimClose, totalBlocks, totalScenes, totalCharacters: totalChars,
    totalPages,
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
  const resolvedVersionId = await getMigratedActiveVersionId(productionId);
  const [res, labels] = await Promise.all([pool.query<{
    id: string; name: string | null; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: number | null; block_count: string;
  }>(
    resolvedVersionId
      ? `${VERSION_OWNED_BLOCKS_CTE},
         text_block_counts AS (
           SELECT scene_id, COUNT(*)::text AS block_count
           FROM owned_blocks
           WHERE type NOT IN (${MARKER_TYPES_SQL})
           GROUP BY scene_id
         )
         SELECT sc.scene_id AS id, sc.name, sc.parent_id,
                sc.synopsis, sc.action_line, sc.music, sc.stage_notes, sc.expected_duration,
                COALESCE(tbc.block_count, '0') AS block_count
         FROM scene_version sc
         LEFT JOIN text_block_counts tbc ON tbc.scene_id = sc.scene_id
         WHERE sc.version_id = $1
         ORDER BY sc.sort_order`
      : `SELECT sc.id, sv.name, sv.parent_id,
                sv.synopsis, sv.action_line, sv.music, sv.stage_notes, sv.expected_duration,
                COUNT(s.id) FILTER (WHERE s.type::text NOT IN (${MARKER_TYPES_SQL}))::text AS block_count
         FROM scene sc
         LEFT JOIN production p ON p.id = sc.production_id
         LEFT JOIN scene_version sv ON sv.scene_id = sc.id AND sv.version_id = p.active_version_id
         LEFT JOIN script s ON s.scene_id = sc.id AND s.production_id = $1
         WHERE sc.production_id = $1
         GROUP BY sc.id, sv.name, sv.parent_id, sv.synopsis, sv.action_line,
                  sv.music, sv.stage_notes, sv.expected_duration, sv.sort_order
         ORDER BY COALESCE(sv.sort_order, 0), sc.id`,
    [resolvedVersionId ?? productionId],
  ), resolvedVersionId ? getMarkerLabels(resolvedVersionId) : null]);
  const rows: SceneRow[] = res.rows.map(r => ({
    id:               r.id,
    number:           labels?.labelByMarkerId.get(r.id) ?? "",
    name:             r.name,
    parentId:         r.parent_id,
    synopsis:         r.synopsis,
    actionLine:       r.action_line,
    music:            r.music,
    stageNotes:       r.stage_notes,
    expectedDuration: r.expected_duration,
    blockCount:       parseInt(r.block_count, 10),
  }));
  if (labels) return rows;
  const numbered = withMarkerSceneLabels(rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: r.name ?? "",
    parentId: r.parentId,
  })));
  return rows.map((row, i) => ({ ...row, number: numbered[i]?.number ?? row.number }));
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
