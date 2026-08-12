import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/platform/feishu/feishu-auth";
import { getSheetValues } from "@/lib/import/feishu-sheet";
import { getProductionPermissionContext, listCharactersByVersion, importScriptToVersion, getVersion, getActiveVersionId, listTagGroups, getVersionOpeningChapterId, listScenesByVersion } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import { parseCharacter, guessIsAggregate } from "@/lib/import/parse-character";
import { buildImportTagFormatLookup } from "@/lib/import/tag-format";
import { shouldImportFirstChapterAsOpening } from "@/lib/import/opening-chapter";
import type { ScriptColMap, TypeAction, TypeTagMapping, ImportScriptPreview, AggregateMembers, StageDelimiterPattern, ScriptConfigStageDelimiterPattern, JointImportMarker, ImportTagChanges, ImportTypeConflict } from "@/lib/import/types";
import { initialKeys } from "@/lib/lex-order";
import { FIXED_INITIAL_CHAPTER_NAME } from "@/lib/script-fixed-markers";
import type { BlockType } from "@/lib/script-types";
import type { MarkerMeta } from "@/lib/script-types";
import { randomUUID } from "node:crypto";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx, isArchived } = access;
  if (isArchived) return { session, deny: Response.json({ error: "已归档" }, { status: 403 }) };
  if (!hasPermission("script:import", permCtx)) {
    return { session, deny: Response.json({ error: "仅制作人可导入数据" }, { status: 403 }) };
  }
  return { session, deny: null };
}

type ImportScriptBody = {
  spreadsheetToken: string;
  sheetId: string;
  rowCount?: number;
  colMap: ScriptColMap;
  typeTagMapping?: TypeTagMapping;
  /** name → "normal" | "aggregate", after user override (uses the PARSED name, not raw) */
  characterKinds?: Record<string, "normal" | "aggregate">;
  /** Raw sheet value → final character name and optional annotation. */
  characterMappings?: Record<string, { name: string; note: string | null }>;
  /** For aggregate characters: which base-character names are members */
  aggregateMembers?: AggregateMembers;
  stageDelimiterPattern?: ScriptConfigStageDelimiterPattern;
  headerRowIncluded?: boolean;
  sceneOverrides?: JointImportMarker[];
  rows?: (string | null)[][];
  tagChanges?: ImportTagChanges;
  firstChapterAsOpening?: boolean;
};

const REHEARSAL_MARK_RE = /^[A-Za-z]\d*$|^\d+[A-Za-z]?$/;
const STAGE_DELIMITERS: Record<StageDelimiterPattern, { open: string; close: string }> = {
  "（）": { open: "（", close: "）" },
  "【】": { open: "【", close: "】" },
  "()": { open: "(", close: ")" },
  "[]": { open: "[", close: "]" },
};
const STAGE_DELIMITER_PATTERNS = Object.keys(STAGE_DELIMITERS) as StageDelimiterPattern[];
type StageDelimiter = { open: string; close: string };
type StageDelimiterReplacement = { regex: RegExp; replacement: string };
const TYPE_VALUE_SPLIT_RE = /[,，;；、/\n]+/;
const BLOCK_TYPE_PRIORITY: Record<"dialogue" | "stage" | "lyric" | "marker", number> = {
  lyric: 4,
  dialogue: 3,
  stage: 2,
  marker: 1,
};

function mappedBlockTypes(actions: TypeAction[]): Array<"dialogue" | "stage" | "lyric" | "marker"> {
  return [...new Set(actions.flatMap(action => action.action === "mapType" ? [action.blockType] : []))];
}

function resolveBlockType(types: Array<"dialogue" | "stage" | "lyric" | "marker">) {
  if (types.length === 0) return "dialogue" as const;
  return types.reduce<"dialogue" | "stage" | "lyric" | "marker">(
    (selected, candidate) => BLOCK_TYPE_PRIORITY[candidate] > BLOCK_TYPE_PRIORITY[selected] ? candidate : selected,
    "marker",
  );
}

type ParsedImportRow = {
  sourceIndex: number;
  sceneNum: string;
  rehearsalMark: string | null;
  rawType: string | null;
  rawChars: string[];
  body: string;
  stageComment: string | null;
  typeActions: TypeAction[];
  warningMark: boolean;
  cueValues: Array<{ column: number; content: string }>;
  resolvedBlockType: "dialogue" | "stage" | "lyric";
};
type MarkerImportRow = {
  sourceIndex: number;
  sceneNum: string;
  body: string;
  cueValues: Array<{ column: number; content: string }>;
};
type ImportBlock = {
  id: string;
  blockId?: string;
  type: BlockType;
  content: string;
  stageComment?: string | null;
  lyric: boolean;
  characterIds: string[];
  characterAnnotations: Record<string, string>;
  sceneId: string | null;
  rehearsalMark: string | null;
  markerMeta?: MarkerMeta | null;
  lexKey: string;
};

async function resolveImportVersionId(req: NextRequest, productionId: string): Promise<string | Response> {
  const versionIdParam = req.nextUrl.searchParams.get("v");
  if (!versionIdParam) {
    const versionId = await getActiveVersionId(productionId);
    return versionId ?? Response.json({ error: "没有可编辑的版本，请先创建一个版本" }, { status: 400 });
  }
  const ver = await getVersion(versionIdParam);
  if (!ver || ver.productionId !== productionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  if (ver.status !== "editing") {
    return Response.json({ error: "只能向编辑中的版本导入剧本" }, { status: 400 });
  }
  return versionIdParam;
}

function getCell(row: (string | null)[], col: number | undefined): string | null {
  if (col == null) return null;
  return row[col]?.trim() || null;
}

function resolveImportedCharacter(raw: string, mappings: ImportScriptBody["characterMappings"]) {
  const trimmed = raw.trim();
  const mapped = mappings?.[trimmed];
  if (mapped) return { raw: trimmed, name: mapped.name.trim(), note: mapped.note?.trim() || undefined };
  return parseCharacter(trimmed);
}

function collectImportedCharacters(rawValues: string[], mappings: ImportScriptBody["characterMappings"]) {
  const byName = new Map<string, ReturnType<typeof resolveImportedCharacter>>();
  for (const raw of rawValues) {
    const parsed = resolveImportedCharacter(raw, mappings);
    if (parsed.name && !byName.has(parsed.name)) byName.set(parsed.name, parsed);
  }
  return [...byName.values()];
}

function getDataRows(rows: (string | null)[][], headerRowIncluded?: boolean) {
  if (!headerRowIncluded) return rows;
  const headerIndex = rows.findIndex(row => row.some(cell => cell?.trim()));
  if (headerIndex < 0) return [];
  return rows.filter((_, index) => index !== headerIndex);
}

function getHeaderRow(rows: (string | null)[][], headerRowIncluded?: boolean): (string | null)[] | null {
  if (!headerRowIncluded) return null;
  return rows.find(row => row.some(cell => cell?.trim())) ?? null;
}

function cueListNameFromHeader(header: string | null, column: number): string {
  const fallback = `Cue ${column + 1}`;
  if (!header?.trim()) return fallback;
  const name = header
    .trim()
    .replace(/(^|[\s_\-—–/\\|:：])cue(?=$|[\s_\-—–/\\|:：])/gi, " ")
    .replace(/^cue\s*/i, "")
    .replace(/\s*cue$/i, "")
    .replace(/[\s_\-—–/\\|:：]+/g, " ")
    .trim();
  return name || header.trim() || fallback;
}

function getStageDelimiter(pattern: ScriptConfigStageDelimiterPattern | undefined) {
  return pattern === "【】" ? STAGE_DELIMITERS["【】"] : STAGE_DELIMITERS["（）"];
}

function stripOuterStageDelimiter(text: string): string {
  const trimmed = text.trim();
  for (const { open, close } of Object.values(STAGE_DELIMITERS)) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildStageDelimiterReplacements(target: StageDelimiter, patterns: StageDelimiterPattern[]): StageDelimiterReplacement[] {
  return patterns.flatMap((pattern) => {
    const source = STAGE_DELIMITERS[pattern];
    if (source.open === target.open && source.close === target.close) return [];
    return [{
      regex: new RegExp(
        `${escapeRegExp(source.open)}([^${escapeRegExp(source.open + source.close)}\\n]*)${escapeRegExp(source.close)}`,
        "g",
      ),
      replacement: `${target.open}$1${target.close}`,
    }];
  });
}

function normalizeStageDelimiters(text: string, replacements: StageDelimiterReplacement[]): string {
  let next = text;
  for (const { regex, replacement } of replacements) {
    next = next.replace(regex, replacement);
  }
  return next;
}

/** Parse rows into intermediate import records */
function parseRows(rows: (string | null)[][], body: Omit<ImportScriptBody, "spreadsheetToken" | "sheetId" | "rowCount">) {
  const { colMap, typeTagMapping, characterKinds, headerRowIncluded } = body;
  const dataRows = getDataRows(rows, headerRowIncluded);
  const stageDelimiter = getStageDelimiter(body.stageDelimiterPattern);
  const bodyDelimiterReplacements = buildStageDelimiterReplacements(stageDelimiter, colMap.stageInlinePatterns ?? []);
  const stageCommentDelimiterReplacements = buildStageDelimiterReplacements(stageDelimiter, STAGE_DELIMITER_PATTERNS);

  const result: ParsedImportRow[] = [];
  const markerRows: MarkerImportRow[] = [];
  const warningMarks: string[] = [];
  const typeConflicts: ImportTypeConflict[] = [];
  const cueColumns = new Set(colMap.cueColumns ?? []);

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rawSceneNum = getCell(row, colMap.sceneNum);
    if (!rawSceneNum) continue;

    const rawType = getCell(row, colMap.typeTag);
    // Split multi-value type cells using the same delimiters as the import UI.
    // An empty cell uses key "" so users can map blank cells explicitly.
    const typeParts = rawType
      ? rawType.split(TYPE_VALUE_SPLIT_RE).map(s => s.trim()).filter(Boolean)
      : [""];
    const typeActions = typeParts.flatMap(p => {
      const action = typeTagMapping?.[p];
      if (!action) return [];
      return Array.isArray(action) ? action : [action];
    });
    if (typeActions.some(a => a.action === "ignore")) continue;
    const blockTypes = mappedBlockTypes(typeActions);
    const resolvedBlockType = resolveBlockType(blockTypes);
    if (blockTypes.length > 1) {
      typeConflicts.push({ sourceIndex: i, rawType: rawType ?? "", blockTypes, resolvedBlockType });
    }

    const rawMark = getCell(row, colMap.rehearsalMark);
    const warningMark = !!(rawMark && !REHEARSAL_MARK_RE.test(rawMark));
    if (warningMark && rawMark && !warningMarks.includes(rawMark)) warningMarks.push(rawMark);

    // Build body by concatenating body columns
    const bodyParts = colMap.bodyColumns.filter(col => !cueColumns.has(col)).map(col => {
      const val = getCell(row, col);
      if (!val) return null;
      const isStage = colMap.stageInlineColumns?.includes(col);
      const normalized = normalizeStageDelimiters(val, bodyDelimiterReplacements);
      return isStage ? `${stageDelimiter.open}${normalized}${stageDelimiter.close}` : normalized;
    }).filter(Boolean);
    const body = bodyParts.join("\n");
    const cueValues = [...cueColumns].flatMap(column => {
      const content = getCell(row, column);
      return content ? [{ column, content }] : [];
    });
    if (resolvedBlockType === "marker") {
      markerRows.push({ sourceIndex: i, sceneNum: rawSceneNum, body, cueValues });
      continue;
    }

    const rawStageComment = getCell(row, colMap.stageComment);
    const stageComment = rawStageComment
      ? normalizeStageDelimiters(stripOuterStageDelimiter(rawStageComment), stageCommentDelimiterReplacements)
      : null;

    // Characters
    const rawCharCell = getCell(row, colMap.character);
    const rawChars = rawCharCell
      ? rawCharCell.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)
      : [];
    result.push({ sourceIndex: i, sceneNum: rawSceneNum, rehearsalMark: rawMark, rawType, rawChars, body, stageComment, typeActions, warningMark, cueValues, resolvedBlockType });
    void characterKinds;
  }

  return { rows: result, markerRows, warningMarks, typeConflicts };
}

function normalizeMarkerName(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function markerNameCandidates(row: MarkerImportRow): string[] {
  return row.body
    .split(/\r\n|\r|\n/)
    .map(part => normalizeMarkerName(stripOuterStageDelimiter(part)))
    .filter(Boolean);
}

function sceneLabel(scene: { number: string; name: string | null }): string {
  return scene.name ? `${scene.number} ${scene.name}` : scene.number;
}

function isImportedOpeningChapter(scene: { number: string; name: string }): boolean {
  return shouldImportFirstChapterAsOpening(scene.number, scene.name);
}

function validateProvidedMarkers(markerRows: MarkerImportRow[], textRows: ParsedImportRow[]): string[] {
  if (markerRows.length === 0) return [];

  const conflicts: string[] = [];
  const chapterByNum = new Map<string, { number: string; name: string | null }>();
  const sceneByNum = new Map<string, { number: string; name: string | null; parentNum: string | null }>();

  for (const row of textRows) {
    const parsed = parseSceneNum(row.sceneNum);
    if (!parsed) continue;
    if (parsed.parentNum && !chapterByNum.has(parsed.parentNum)) {
      chapterByNum.set(parsed.parentNum, { number: parsed.parentNum, name: parsed.parentName });
    }
    if (parsed.childNum && !sceneByNum.has(parsed.childNum)) {
      sceneByNum.set(parsed.childNum, { number: parsed.childNum, name: parsed.childName, parentNum: parsed.parentNum });
    } else if (!parsed.childNum && parsed.parentNum && !sceneByNum.has(parsed.parentNum)) {
      sceneByNum.set(parsed.parentNum, { number: parsed.parentNum, name: parsed.parentName, parentNum: null });
    }
  }

  let nextTextRowIndex = 0;
  for (const marker of markerRows) {
    const parsedMarker = parseSceneNum(marker.sceneNum);
    while (textRows[nextTextRowIndex]?.sourceIndex <= marker.sourceIndex) nextTextRowIndex++;
    const nextTextRow = textRows[nextTextRowIndex];
    if (!parsedMarker) {
      conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的段落无法解析：${marker.sceneNum}`);
      continue;
    }
    if (!nextTextRow) {
      conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 后没有正文行`);
      continue;
    }
    const parsedNext = parseSceneNum(nextTextRow.sceneNum);
    if (!parsedNext) {
      conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 后的正文段落无法解析：${nextTextRow.sceneNum}`);
      continue;
    }

    const isSceneMarker = !!parsedMarker.childNum;
    const markerNum = parsedMarker.childNum ?? parsedMarker.parentNum;
    if (!markerNum) {
      conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的段落无法匹配到章/场：${marker.sceneNum}`);
      continue;
    }

    if (isSceneMarker) {
      if (parsedNext.childNum !== markerNum) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 指向场 ${markerNum}，但后续正文属于 ${parsedNext.childNum ?? parsedNext.parentNum ?? "空段落"}`);
        continue;
      }
      const expected = sceneByNum.get(markerNum);
      if (!expected) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 指向不存在的场：${markerNum}`);
        continue;
      }
      const markerName = parsedMarker.childName ? normalizeMarkerName(parsedMarker.childName) : null;
      const expectedName = normalizeMarkerName(expected.name);
      if (markerName && expectedName && markerName !== expectedName) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的场名不一致：${markerName} / ${expectedName}`);
      }
      for (const candidate of markerNameCandidates(marker)) {
        if (expectedName && candidate !== expectedName && candidate !== sceneLabel(expected)) {
          conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的场名不一致：${candidate} / ${expectedName}`);
        }
      }
    } else {
      if (parsedNext.parentNum !== markerNum) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 指向章 ${markerNum}，但后续正文属于章 ${parsedNext.parentNum ?? "空段落"}`);
        continue;
      }
      const expected = chapterByNum.get(markerNum);
      if (!expected) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 指向不存在的章：${markerNum}`);
        continue;
      }
      const markerName = parsedMarker.parentName ? normalizeMarkerName(parsedMarker.parentName) : null;
      const expectedName = normalizeMarkerName(expected.name);
      if (markerName && expectedName && markerName !== expectedName) {
        conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的章名不一致：${markerName} / ${expectedName}`);
      }
      for (const candidate of markerNameCandidates(marker)) {
        if (expectedName && candidate !== expectedName && candidate !== sceneLabel(expected)) {
          conflicts.push(`章节分界线行 ${marker.sourceIndex + 1} 的章名不一致：${candidate} / ${expectedName}`);
        }
      }
    }
  }

  return conflicts;
}

/** POST: preview what would be imported */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const body = (await req.json()) as ImportScriptBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const previewVersionId = await resolveImportVersionId(req, productionId);
  if (previewVersionId instanceof Response) return previewVersionId;
  const rawRows = body.rows ?? await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const { rows: parsed, markerRows, warningMarks, typeConflicts } = parseRows(rawRows, body);
  const markerConflicts = validateProvidedMarkers(markerRows, parsed);
  if (markerConflicts.length > 0) {
    return Response.json({ error: `章节分界线与段落推断不一致：${markerConflicts.join("；")}` }, { status: 400 });
  }

  const existingChars = await listCharactersByVersion(previewVersionId);
  const existingCharByName = new Map(existingChars.map(c => [c.name, c]));

  // Collect all unique character names from import
  const allRawChars = parsed.flatMap(r => r.rawChars);
  const parsedChars = collectImportedCharacters(allRawChars, body.characterMappings);

  const charsToAdd: ImportScriptPreview["charsToAdd"] = [];
  const charsToUpdate: ImportScriptPreview["charsToUpdate"] = [];
  const charConflicts: ImportScriptPreview["charConflicts"] = [];

  for (const pc of parsedChars) {
    const isAgg = body.characterKinds?.[pc.name] != null
      ? body.characterKinds[pc.name] === "aggregate"
      : guessIsAggregate(pc.name);
    const ex = existingCharByName.get(pc.name);
    if (!ex) {
      charsToAdd.push({ name: pc.name, isAggregate: isAgg });
    } else if (ex.isAggregate !== isAgg) {
      charConflicts.push({ kind: "aggregateMismatch", name: pc.name, existingAggregate: ex.isAggregate, incomingAggregate: isAgg });
    } else {
      // same — no update needed
      charsToUpdate.push({ name: pc.name, oldAggregate: ex.isAggregate, newAggregate: isAgg });
    }
  }

  const preview: ImportScriptPreview = {
    charsToAdd,
    charsToUpdate,
    charConflicts,
    blockCount: parsed.filter(row => row.body.trim()).length,
    warningRehearsalMarks: warningMarks,
    typeConflicts,
  };
  return Response.json({ preview });
}

/** PUT: commit the import — clears all blocks in target version, imports fresh */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { session, deny } = await guard(req, productionId);
  if (deny) return deny;
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = (await req.json()) as ImportScriptBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });

  const versionId = await resolveImportVersionId(req, productionId);
  if (versionId instanceof Response) return versionId;

  const rawRows = body.rows ?? await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const { rows: parsed, markerRows } = parseRows(rawRows, body);
  const headerRow = getHeaderRow(rawRows, body.headerRowIncluded);
  const cueColumnNames = new Map((body.colMap.cueColumns ?? []).map(column => [
    column,
    body.colMap.cueColumnNames?.[column]?.trim() || cueListNameFromHeader(getCell(headerRow ?? [], column), column),
  ]));
  const markerConflicts = validateProvidedMarkers(markerRows, parsed);
  if (markerConflicts.length > 0) {
    return Response.json({ error: `章节分界线与段落推断不一致：${markerConflicts.join("；")}` }, { status: 400 });
  }
  const stageDelimiter = getStageDelimiter(body.stageDelimiterPattern);
  const stageBlockDelimiterReplacements = buildStageDelimiterReplacements(stageDelimiter, STAGE_DELIMITER_PATTERNS);

  const [existingChars, existingScenes, tagGroups, existingOpeningChapterId] = await Promise.all([
    listCharactersByVersion(versionId),
    listScenesByVersion(versionId),
    listTagGroups(productionId),
    getVersionOpeningChapterId(versionId),
  ]);
  const replaceScenes = !!body.sceneOverrides;

  const existingCharByName = new Map(existingChars.map(c => [c.name, c]));

  const { lyricSplitBoundary, optionSortOrderMap } = buildImportTagFormatLookup(tagGroups, body.tagChanges);

  // Build a combined scene lookup that auto-creates any scenes referenced by script rows
  // but not yet in the DB. This way scene import is not required before script import.
  const sceneByNum = new Map(existingScenes.map(s => [s.number, {
    id: s.id,
    number: s.number,
    name: s.name,
    parentId: s.parentId,
    synopsis: s.synopsis,
    actionLine: s.actionLine,
    music: s.music,
    stageNotes: s.stageNotes,
    expectedDuration: s.expectedDuration,
  }]));
  const upsertScenesFromScript: Array<{ id: string; number: string; name: string; parentId: string | null; sortOrder: number }> = [];
  const upsertSceneNums = new Set<string>();
  const replacementSceneIds = new Set<string>();
  let autoSceneSortOrder = replaceScenes ? 1 : existingScenes.length + 1;
  const overrideSceneNums = new Set<string>();
  const sourceSceneNumToOverrideNum = new Map<string, string>();

  function ensureScene(num: string, name: string | null, parentNum: string | null) {
    const existing = sceneByNum.get(num);
    // Resolve parentId — parent must be ensured first (caller guarantees order)
    const parentId = parentNum ? (sceneByNum.get(parentNum)?.id ?? null) : null;
    if (existing) {
      const nextName = name ?? existing.name ?? "";
      sceneByNum.set(num, { ...existing, name: nextName, parentId });
      if (replaceScenes && !upsertSceneNums.has(num)) {
        upsertSceneNums.add(num);
        replacementSceneIds.add(existing.id);
        upsertScenesFromScript.push({ id: existing.id, number: num, name: nextName, parentId, sortOrder: autoSceneSortOrder++ });
      }
      return;
    }
    const id = randomUUID();
    sceneByNum.set(num, {
      id,
      number: num,
      name: name ?? "",
      parentId,
      synopsis: "",
      actionLine: "",
      music: "",
      stageNotes: "",
      expectedDuration: "",
    });
    upsertSceneNums.add(num);
    if (replaceScenes) replacementSceneIds.add(id);
    upsertScenesFromScript.push({ id, number: num, name: name ?? "", parentId, sortOrder: autoSceneSortOrder++ });
  }

  if (body.sceneOverrides) {
    sceneByNum.clear();
    const existingByNum = new Map(existingScenes.map(scene => [scene.number, scene]));
    const overrideByNum = new Map(body.sceneOverrides.map(scene => [scene.num, scene]));
    body.sceneOverrides.forEach((scene, index) => {
      if (!scene.num || overrideSceneNums.has(scene.num)) return;
      overrideSceneNums.add(scene.num);
      sourceSceneNumToOverrideNum.set(scene.num, scene.num);
      for (const sourceNum of scene.sourceNums ?? []) {
        if (sourceNum) sourceSceneNumToOverrideNum.set(sourceNum, scene.num);
      }
      const existing = existingByNum.get(scene.num);
      const id = existing?.id ?? randomUUID();
      sceneByNum.set(scene.num, {
        id,
        number: scene.num,
        name: scene.name,
        parentId: null,
        synopsis: scene.synopsis ?? "",
        actionLine: scene.actionLine ?? "",
        music: scene.music ?? "",
        stageNotes: scene.stageNotes ?? "",
        expectedDuration: scene.expectedDuration ?? "",
      });
      replacementSceneIds.add(id);
      upsertScenesFromScript.push({ id, number: scene.num, name: scene.name, parentId: null, sortOrder: index + 1 });
    });
    upsertScenesFromScript.forEach(scene => {
      const override = overrideByNum.get(scene.number);
      scene.parentId = override?.parentNum ? (sceneByNum.get(override.parentNum)?.id ?? null) : null;
      const entry = sceneByNum.get(scene.number);
      if (entry) sceneByNum.set(scene.number, { ...entry, parentId: scene.parentId });
    });
    const missingParentNums = body.sceneOverrides
      .filter(scene => scene.parentNum && !overrideSceneNums.has(scene.parentNum))
      .map(scene => `${scene.num}→${scene.parentNum}`);
    if (missingParentNums.length > 0) {
      return Response.json({ error: `构作映射缺少上级段落：${missingParentNums.join("、")}` }, { status: 400 });
    }
    const missingScriptSceneNums = new Set<string>();
    for (const row of parsed) {
      const ps = parseSceneNum(row.sceneNum);
      const sceneNum = ps?.childNum ?? ps?.parentNum ?? null;
      if (sceneNum && !sourceSceneNumToOverrideNum.has(sceneNum)) missingScriptSceneNums.add(sceneNum);
    }
    if (missingScriptSceneNums.size > 0) {
      return Response.json({ error: `构作映射缺少剧本中的段落：${[...missingScriptSceneNums].join("、")}。请重新生成预览。` }, { status: 400 });
    }
  } else {
    for (const row of parsed) {
      const ps = parseSceneNum(row.sceneNum);
      if (!ps) continue;
      if (ps.childNum && ps.parentNum) {
        ensureScene(ps.parentNum, ps.parentName, null);
        ensureScene(ps.childNum, ps.childName, ps.parentNum);
      } else if (ps.parentNum) {
        ensureScene(ps.parentNum, ps.parentName, null);
      } else if (ps.childNum) {
        ensureScene(ps.childNum, ps.childName, null);
      }
    }
  }

  // Merge characters (upsert)
  const allRawChars = parsed.flatMap(r => r.rawChars);
  const parsedChars = collectImportedCharacters(allRawChars, body.characterMappings);
  const upsertChars: Array<{ id: string; name: string; isAggregate: boolean; sortOrder: number }> = [];
  const charIdByName = new Map<string, string>();

  // Build raw→name and raw→note maps covering ALL raw variants (not just the deduplicated set).
  // e.g. both "女" and "女VO" must map to name="女"; "女VO" also maps note="VO".
  const rawToName = new Map<string, string>();
  const rawToNote = new Map<string, string>();
  for (const raw of allRawChars) {
    const trimmed = raw.trim();
    if (!trimmed || rawToName.has(trimmed)) continue;
    const pc = resolveImportedCharacter(trimmed, body.characterMappings);
    rawToName.set(trimmed, pc.name);
    if (pc.note) rawToNote.set(trimmed, pc.note);
  }

  // Preserve existing chars
  for (const c of existingChars) charIdByName.set(c.name, c.id);

  let charSortOrder = existingChars.length + 1;
  for (const pc of parsedChars) {
    const isAgg = body.characterKinds?.[pc.name] != null
      ? body.characterKinds[pc.name] === "aggregate"
      : guessIsAggregate(pc.name);
    const ex = existingCharByName.get(pc.name);
    if (!ex) {
      const id = randomUUID();
      charIdByName.set(pc.name, id);
      upsertChars.push({ id, name: pc.name, isAggregate: isAgg, sortOrder: charSortOrder++ });
    } else {
      charIdByName.set(pc.name, ex.id);
    }
  }

  type BlockSpec = {
    sourceIndex: number;
    sceneId: string | null;
    blockType: "dialogue" | "stage";
    lyric: boolean;
    content: string;
    charIds: string[];
    characterAnnotations: Record<string, string>;
    stageComment: string | null;
    rehearsalMark: string | null;
    tagActions: { groupId: string; optionId: string }[];
  };
  const blockSpecs: BlockSpec[] = [];

  for (const row of parsed) {
    const ps = parseSceneNum(row.sceneNum);
    const sourceSceneNum = ps?.childNum ?? ps?.parentNum ?? null;
    const sceneNum = sourceSceneNum ? (sourceSceneNumToOverrideNum.get(sourceSceneNum) ?? sourceSceneNum) : null;
    const scene = sceneNum ? sceneByNum.get(sceneNum) : null;
    const sceneId = scene?.id ?? null;

    const baseType: "dialogue" | "stage" = row.resolvedBlockType === "stage" ? "stage" : "dialogue";
    let lyric = row.resolvedBlockType === "lyric";
    const rowTagActions = row.typeActions.flatMap(ta => (
      ta.action === "mapTag" ? [{ groupId: ta.groupId, optionId: ta.optionId }] : []
    ));

    // Apply lyricSplitAfterOptionId: if a tag falls at/before the split boundary → lyric
    if (!lyric && baseType !== "stage") {
      for (const ta of rowTagActions) {
        const boundary = lyricSplitBoundary.get(ta.groupId);
        if (boundary == null) continue;
        const assigned = optionSortOrderMap.get(`${ta.groupId}:${ta.optionId}`);
        if (assigned != null && assigned <= boundary) { lyric = true; break; }
      }
    }

    // Resolve characters
    const charIds: string[] = [];
    const characterAnnotations: Record<string, string> = {};
    for (const raw of row.rawChars) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsedName = rawToName.get(trimmed) ?? trimmed;
      const id = charIdByName.get(parsedName);
      if (!id) continue;
      charIds.push(id);
      const note = rawToNote.get(trimmed);
      if (note) characterAnnotations[id] = note;
    }

    if (!row.body.trim()) continue;
    const content = baseType === "stage"
      ? normalizeStageDelimiters(stripOuterStageDelimiter(row.body), stageBlockDelimiterReplacements)
      : row.body;
    blockSpecs.push({
      sourceIndex: row.sourceIndex,
      sceneId,
      blockType: baseType,
      lyric,
      content,
      charIds,
      characterAnnotations,
      stageComment: baseType === "stage" ? null : row.stageComment,
      rehearsalMark: row.rehearsalMark,
      tagActions: rowTagActions,
    });
  }

  // A numerically zero chapter named 开场 (or unnamed) is the imported opening.
  // Otherwise prepend a hidden, empty opening chapter.
  const existingOpeningScene = existingOpeningChapterId
    ? existingScenes.find(s => s.id === existingOpeningChapterId) ?? null
    : null;
  const importedScriptSceneIds = new Set(blockSpecs.map((spec) => spec.sceneId).filter((id): id is string => !!id));
  const importedRootScenes = [
    ...upsertScenesFromScript.filter((scene) => scene.parentId === null),
    ...[...sceneByNum.values()].filter((scene) => (
      scene.parentId === null && importedScriptSceneIds.has(scene.id)
    )),
  ];
  const importedOpeningScenes = body.firstChapterAsOpening === true
    ? importedRootScenes.slice(0, 1)
    : body.firstChapterAsOpening === false
      ? []
      : importedRootScenes.filter(isImportedOpeningChapter);
  const openingChapterMarkerId = importedOpeningScenes[0]?.id ?? existingOpeningScene?.id ?? randomUUID();
  const importedOpeningIds = new Set(importedOpeningScenes.map((scene) => scene.id));

  if (importedOpeningIds.size > 0) {
    for (const spec of blockSpecs) {
      if (spec.sceneId && importedOpeningIds.has(spec.sceneId)) spec.sceneId = openingChapterMarkerId;
    }
    for (const scene of upsertScenesFromScript) {
      if (scene.parentId && importedOpeningIds.has(scene.parentId)) scene.parentId = openingChapterMarkerId;
    }
    for (const [number, scene] of sceneByNum) {
      const id = importedOpeningIds.has(scene.id) ? openingChapterMarkerId : scene.id;
      const parentId = scene.parentId && importedOpeningIds.has(scene.parentId)
        ? openingChapterMarkerId
        : scene.parentId;
      if (id !== scene.id || parentId !== scene.parentId) {
        sceneByNum.set(number, { ...scene, id, parentId });
      }
    }
  }
  for (let index = upsertScenesFromScript.length - 1; index >= 0; index--) {
    const scene = upsertScenesFromScript[index];
    if (scene.parentId === null && importedOpeningIds.has(scene.id)) {
      upsertScenesFromScript.splice(index, 1);
      if (scene.id !== openingChapterMarkerId) replacementSceneIds.delete(scene.id);
    }
  }
  upsertScenesFromScript.unshift({
    id: openingChapterMarkerId,
    number: "",
    name: FIXED_INITIAL_CHAPTER_NAME,
    parentId: null,
    sortOrder: 0,
  });
  if (replaceScenes) replacementSceneIds.add(openingChapterMarkerId);

  const upsertBlocksWithoutKeys: Omit<ImportBlock, "lexKey">[] = [];
  const blockTagAssignments: Array<{ blockId: string; groupId: string; optionId: string }> = [];
  const cueImportsByColumn = new Map([...cueColumnNames].map(([column, name]) => [
    column,
    { name, cues: [] as Array<{ afterBlockId: string | null; content: string }> },
  ]));
  const sceneById = new Map([...sceneByNum.values()].map((scene) => [scene.id, scene]));
  const cuesBeforeSourceIndex = new Map<number, Array<{ column: number; content: string }>>();
  const trailingCueValues: Array<{ column: number; content: string }> = [];
  const scriptSourceIndices = blockSpecs.map(spec => spec.sourceIndex);
  let nextScriptSourceCursor = 0;
  for (const row of parsed) {
    if (row.cueValues.length === 0) continue;
    while (scriptSourceIndices[nextScriptSourceCursor] <= row.sourceIndex) nextScriptSourceCursor++;
    const targetSourceIndex = row.body.trim()
      ? row.sourceIndex
      : scriptSourceIndices[nextScriptSourceCursor];
    if (targetSourceIndex == null) {
      trailingCueValues.push(...row.cueValues);
      continue;
    }
    const values = cuesBeforeSourceIndex.get(targetSourceIndex) ?? [];
    values.push(...row.cueValues);
    cuesBeforeSourceIndex.set(targetSourceIndex, values);
  }
  const markerCueValuesBySceneId = new Map<string, Array<{ column: number; content: string }>>();
  for (const row of markerRows) {
    if (row.cueValues.length === 0) continue;
    const parsedScene = parseSceneNum(row.sceneNum);
    const sourceSceneNum = parsedScene?.childNum ?? parsedScene?.parentNum ?? null;
    const sceneNum = sourceSceneNum ? (sourceSceneNumToOverrideNum.get(sourceSceneNum) ?? sourceSceneNum) : null;
    const sceneId = sceneNum ? sceneByNum.get(sceneNum)?.id ?? null : null;
    if (!sceneId) continue;
    const values = markerCueValuesBySceneId.get(sceneId) ?? [];
    values.push(...row.cueValues);
    markerCueValuesBySceneId.set(sceneId, values);
  }
  const chapterIdsWithScriptBlocks = new Set<string>();
  let currentChapterId: string | null = null;
  let currentSceneId: string | null = null;
  let previousOutputBlockId: string | null = null;
  let blockBeforePreviousOutputId: string | null = null;

  const pushCueValues = (
    values: Array<{ column: number; content: string }>,
    afterBlockId = previousOutputBlockId,
  ) => {
    for (const cueValue of values) {
      cueImportsByColumn.get(cueValue.column)?.cues.push({
        afterBlockId,
        content: cueValue.content,
      });
    }
  };

  const advanceOutputBlock = (blockId: string) => {
    blockBeforePreviousOutputId = previousOutputBlockId;
    previousOutputBlockId = blockId;
  };

  pushCueValues(markerCueValuesBySceneId.get(openingChapterMarkerId) ?? []);
  upsertBlocksWithoutKeys.push({
    id: randomUUID(),
    blockId: openingChapterMarkerId,
    type: "chapter_marker",
    content: "",
    lyric: false,
    characterIds: [],
    characterAnnotations: {},
    sceneId: openingChapterMarkerId,
    rehearsalMark: null,
    markerMeta: {
      name: FIXED_INITIAL_CHAPTER_NAME,
      parentMarkerId: null,
    },
  });
  advanceOutputBlock(openingChapterMarkerId);
  currentChapterId = openingChapterMarkerId;

  const pushSceneMarkerBlock = (type: Extract<BlockType, "chapter_marker" | "scene_marker">, sceneId: string) => {
    const scene = sceneById.get(sceneId);
    const markerId = sceneId;
    const parentMarkerId = scene?.parentId
      ? scene.parentId
      : null;
    const cueAnchorId = type === "scene_marker" && parentMarkerId === previousOutputBlockId
      ? blockBeforePreviousOutputId
      : previousOutputBlockId;
    pushCueValues(markerCueValuesBySceneId.get(sceneId) ?? [], cueAnchorId);
    upsertBlocksWithoutKeys.push({
      id: randomUUID(),
      blockId: markerId,
      type,
      content: "",
      lyric: false,
      characterIds: [],
      characterAnnotations: {},
      sceneId: markerId,
      rehearsalMark: null,
      markerMeta: {
        name: scene?.name ?? "",
        parentMarkerId,
        synopsis: scene?.synopsis ?? "",
        actionLine: scene?.actionLine ?? "",
        music: scene?.music ?? "",
        stageNotes: scene?.stageNotes ?? "",
        expectedDuration: scene?.expectedDuration ?? "",
      },
    });
    advanceOutputBlock(markerId);
  };
  const pushScriptBlock = (spec: BlockSpec) => {
    const blockId = randomUUID();
    pushCueValues(cuesBeforeSourceIndex.get(spec.sourceIndex) ?? []);
    upsertBlocksWithoutKeys.push({
      id: blockId,
      type: spec.blockType,
      content: spec.content,
      stageComment: spec.stageComment,
      lyric: spec.lyric,
      characterIds: spec.charIds,
      characterAnnotations: spec.characterAnnotations,
      sceneId: null,
      rehearsalMark: null,
    });
    for (const ta of spec.tagActions) {
      blockTagAssignments.push({ blockId, groupId: ta.groupId, optionId: ta.optionId });
    }
    advanceOutputBlock(blockId);
  };
  const pushSpecWithRehearsal = (spec: BlockSpec, previousSpec: BlockSpec | null) => {
    if (spec.rehearsalMark && (
      spec.rehearsalMark !== previousSpec?.rehearsalMark ||
      spec.sceneId !== previousSpec?.sceneId
    )) {
      const rehearsalBlockId = randomUUID();
      upsertBlocksWithoutKeys.push({
        id: rehearsalBlockId,
        type: "rehearsal_marker",
        content: "",
        lyric: false,
        characterIds: [],
        characterAnnotations: {},
        sceneId: null,
        rehearsalMark: null,
      });
      advanceOutputBlock(rehearsalBlockId);
    }
    pushScriptBlock(spec);
  };

  if (body.sceneOverrides) {
    const specsBySceneId = new Map<string | null, BlockSpec[]>();
    for (const spec of blockSpecs) {
      const key = spec.sceneId ?? null;
      const specs = specsBySceneId.get(key);
      if (specs) specs.push(spec);
      else specsBySceneId.set(key, [spec]);
    }
    let previousSpec: BlockSpec | null = null;
    for (const spec of specsBySceneId.get(null) ?? []) {
      pushSpecWithRehearsal(spec, previousSpec);
      previousSpec = spec;
    }
    for (const override of body.sceneOverrides) {
      const scene = sceneByNum.get(override.num);
      if (!scene) continue;
      if (scene.parentId === null) {
        if (scene.id !== openingChapterMarkerId) {
          pushSceneMarkerBlock("chapter_marker", scene.id);
        }
        currentChapterId = scene.id;
      } else {
        if (currentChapterId !== scene.parentId) {
          if (scene.parentId !== openingChapterMarkerId) {
            pushSceneMarkerBlock("chapter_marker", scene.parentId);
          }
          currentChapterId = scene.parentId;
        }
        pushSceneMarkerBlock("scene_marker", scene.id);
      }
      const sceneSpecs = specsBySceneId.get(scene.id) ?? [];
      for (const spec of sceneSpecs) {
        pushSpecWithRehearsal(spec, previousSpec);
        previousSpec = spec;
      }
    }
  } else for (let i = 0; i < blockSpecs.length; i++) {
    const spec = blockSpecs[i];
    const scene = spec.sceneId ? sceneById.get(spec.sceneId) ?? null : null;
    if (scene) {
      if (scene.parentId === null) {
        chapterIdsWithScriptBlocks.add(scene.id);
        if (currentChapterId !== scene.id) {
          if (scene.id !== openingChapterMarkerId) {
            pushSceneMarkerBlock("chapter_marker", scene.id);
          }
          currentChapterId = scene.id;
          currentSceneId = null;
        }
      } else {
        chapterIdsWithScriptBlocks.add(scene.parentId);
        if (currentChapterId !== scene.parentId) {
          if (scene.parentId !== openingChapterMarkerId) {
            pushSceneMarkerBlock("chapter_marker", scene.parentId);
          }
          currentChapterId = scene.parentId;
          currentSceneId = null;
        }
        if (currentSceneId !== scene.id) {
          pushSceneMarkerBlock("scene_marker", scene.id);
          currentSceneId = scene.id;
        }
      }
    }
    const previousSpec = i > 0 ? blockSpecs[i - 1] : null;
    pushSpecWithRehearsal(spec, previousSpec);
  }
  pushCueValues(trailingCueValues);
  const lexKeys = initialKeys(upsertBlocksWithoutKeys.length);
  const upsertBlocks: ImportBlock[] = upsertBlocksWithoutKeys.map((block, index) => ({
    ...block,
    lexKey: lexKeys[index],
  }));
  const blankChapterIds = body.sceneOverrides ? new Set<string>() : new Set(
    [...sceneById.values()]
      .filter((scene) => (
        scene.id !== openingChapterMarkerId &&
        scene.parentId === null &&
        !chapterIdsWithScriptBlocks.has(scene.id)
      ))
      .map((scene) => scene.id)
  );
  const deleteSceneIds = [
    ...blankChapterIds,
    ...[...sceneById.values()]
      .filter((scene) => scene.parentId !== null && blankChapterIds.has(scene.parentId))
      .map((scene) => scene.id),
    ...(replaceScenes
      ? existingScenes
          .filter((scene) => !replacementSceneIds.has(scene.id))
          .map((scene) => scene.id)
      : []),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const aggregateMemberships: Array<{ aggregateId: string; memberIds: string[] }> = [];
  for (const [aggregateName, memberNames] of Object.entries(body.aggregateMembers ?? {})) {
    const aggregateId = charIdByName.get(aggregateName);
    if (!aggregateId) {
      return Response.json({ error: `聚合角色不存在：${aggregateName}` }, { status: 400 });
    }
    const missingMember = memberNames.find(name => !charIdByName.has(name));
    if (missingMember) {
      return Response.json({ error: `聚合角色 ${aggregateName} 的成员不存在：${missingMember}` }, { status: 400 });
    }
    aggregateMemberships.push({
      aggregateId,
      memberIds: memberNames.map(name => charIdByName.get(name)!),
    });
  }

  await importScriptToVersion(productionId, versionId, {
    upsertBlocks,
    upsertChars,
    upsertScenes: upsertScenesFromScript,
    deleteSceneIds,
    upsertCueColumns: [...cueImportsByColumn.values()],
    cueListCreatedBy: session.userId,
    blockTagAssignments,
    tagChanges: body.tagChanges,
    aggregateMembers: aggregateMemberships,
    openingChapter: {
      markerId: openingChapterMarkerId,
      show: importedOpeningIds.size > 0 ? undefined : false,
    },
    stageDelimiters: { open: stageDelimiter.open, close: stageDelimiter.close },
    ensureEmptySceneBlocks: !!body.sceneOverrides,
  });

  // Build per-scene block count summary (covers both existing and auto-created scenes)
  const sceneIdToInfo = new Map([...sceneByNum.values()].map(s => [s.id, { num: s.number, name: s.name }]));
  const countBySceneId = new Map<string | null, number>();
  for (const spec of blockSpecs) {
    const key = spec.sceneId ?? null;
    countBySceneId.set(key, (countBySceneId.get(key) ?? 0) + 1);
  }
  const sceneSummary = [...countBySceneId.entries()]
    .map(([id, count]) => {
      const info = id ? sceneIdToInfo.get(id) : null;
      return { sceneId: id, num: info?.num ?? null, name: info?.name ?? null, count };
    })
    .sort((a, b) => (a.num ?? "￿").localeCompare(b.num ?? "￿", undefined, { numeric: true }));

  return Response.json({ ok: true, blocksImported: blockSpecs.length, charsAdded: upsertChars.length, sceneSummary });
}
