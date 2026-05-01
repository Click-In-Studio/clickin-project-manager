import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSheetValues } from "@/lib/import/feishu-sheet";
import { getProductionMemberContext, listProductionScenes, listProductionCharacters, flushToDB, loadProduction, setCharacterMembers, bulkUpsertBlockTags, listTagGroups } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import { parseCharacter, collectCharacters, guessIsAggregate } from "@/lib/import/parse-character";
import type { ScriptColMap, TypeTagMapping, ImportScriptPreview, AggregateMembers } from "@/lib/import/types";
import { initialKeys } from "@/lib/lex-order";
import { randomUUID } from "node:crypto";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (isArchived) return { session, deny: Response.json({ error: "已归档" }, { status: 403 }) };
  if (!hasPermission("manage_permissions", session.isAdmin, memberRoles, overrides)) {
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
  /** For aggregate characters: which base-character names are members */
  aggregateMembers?: AggregateMembers;
  headerRowIncluded?: boolean;
};

const REHEARSAL_MARK_RE = /^[A-Za-z]\d*$|^\d+[A-Za-z]?$/;


function getCell(row: (string | null)[], col: number | undefined): string | null {
  if (col == null) return null;
  return row[col]?.trim() || null;
}

/** Parse rows into intermediate import records */
function parseRows(rows: (string | null)[][], body: Omit<ImportScriptBody, "spreadsheetToken" | "sheetId" | "rowCount">) {
  const { colMap, typeTagMapping, characterKinds, headerRowIncluded } = body;
  const dataRows = headerRowIncluded ? rows.slice(1) : rows;

  type ParsedRow = {
    sceneNum: string;
    rehearsalMark: string | null;
    rawType: string | null;
    rawChars: string[];
    body: string;
    typeActions: TypeTagMapping[string][];
    warningMark: boolean;
  };

  const result: ParsedRow[] = [];
  const warningMarks: string[] = [];

  for (const row of dataRows) {
    const rawSceneNum = getCell(row, colMap.sceneNum);
    if (!rawSceneNum) continue;

    const rawType = getCell(row, colMap.typeTag);
    // Split multi-value type cells (same delimiter as character column).
    // An empty cell uses key "" so users can map blank cells explicitly.
    const typeParts = rawType
      ? rawType.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)
      : [""];
    const typeActions = typeParts
      .map(p => typeTagMapping?.[p] ?? null)
      .filter((a): a is TypeTagMapping[string] => a !== null);
    if (typeActions.some(a => a.action === "ignore")) continue;

    const rawMark = getCell(row, colMap.rehearsalMark);
    const warningMark = !!(rawMark && !REHEARSAL_MARK_RE.test(rawMark));
    if (warningMark && rawMark && !warningMarks.includes(rawMark)) warningMarks.push(rawMark);

    // Build body by concatenating body columns
    const bodyParts = colMap.bodyColumns.map(col => {
      const val = getCell(row, col);
      if (!val) return null;
      const isStage = colMap.stageInlineColumns?.includes(col);
      return isStage ? `（${val}）` : val;
    }).filter(Boolean);
    const body = bodyParts.join("\n");

    // Characters
    const rawCharCell = getCell(row, colMap.character);
    const rawChars = rawCharCell
      ? rawCharCell.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)
      : [];

    result.push({ sceneNum: rawSceneNum, rehearsalMark: rawMark, rawType, rawChars, body, typeActions, warningMark });
    void characterKinds;
  }

  return { rows: result, warningMarks };
}

/** POST: preview what would be imported */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const body = (await req.json()) as ImportScriptBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const { rows: parsed, warningMarks } = parseRows(rawRows, body);

  const [existingChars, existingScenes] = await Promise.all([
    listProductionCharacters(productionId),
    listProductionScenes(productionId),
  ]);
  const existingCharByName = new Map(existingChars.map(c => [c.name, c]));
  void existingScenes;

  // Collect all unique character names from import
  const allRawChars = parsed.flatMap(r => r.rawChars);
  const parsedChars = collectCharacters(allRawChars);

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
    blockCount: parsed.length,
    warningRehearsalMarks: warningMarks,
  };
  return Response.json({ preview });
}

/** PUT: commit the import — clears existing script blocks, imports fresh */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const body = (await req.json()) as ImportScriptBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const { rows: parsed } = parseRows(rawRows, body);

  const [existingChars, existingScenes, production, tagGroups] = await Promise.all([
    listProductionCharacters(productionId),
    listProductionScenes(productionId),
    loadProduction(productionId),
    listTagGroups(productionId),
  ]);

  const existingCharByName = new Map(existingChars.map(c => [c.name, c]));

  // Build lyric-split lookup from tag group settings
  const lyricSplitBoundary = new Map<string, number>(); // groupId → split option's sortOrder
  const optionSortOrderMap = new Map<string, number>(); // `${groupId}:${optionId}` → sortOrder
  for (const g of tagGroups) {
    for (const o of g.options) optionSortOrderMap.set(`${g.id}:${o.id}`, o.sortOrder);
    if (g.lyricSplitAfterOptionId) {
      const splitOpt = g.options.find(o => o.id === g.lyricSplitAfterOptionId);
      if (splitOpt) lyricSplitBoundary.set(g.id, splitOpt.sortOrder);
    }
  }

  // Build a combined scene lookup that auto-creates any scenes referenced by script rows
  // but not yet in the DB. This way scene import is not required before script import.
  const sceneByNum = new Map(existingScenes.map(s => [s.number, { id: s.id, number: s.number, name: s.name }]));
  const upsertScenesFromScript: Parameters<typeof flushToDB>[1]["upsertScenes"] = [];
  let autoSceneSortOrder = existingScenes.length + 1;

  function ensureScene(num: string, name: string | null, parentNum: string | null) {
    if (sceneByNum.has(num)) return;
    const id = randomUUID();
    sceneByNum.set(num, { id, number: num, name: name ?? "" });
    // Resolve parentId — parent must be ensured first (caller guarantees order)
    const parentId = parentNum ? (sceneByNum.get(parentNum)?.id ?? null) : null;
    upsertScenesFromScript.push({ id, number: num, name: name ?? "", parentId, sortOrder: autoSceneSortOrder++ });
  }

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

  // Merge characters (upsert)
  const allRawChars = parsed.flatMap(r => r.rawChars);
  const parsedChars = collectCharacters(allRawChars);
  const upsertChars: Parameters<typeof flushToDB>[1]["upsertChars"] = [];
  const charIdByName = new Map<string, string>();

  // Build raw→name and raw→note maps covering ALL raw variants (not just the deduplicated set).
  // e.g. both "女" and "女VO" must map to name="女"; "女VO" also maps note="VO".
  const rawToName = new Map<string, string>();
  const rawToNote = new Map<string, string>();
  for (const raw of allRawChars) {
    const trimmed = raw.trim();
    if (!trimmed || rawToName.has(trimmed)) continue;
    const pc = parseCharacter(trimmed);
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

  // Delete all existing blocks for this production
  const existingBlockIds = production?.state.blocks.map((b: { id: string }) => b.id) ?? [];

  type BlockSpec = {
    sceneId: string | null;
    blockType: "dialogue" | "stage";
    lyric: boolean;
    content: string;
    charIds: string[];
    characterAnnotations: Record<string, string>;
    rehearsalMark: string | null;
    tagActions: { groupId: string; optionId: string }[];
  };
  const blockSpecs: BlockSpec[] = [];

  for (const row of parsed) {
    const ps = parseSceneNum(row.sceneNum);
    const sceneNum = ps?.childNum ?? ps?.parentNum ?? null;
    const scene = sceneNum ? sceneByNum.get(sceneNum) : null;
    const sceneId = scene?.id ?? null;

    // Determine base block type (first mapType wins; all mapTags collected)
    let baseType: "dialogue" | "stage" = "dialogue";
    let lyric = false;
    const rowTagActions: { groupId: string; optionId: string }[] = [];
    for (const ta of row.typeActions) {
      if (ta.action === "mapType") {
        if (ta.blockType === "stage") baseType = "stage";
        else if (ta.blockType === "lyric") { baseType = "dialogue"; lyric = true; }
      } else if (ta.action === "mapTag") {
        rowTagActions.push({ groupId: ta.groupId, optionId: ta.optionId });
      }
    }

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
    blockSpecs.push({
      sceneId,
      blockType: baseType,
      lyric,
      content: row.body,
      charIds,
      characterAnnotations,
      rehearsalMark: row.rehearsalMark,
      tagActions: rowTagActions,
    });
  }

  const lexKeys = initialKeys(blockSpecs.length);
  const upsertBlocks: Parameters<typeof flushToDB>[1]["upsertBlocks"] = [];
  const blockTagAssignments: Array<{ blockId: string; groupId: string; optionId: string }> = [];

  for (let i = 0; i < blockSpecs.length; i++) {
    const spec = blockSpecs[i];
    const blockId = randomUUID();
    upsertBlocks.push({
      id: blockId,
      type: spec.blockType,
      content: spec.content,
      lyric: spec.lyric,
      characterIds: spec.charIds,
      characterAnnotations: spec.characterAnnotations,
      sceneId: spec.sceneId,
      rehearsalMark: spec.rehearsalMark,
      orderKey: i,
      lexKey: lexKeys[i],
    });
    for (const ta of spec.tagActions) {
      blockTagAssignments.push({ blockId, groupId: ta.groupId, optionId: ta.optionId });
    }
  }

  await flushToDB(productionId, {
    upsertBlocks,
    deleteBlockIds: existingBlockIds,
    upsertChars,
    deleteCharIds: [],
    upsertScenes: upsertScenesFromScript,
    deleteSceneIds: [],
  });

  // Set aggregate member associations
  if (body.aggregateMembers) {
    await Promise.all(
      Object.entries(body.aggregateMembers).map(([aggName, memberNames]) => {
        const aggId = charIdByName.get(aggName);
        if (!aggId) return Promise.resolve();
        const memberIds = memberNames
          .map(n => charIdByName.get(n))
          .filter((id): id is string => !!id);
        return setCharacterMembers(aggId, memberIds);
      })
    );
  }

  // Write block tag assignments (mapTag type action); deduplicate (block_id, group_id) pairs
  const dedupedTags = [...new Map(
    blockTagAssignments.map(t => [`${t.blockId}:${t.groupId}`, t])
  ).values()];
  await bulkUpsertBlockTags(dedupedTags);

  // Build per-scene block count summary (covers both existing and auto-created scenes)
  const sceneIdToInfo = new Map([...sceneByNum.values()].map(s => [s.id, { num: s.number, name: s.name }]));
  const countBySceneId = new Map<string | null, number>();
  for (const b of upsertBlocks) {
    const key = b.sceneId ?? null;
    countBySceneId.set(key, (countBySceneId.get(key) ?? 0) + 1);
  }
  const sceneSummary = [...countBySceneId.entries()]
    .map(([id, count]) => {
      const info = id ? sceneIdToInfo.get(id) : null;
      return { sceneId: id, num: info?.num ?? null, name: info?.name ?? null, count };
    })
    .sort((a, b) => (a.num ?? "￿").localeCompare(b.num ?? "￿", undefined, { numeric: true }));

  return Response.json({ ok: true, blocksImported: upsertBlocks.length, charsAdded: upsertChars.length, sceneSummary });
}
