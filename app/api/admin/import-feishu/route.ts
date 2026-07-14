/**
 * One-time import: pull a Feishu wiki/bitable into the local PostgreSQL DB.
 * Uses the app's tenant_access_token so no user OAuth is required.
 *
 * POST /api/admin/import-feishu
 * Body: { wikiUrl: string; name: string }
 */
import { type NextRequest } from "next/server";
import { getAppAccessToken } from "@/lib/feishu-auth";
import {
  parseWikiUrl,
  resolveWikiToken,
  getFirstTable,
  getTableFields,
  validateSchema,
  getAllRecords,
  toScriptState,
} from "@/lib/feishu-bitable";
import { createProduction, flushToDB, savePageMap } from "@/lib/db";
import { computePageMap, PAGE_CONFIGS } from "@/lib/script-page";
import { initialKeys } from "@/lib/lex-order";
import { withMarkerOwnership } from "@/lib/script-marker-blocks";
import type { Block } from "@/lib/script-types";

let _seq = 0;
function uid(): string {
  return `${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

export async function POST(req: NextRequest) {
  const { wikiUrl, name } = (await req.json()) as { wikiUrl?: string; name?: string };

  if (!wikiUrl || !name?.trim()) {
    return Response.json({ error: "wikiUrl 和 name 均为必填" }, { status: 400 });
  }

  const wikiToken = parseWikiUrl(wikiUrl);
  if (!wikiToken) {
    return Response.json({ error: "无法解析 Wiki 链接" }, { status: 400 });
  }

  // Use tenant access token — no user OAuth needed for internal apps with bitable/wiki perms
  const token = await getAppAccessToken();

  // Resolve wiki node → bitable
  const appToken = await resolveWikiToken(wikiToken, token);
  const tableId = await getFirstTable(appToken, token);

  // Load schema + records
  const fields = await getTableFields(appToken, tableId, token);
  const validation = validateSchema(fields);
  if (!validation.ok) {
    return Response.json({ error: "表格结构不匹配", details: validation.errors }, { status: 400 });
  }

  const records = await getAllRecords(appToken, tableId, token);
  const state = toScriptState(validation.fieldMap, records, fields.find((field) => field.field_name === "排序")?.field_name);

  const seenSceneIds = new Set<string>();
  let previousSourceSceneId: string | null = null;
  for (const block of state.blocks) {
    if (block.sceneId === previousSourceSceneId) continue;
    if (block.sceneId && seenSceneIds.has(block.sceneId)) {
      return Response.json({ error: "同一段落的剧本行必须连续排列" }, { status: 400 });
    }
    if (block.sceneId) seenSceneIds.add(block.sceneId);
    previousSourceSceneId = block.sceneId;
  }

  // Remap Feishu option-name IDs → fresh UIDs (scenes and characters are global tables)
  const sceneIdMap = new Map<string, string>(state.scenes.map(s => [s.id, uid()]));
  const charIdMap  = new Map<string, string>(state.characters.map(c => [c.id, uid()]));

  const productionId = uid();
  await createProduction(productionId, name.trim());

  const dbScenes = state.scenes.map((s, i) => ({
    ...s,
    id: sceneIdMap.get(s.id)!,
    sortOrder: i,
  }));

  const dbChars = state.characters.map((c, i) => ({
    ...c,
    id: charIdMap.get(c.id)!,
    sortOrder: i,
  }));

  const sceneMarkers = new Map(dbScenes.map((scene) => [scene.id, {
    id: scene.id,
    type: "chapter_marker",
    content: "",
    lyric: false,
    characterIds: [],
    characterAnnotations: {},
    sceneId: scene.id,
    rehearsalMark: null,
    markerMeta: { number: scene.number, name: scene.name },
  } satisfies Block] as const));
  const expandedBlocks: Block[] = [];
  const usedSceneIds = new Set<string>();
  let previousSceneId: string | null = null;
  let previousRehearsalMark: string | null = null;
  for (const sourceBlock of state.blocks) {
    const block = {
      ...sourceBlock,
      id: uid(),
      sceneId: sourceBlock.sceneId ? sceneIdMap.get(sourceBlock.sceneId) ?? null : null,
      characterIds: sourceBlock.characterIds
        .map((characterId) => charIdMap.get(characterId))
        .filter((characterId): characterId is string => characterId !== undefined),
    };
    const sceneChanged = block.sceneId !== previousSceneId;
    if (sceneChanged && block.sceneId) {
      expandedBlocks.push(sceneMarkers.get(block.sceneId)!);
      usedSceneIds.add(block.sceneId);
    }
    if (block.rehearsalMark && (sceneChanged || block.rehearsalMark !== previousRehearsalMark)) {
      expandedBlocks.push({
        id: uid(),
        type: "rehearsal_marker",
        content: "",
        lyric: false,
        characterIds: [],
        characterAnnotations: {},
        sceneId: null,
        rehearsalMark: null,
      });
    }
    expandedBlocks.push({ ...block, sceneId: null, rehearsalMark: null });
    previousSceneId = block.sceneId;
    previousRehearsalMark = block.rehearsalMark;
  }
  for (const scene of dbScenes) {
    if (!usedSceneIds.has(scene.id)) expandedBlocks.push(sceneMarkers.get(scene.id)!);
  }
  const lexKeys = initialKeys(expandedBlocks.length);
  const dbBlocks = withMarkerOwnership(expandedBlocks).map((block, index) => ({
    ...block,
    lexKey: lexKeys[index],
  }));

  await flushToDB(productionId, {
    upsertBlocks: dbBlocks,
    deleteBlockIds: [],
    upsertChars: dbChars,
    deleteCharIds: [],
    upsertScenes: dbScenes,
    deleteSceneIds: [],
  });

  // Save page map for all layouts so the cue page has accurate data immediately after import
  await savePageMap(
    productionId,
    Object.fromEntries(
      (Object.keys(PAGE_CONFIGS) as (keyof typeof PAGE_CONFIGS)[]).map(layout => [
        layout,
        computePageMap(dbBlocks, layout),
      ])
    ),
  );

  return Response.json({
    ok: true,
    productionId,
    stats: {
      scenes: dbScenes.length,
      characters: dbChars.length,
      blocks: dbBlocks.length,
    },
  });
}
