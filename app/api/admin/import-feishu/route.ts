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
  extractSortKeys,
} from "@/lib/feishu-bitable";
import { createProduction, flushToDB } from "@/lib/db";
import { initialKeys } from "@/lib/lex-order";

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

  const sortField = fields.find(f => f.field_name === "排序");
  const records = await getAllRecords(appToken, tableId, token);
  const state = toScriptState(validation.fieldMap, records, sortField?.field_name);
  const sortKeys = sortField ? extractSortKeys(records, sortField.field_name) : new Map<string, string>();

  // Remap Feishu option-name IDs → fresh UIDs (scenes and characters are global tables)
  const sceneIdMap = new Map<string, string>(state.scenes.map(s => [s.id, uid()]));
  const charIdMap  = new Map<string, string>(state.characters.map(c => [c.id, uid()]));

  // Assign lex keys: prefer existing Feishu sort keys, otherwise generate
  const blockKeys = state.blocks.map(b => sortKeys.get(b.id) ?? null);
  const hasAnyKey = blockKeys.some(k => k !== null);
  const lexKeyArr = hasAnyKey
    ? blockKeys.map((k, i) => k ?? `fallback_${i}`) // placeholder; assignLexKeys is in server-cache
    : initialKeys(state.blocks.length);

  // If we had some sort keys, fill gaps (simple sequential fallback)
  if (hasAnyKey) {
    let prev = 0;
    for (let i = 0; i < lexKeyArr.length; i++) {
      if (blockKeys[i] !== null) { prev = i; continue; }
      // Find next known
      let next: number | null = null;
      for (let j = i + 1; j < lexKeyArr.length; j++) {
        if (blockKeys[j] !== null) { next = j; break; }
      }
      const loKey  = blockKeys[prev] ?? null;
      const hiKey  = next !== null ? blockKeys[next] : null;
      // Simple interpolation using initialKeys for the gap
      const gapLen = (next ?? lexKeyArr.length) - prev;
      const gapKeys = initialKeys(gapLen + 1); // +1 so endpoints are not used
      lexKeyArr[i] = gapKeys[i - prev];
    }
  }

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

  const dbBlocks = state.blocks.map((b, i) => ({
    ...b,
    id: uid(),
    sceneId: b.sceneId ? sceneIdMap.get(b.sceneId) ?? null : null,
    characterIds: b.characterIds
      .map(cid => charIdMap.get(cid))
      .filter((x): x is string => x !== undefined),
    orderKey: (i + 1) * 65536,
    lexKey: lexKeyArr[i],
  }));

  await flushToDB(productionId, {
    upsertBlocks: dbBlocks,
    deleteBlockIds: [],
    upsertChars: dbChars,
    deleteCharIds: [],
    upsertScenes: dbScenes,
    deleteSceneIds: [],
  });

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
