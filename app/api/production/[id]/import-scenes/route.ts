import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listScenesByVersion, listSceneVersionsByVersion, flushToDBVersioned, updateSceneMetadata, getActiveVersionId, getVersion, ensureScriptMarkerMigration } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import type { SceneColMap, SceneConflict, ImportScenePreview } from "@/lib/import/types";
import { buildSceneRows, buildSceneMap } from "@/lib/import/scene-builder";
import type { SceneRow } from "@/lib/import/scene-builder";
import { TOKEN_COOKIE } from "@/lib/feishu-auth";
import { getSheetValues } from "@/lib/import/feishu-sheet";

async function guard(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
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

async function listExistingScenesForImport(versionId: string, productionId: string) {
  const markerScenes = await listScenesByVersion(versionId);
  if (markerScenes.length > 0) {
    return { scenes: markerScenes, markerBacked: true };
  }
  return { scenes: await listSceneVersionsByVersion(versionId), markerBacked: false };
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
  if (!resolvedVersionId) {
    return Response.json({ error: "演出没有可用版本，无法导入构作" }, { status: 400 });
  }
  const migration = await ensureScriptMarkerMigration(resolvedVersionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
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
      conflicts.push({ kind: "markerMissing", sceneNum: num, sceneName: entry.name });
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
  if (!resolvedVersionId) {
    return Response.json({ error: "演出没有可用版本，无法导入构作" }, { status: 400 });
  }
  const migration = await ensureScriptMarkerMigration(resolvedVersionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
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
  const upsertScenes: Parameters<typeof flushToDBVersioned>[2]["upsertScenes"] = [];

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

  if (!resolvedVersionId) {
    return Response.json({ error: "演出没有可用版本，无法导入构作" }, { status: 400 });
  }
  await flushToDBVersioned(productionId, resolvedVersionId, {
    upsertScenes,
    deleteSceneIds,
    upsertBlocks: [],
    deleteSnapshotIds: [],
    upsertChars: [],
    deleteCharIds: [],
  });
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
