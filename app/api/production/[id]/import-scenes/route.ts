import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listScenesByVersion, listSceneVersionsByVersion, listProductionScenes, flushToDB, flushToDBVersioned, updateSceneMetadata, getActiveVersionId, getVersion, ensureScriptMarkerMigration } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { parseSceneNum } from "@/lib/import/parse-scene-num";
import type { SceneColMap, ParsedSceneNum, SceneConflict, ImportScenePreview } from "@/lib/import/types";
import { FIXED_INITIAL_CHAPTER_BLOCK_ID } from "@/lib/script-fixed-markers";
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
  replaceExisting?: boolean;
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

async function resolveImportVersionId(req: NextRequest, productionId: string): Promise<string | null | Response> {
  const versionIdParam = req.nextUrl.searchParams.get("v");
  if (!versionIdParam) return getActiveVersionId(productionId);
  const ver = await getVersion(versionIdParam);
  if (!ver || ver.productionId !== productionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  if (ver.status !== "editing") {
    return Response.json({ error: "只能向编辑中的版本导入构作" }, { status: 400 });
  }
  return versionIdParam;
}

async function listExistingScenesForImport(versionId: string | null, productionId: string) {
  if (!versionId) return { scenes: await listProductionScenes(productionId), markerBacked: false };
  const markerScenes = await listScenesByVersion(versionId);
  if (markerScenes.some((scene) => scene.id !== FIXED_INITIAL_CHAPTER_BLOCK_ID)) {
    return { scenes: markerScenes, markerBacked: true };
  }
  return { scenes: await listSceneVersionsByVersion(versionId), markerBacked: false };
}

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

  const body = (await req.json()) as ImportScenesBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);

  const sceneRows = buildSceneRows(rawRows, body.colMap, body.headerRowIncluded);

  const resolvedVersionId = await resolveImportVersionId(req, productionId);
  if (resolvedVersionId instanceof Response) return resolvedVersionId;
  if (resolvedVersionId) {
    const migration = await ensureScriptMarkerMigration(resolvedVersionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }
  }
  const { scenes: existing, markerBacked } = await listExistingScenesForImport(resolvedVersionId, productionId);
  const existingByNum = new Map(existing.map(s => [s.number, s]));

  const sceneMap = buildSceneMap(sceneRows, existingByNum, existing.length + 1);

  const conflicts: SceneConflict[] = [];
  const scenesToAdd: ImportScenePreview["scenesToAdd"] = [];
  const scenesToUpdate: ImportScenePreview["scenesToUpdate"] = [];

  for (const [num, entry] of sceneMap) {
    if (entry.parentNum && !sceneMap.has(entry.parentNum) && !existingByNum.has(entry.parentNum)) {
      conflicts.push({ kind: "parentMissing", sceneNum: num, parentNum: entry.parentNum });
    }
    const ex = existingByNum.get(num);
    if (!ex && markerBacked) {
      conflicts.push({ kind: "markerMissing", sceneNum: num });
    } else if (!ex) {
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

  return Response.json({ preview: { scenesToAdd, scenesToUpdate, metaToUpdate, conflicts } as ImportScenePreview });
}

/** PUT: commit */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: productionId } = await ctx.params;
  const { deny } = await guard(req, productionId);
  if (deny) return deny;

  const body = (await req.json()) as ImportScenesBody;
  const userToken = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!userToken) return Response.json({ error: "飞书授权已过期，请重新登录" }, { status: 401 });
  const rawRows = await getSheetValues(body.spreadsheetToken, body.sheetId, userToken, body.rowCount);
  const sceneRows = buildSceneRows(rawRows, body.colMap, body.headerRowIncluded);

  const resolvedVersionId = await resolveImportVersionId(req, productionId);
  if (resolvedVersionId instanceof Response) return resolvedVersionId;
  if (resolvedVersionId) {
    const migration = await ensureScriptMarkerMigration(resolvedVersionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }
  }
  const { scenes: existing, markerBacked } = await listExistingScenesForImport(resolvedVersionId, productionId);
  const existingByNum = new Map(existing.map(s => [s.number, s]));
  const existingOrderByNum = new Map(existing.map((scene, index) => [scene.number, index + 1]));

  const sceneMap = buildSceneMap(sceneRows, existingByNum, existing.length + 1);
  if (markerBacked) {
    const missingMarkerSceneNums = [...sceneMap.keys()].filter((num) => !existingByNum.has(num));
    if (missingMarkerSceneNums.length > 0) {
      return Response.json(
        { error: `构作导入包含尚未在剧本中建立标记块的段落：${missingMarkerSceneNums.join("、")}。请先在剧本中建立对应章节/场标记。` },
        { status: 400 }
      );
    }
  }

  // Assign sortOrders for existing scenes using their current position
  let newSortOrder = existing.length + 1;
  const upsertScenes: Parameters<typeof flushToDB>[1]["upsertScenes"] = [];

  for (const [num, entry] of sceneMap) {
    const ex = existingByNum.get(num);
    const sortOrder = ex
      ? existingOrderByNum.get(num) ?? newSortOrder++
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
  const deleteSceneIds = body.replaceExisting
    ? existing.filter(scene => !sceneMap.has(scene.number)).map(scene => scene.id)
    : [];

  // Metadata updates keyed by row
  const metadataUpdates: { id: string; row: SceneRow }[] = [];
  for (const row of sceneRows) {
    if (!row.intro && !row.actionLine && !row.music && !row.stagePres && !row.duration) continue;
    const num = row.parsed.childNum ?? row.parsed.parentNum;
    if (!num) continue;
    const entry = sceneMap.get(num);
    if (entry) metadataUpdates.push({ id: entry.id, row });
  }

  if (resolvedVersionId) {
    await flushToDBVersioned(productionId, resolvedVersionId, {
      upsertScenes,
      deleteSceneIds,
      upsertBlocks: [],
      deleteSnapshotIds: [],
      upsertChars: [],
      deleteCharIds: [],
    });
  } else {
    await flushToDB(productionId, {
      upsertScenes,
      deleteSceneIds,
      upsertBlocks: [],
      deleteBlockIds: [],
      upsertChars: [],
      deleteCharIds: [],
    });
  }
  if (resolvedVersionId) {
    await Promise.all(metadataUpdates.map(({ id, row }) =>
      updateSceneMetadata(productionId, id, resolvedVersionId, {
        synopsis: row.intro ?? undefined,
        actionLine: row.actionLine ?? undefined,
        music: row.music ?? undefined,
        stageNotes: row.stagePres ?? undefined,
        expectedDuration: row.duration ?? undefined,
      })
    ));
  }

  return Response.json({ ok: true, imported: upsertScenes.length });
}
