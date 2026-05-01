import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionScenes, flushToDB, updateSceneMetadata } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import type { SceneColMap, ParsedSceneNum, SceneConflict, ImportScenePreview } from "@/lib/import/types";
import { randomUUID } from "node:crypto";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSheetValues } from "@/lib/import/feishu-sheet";

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

type ImportScenesBody = {
  spreadsheetToken: string;
  sheetId: string;
  rowCount?: number;
  colMap: SceneColMap;
  headerRowIncluded?: boolean;
};

type SceneRow = {
  rawNum: string;
  parsed: ParsedSceneNum;
  /** Name for the scene this row represents (child if present, else parent). NOT the parent act's name. */
  name: string | null;
  /** Name for the implied parent act from this row (only when childNum is set). */
  impliedParentName: string | null;
  intro: string | null;
  actionLine: string | null;
  music: string | null;
  stagePres: string | null;
  duration: string | null;
};

function buildSceneRows(rows: (string | null)[][], colMap: SceneColMap, headerRowIncluded?: boolean): SceneRow[] {
  const dataRows = headerRowIncluded ? rows.slice(1) : rows;
  const results: SceneRow[] = [];

  for (const row of dataRows) {
    const rawNum = row[colMap.sceneNum]?.trim();
    if (!rawNum) continue;

    const parsed = parseSceneNum(rawNum);
    if (!parsed) continue;

    // Name for the scene itself (child if present, else the parent act)
    let name: string | null = colMap.sceneName != null ? row[colMap.sceneName]?.trim() || null : null;
    if (!name) {
      // Only use the portion that belongs to this scene's level
      name = parsed.childNum ? parsed.childName : parsed.parentName;
    }

    // Name the parent act inherits when this row encodes "1选择-1" → act name "选择"
    const impliedParentName = parsed.childNum ? parsed.parentName : null;

    results.push({
      rawNum,
      parsed,
      name,
      impliedParentName,
      intro: colMap.intro != null ? row[colMap.intro]?.trim() || null : null,
      actionLine: colMap.actionLine != null ? row[colMap.actionLine]?.trim() || null : null,
      music: colMap.music != null ? row[colMap.music]?.trim() || null : null,
      stagePres: colMap.stagePres != null ? row[colMap.stagePres]?.trim() || null : null,
      duration: colMap.duration != null ? row[colMap.duration]?.trim() || null : null,
    });
  }
  return results;
}

/**
 * Build a deduplicated Map<sceneNumber, entry> from sceneRows.
 * Parent acts come from:
 *   - rows where childNum is null (explicit act rows)
 *   - rows where childNum is set and parentNum is present (implied acts)
 * Child scenes only appear once.
 */
function buildSceneMap(
  sceneRows: SceneRow[],
  existingByNum: Map<string, { id: string; number: string; name: string }>,
  initialSortOrder: number,
) {
  type Entry = { id: string; num: string; name: string; parentNum: string | null; sortOrder: number };
  const map = new Map<string, Entry>();
  let sortOrder = initialSortOrder;

  function getOrCreateScene(num: string, name: string | null, parentNum: string | null): Entry {
    if (map.has(num)) {
      const e = map.get(num)!;
      // Upgrade name if we now have a better one
      if (name && !e.name) map.set(num, { ...e, name });
      return map.get(num)!;
    }
    const ex = existingByNum.get(num);
    const entry: Entry = {
      id: ex?.id ?? randomUUID(),
      num,
      name: name ?? ex?.name ?? "",
      parentNum,
      sortOrder: ex ? -1 : sortOrder++, // -1 = preserve existing order
    };
    map.set(num, entry);
    return entry;
  }

  for (const row of sceneRows) {
    const { parsed, name, impliedParentName } = row;

    if (parsed.childNum && parsed.parentNum) {
      // Create parent act first (implied by this row)
      getOrCreateScene(parsed.parentNum, impliedParentName, null);
      // Then create child scene
      getOrCreateScene(parsed.childNum, name, parsed.parentNum);
    } else if (parsed.parentNum) {
      // Pure top-level row (no childNum)
      getOrCreateScene(parsed.parentNum, name, null);
    }
  }

  return map;
}

/** POST: preview (dry-run) */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const t0 = Date.now();
  const body = (await req.json()) as ImportScenesBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  console.log(`[import-scenes POST] fetched ${rawRows.length} rows in ${Date.now() - t0}ms`);

  const sceneRows = buildSceneRows(rawRows, body.colMap, body.headerRowIncluded);
  console.log(`[import-scenes POST] sceneRows built: ${sceneRows.length} in ${Date.now() - t0}ms`);

  const existing = await listProductionScenes(productionId);
  console.log(`[import-scenes POST] listProductionScenes: ${existing.length} existing in ${Date.now() - t0}ms`);
  const existingByNum = new Map(existing.map(s => [s.number, s]));

  const sceneMap = buildSceneMap(sceneRows, existingByNum, existing.length + 1);
  console.log(`[import-scenes POST] sceneMap built: ${sceneMap.size} scenes in ${Date.now() - t0}ms`);

  const conflicts: SceneConflict[] = [];
  const scenesToAdd: ImportScenePreview["scenesToAdd"] = [];
  const scenesToUpdate: ImportScenePreview["scenesToUpdate"] = [];

  for (const [num, entry] of sceneMap) {
    if (entry.parentNum && !sceneMap.has(entry.parentNum) && !existingByNum.has(entry.parentNum)) {
      conflicts.push({ kind: "parentMissing", sceneNum: num, parentNum: entry.parentNum });
    }
    const ex = existingByNum.get(num);
    if (!ex) {
      scenesToAdd.push({ num, name: entry.name, parentNum: entry.parentNum });
    } else if (entry.name && ex.name && entry.name !== ex.name) {
      scenesToUpdate.push({ num, oldName: ex.name, newName: entry.name });
    }
  }

  // Count existing scenes that will receive metadata updates
  const metaToUpdate = sceneRows.filter(row => {
    if (!row.intro && !row.actionLine && !row.music && !row.stagePres && !row.duration) return false;
    const num = row.parsed.childNum ?? row.parsed.parentNum;
    return num != null && existingByNum.has(num);
  }).length;

  console.log(`[import-scenes POST] preview done in ${Date.now() - t0}ms`);
  return Response.json({ preview: { scenesToAdd, scenesToUpdate, metaToUpdate, conflicts } as ImportScenePreview });
}

/** PUT: commit */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const t0 = Date.now();
  const body = (await req.json()) as ImportScenesBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const sceneRows = buildSceneRows(rawRows, body.colMap, body.headerRowIncluded);
  console.log(`[import-scenes PUT] sceneRows: ${sceneRows.length} in ${Date.now() - t0}ms`);

  const existing = await listProductionScenes(productionId);
  console.log(`[import-scenes PUT] listProductionScenes: ${existing.length} in ${Date.now() - t0}ms`);
  const existingByNum = new Map(existing.map(s => [s.number, s]));

  const sceneMap = buildSceneMap(sceneRows, existingByNum, existing.length + 1);

  // Assign sortOrders for existing scenes using their current position
  let newSortOrder = existing.length + 1;
  const upsertScenes: Parameters<typeof flushToDB>[1]["upsertScenes"] = [];

  for (const [num, entry] of sceneMap) {
    const ex = existingByNum.get(num);
    const sortOrder = ex
      ? existing.findIndex(s => s.number === num) + 1
      : (entry.sortOrder === -1 ? newSortOrder++ : entry.sortOrder);
    const parentId = entry.parentNum
      ? (existingByNum.get(entry.parentNum)?.id ?? sceneMap.get(entry.parentNum)?.id ?? null)
      : null;
    upsertScenes.push({
      id: entry.id,
      number: num,
      name: entry.name,
      parentId,
      sortOrder,
    });
  }

  // Metadata updates keyed by row
  const metadataUpdates: { id: string; row: SceneRow }[] = [];
  for (const row of sceneRows) {
    if (!row.intro && !row.actionLine && !row.music && !row.stagePres && !row.duration) continue;
    const num = row.parsed.childNum ?? row.parsed.parentNum;
    if (!num) continue;
    const entry = sceneMap.get(num);
    if (entry) metadataUpdates.push({ id: entry.id, row });
  }

  console.log(`[import-scenes PUT] flushing ${upsertScenes.length} scenes, ${metadataUpdates.length} meta updates at ${Date.now() - t0}ms`);
  await flushToDB(productionId, {
    upsertScenes,
    deleteSceneIds: [],
    upsertBlocks: [],
    deleteBlockIds: [],
    upsertChars: [],
    deleteCharIds: [],
  });
  console.log(`[import-scenes PUT] flushToDB done at ${Date.now() - t0}ms`);

  await Promise.all(metadataUpdates.map(({ id, row }) =>
    updateSceneMetadata(id, productionId, {
      synopsis: row.intro ?? undefined,
      actionLine: row.actionLine ?? undefined,
      music: row.music ?? undefined,
      stageNotes: row.stagePres ?? undefined,
      expectedDuration: row.duration ?? undefined,
    })
  ));
  console.log(`[import-scenes PUT] metadata done at ${Date.now() - t0}ms`);

  return Response.json({ ok: true, imported: upsertScenes.length });
}
