import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, savePageMap, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getPool } from "@/lib/pg";
import { computePageMap } from "@/lib/script-page";
import type { MentionSearchResult } from "@/lib/mention-types";

export type { MentionSearchResult as ScriptBlockSearchResult };

type Ctx = { params: Promise<{ id: string }> };
type BlockRow = { id: string; type: string; content: string };
type SceneRow = { id: string; num: string; name: string };

function blockDesc(r: { content: string }): string {
  return r.content.slice(0, 60);
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!q) return Response.json({ results: [] });

  const paramVersionId = req.nextUrl.searchParams.get("v") || null;
  const effectiveVersionId = paramVersionId ?? await getActiveVersionId(productionId);

  const pool = getPool();
  const results: MentionSearchResult[] = [];
  const dedup = (r: MentionSearchResult[]) => {
    const seen = new Set<string>();
    return r.filter(x => {
      const key = `${x.kind}:${x.id}:${x.aux ?? ""}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };

  // ── Version prefix: "版本名:mention" or "版本名：mention" ─────────────────────
  let resolvedVersionId = effectiveVersionId;
  let mentionQuery = q;
  let explicitVersionId: string | null = null;

  const colonIdx = q.search(/[：:]/);
  if (colonIdx > 0) {
    const versionName = q.slice(0, colonIdx);
    const rest = q.slice(colonIdx + 1);
    if (rest.trim()) {
      const verRes = await pool.query<{ id: string }>(
        `SELECT id FROM version WHERE production_id = $1 AND name = $2 LIMIT 1`,
        [productionId, versionName]
      );
      if (verRes.rows[0]) {
        explicitVersionId = verRes.rows[0].id;
        resolvedVersionId = explicitVersionId;
        mentionQuery = rest.trim();
      }
    }
  }

  // ── Version-aware query helpers ────────────────────────────────────────────

  async function firstBlockInScene(sceneId: string): Promise<{ id: string } | null> {
    if (resolvedVersionId) {
      const r = await pool.query<{ id: string }>(
        `SELECT sv.block_id AS id FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 ORDER BY sv.sort_key LIMIT 1`,
        [resolvedVersionId, sceneId]
      );
      return r.rows[0] ?? null;
    }
    const r = await pool.query<{ id: string }>(
      "SELECT id FROM script WHERE production_id = $1 AND scene_id = $2 ORDER BY sort_key LIMIT 1",
      [productionId, sceneId]
    );
    return r.rows[0] ?? null;
  }

  async function markFirstBlock(sceneId: string, mark: string): Promise<{ id: string; sortKey: string } | null> {
    if (resolvedVersionId) {
      const r = await pool.query<{ id: string; sort_key: string }>(
        `SELECT sv.block_id AS id, sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark ILIKE $3
         ORDER BY sv.sort_key LIMIT 1`,
        [resolvedVersionId, sceneId, mark]
      );
      return r.rows[0] ? { id: r.rows[0].id, sortKey: r.rows[0].sort_key } : null;
    }
    const r = await pool.query<{ id: string; sort_key: string }>(
      `SELECT id, sort_key FROM script WHERE production_id = $1 AND scene_id = $2 AND rehearsal_mark ILIKE $3 ORDER BY sort_key LIMIT 1`,
      [productionId, sceneId, mark]
    );
    return r.rows[0] ? { id: r.rows[0].id, sortKey: r.rows[0].sort_key } : null;
  }

  async function nextMarkSortKey(sceneId: string, mark: string, afterKey: string): Promise<string | null> {
    if (resolvedVersionId) {
      const r = await pool.query<{ sort_key: string }>(
        `SELECT sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark IS NOT NULL
           AND s.rehearsal_mark NOT ILIKE $3 AND sv.sort_key > $4
         ORDER BY sv.sort_key LIMIT 1`,
        [resolvedVersionId, sceneId, mark, afterKey]
      );
      return r.rows[0]?.sort_key ?? null;
    }
    const r = await pool.query<{ sort_key: string }>(
      `SELECT sort_key FROM script WHERE production_id = $1 AND scene_id = $2
         AND rehearsal_mark IS NOT NULL AND rehearsal_mark NOT ILIKE $3 AND sort_key > $4
       ORDER BY sort_key LIMIT 1`,
      [productionId, sceneId, mark, afterKey]
    );
    return r.rows[0]?.sort_key ?? null;
  }

  async function blocksInScene(sceneId: string): Promise<BlockRow[]> {
    if (resolvedVersionId) {
      const r = await pool.query<BlockRow>(
        `SELECT sv.block_id AS id, s.type, s.content
         FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 ORDER BY sv.sort_key LIMIT 15`,
        [resolvedVersionId, sceneId]
      );
      return r.rows;
    }
    const r = await pool.query<BlockRow>(
      `SELECT s.id, s.type, s.content FROM script s
       WHERE s.production_id = $1 AND s.scene_id = $2 ORDER BY s.sort_key LIMIT 15`,
      [productionId, sceneId]
    );
    return r.rows;
  }

  async function blocksInSceneRange(sceneId: string, fromKey: string, toKey: string | null): Promise<BlockRow[]> {
    if (resolvedVersionId) {
      const r = toKey
        ? await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND sv.sort_key >= $3 AND sv.sort_key < $4
             ORDER BY sv.sort_key LIMIT 15`,
            [resolvedVersionId, sceneId, fromKey, toKey]
          )
        : await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND sv.sort_key >= $3
             ORDER BY sv.sort_key LIMIT 15`,
            [resolvedVersionId, sceneId, fromKey]
          );
      return r.rows;
    }
    const r = toKey
      ? await pool.query<BlockRow>(
          `SELECT s.id, s.type, s.content FROM script s
           WHERE s.production_id = $1 AND s.scene_id = $2 AND s.sort_key >= $3 AND s.sort_key < $4
           ORDER BY s.sort_key LIMIT 15`,
          [productionId, sceneId, fromKey, toKey]
        )
      : await pool.query<BlockRow>(
          `SELECT s.id, s.type, s.content FROM script s
           WHERE s.production_id = $1 AND s.scene_id = $2 AND s.sort_key >= $3
           ORDER BY s.sort_key LIMIT 15`,
          [productionId, sceneId, fromKey]
        );
    return r.rows;
  }

  async function queryScenes(numPattern: string, limit: number): Promise<SceneRow[]> {
    if (resolvedVersionId) {
      const r = await pool.query<SceneRow>(
        `SELECT s.id, sv.num, sv.name
         FROM scene s JOIN scene_version sv ON sv.scene_id = s.id AND sv.version_id = $1
         WHERE s.production_id = $2 AND sv.num ILIKE $3
         ORDER BY sv.sort_order LIMIT $4`,
        [resolvedVersionId, productionId, numPattern, limit]
      );
      return r.rows;
    }
    return [];
  }

  async function queryScenesText(textPattern: string, limit: number): Promise<SceneRow[]> {
    if (resolvedVersionId) {
      const r = await pool.query<SceneRow>(
        `SELECT s.id, sv.num, sv.name
         FROM scene s JOIN scene_version sv ON sv.scene_id = s.id AND sv.version_id = $1
         WHERE s.production_id = $2 AND (sv.num ILIKE $3 OR sv.name ILIKE $3)
         ORDER BY sv.sort_order LIMIT $4`,
        [resolvedVersionId, productionId, textPattern, limit]
      );
      return r.rows;
    }
    return [];
  }

  async function getPageMap(): Promise<Record<string, number>> {
    const pmRes = await pool.query<{ page_map: Record<string, Record<string, number>> | null }>(
      "SELECT page_map FROM production WHERE id = $1", [productionId]
    );
    const stored = pmRes.rows[0]?.page_map?.["a4"];
    if (stored && Object.keys(stored).length > 0) return stored;

    const blocksRes = await pool.query<{ id: string; type: string; content: string; scene_id: string | null }>(
      "SELECT id, type, content, scene_id FROM script WHERE production_id = $1 ORDER BY sort_key",
      [productionId]
    );
    const blocks = blocksRes.rows.map(r => ({
      id: r.id, type: r.type === "stage" ? "stage" as const : "dialogue" as const,
      content: r.content, sceneId: r.scene_id,
      characterIds: [], characterAnnotations: {} as Record<string, string>,
      lyric: false, rehearsalMark: null,
    }));
    const computed = computePageMap(blocks);
    savePageMap(productionId, { a4: computed }).catch(() => {});
    return computed;
  }

  function withVer(r: Omit<MentionSearchResult, "versionId">): MentionSearchResult {
    return explicitVersionId ? { ...r, versionId: explicitVersionId } : r;
  }

  // ── Asset: asset.{mount_query}-{name_prefix} ──────────────────────────────

  async function queryAssetsByMount(
    mountTypes: string[], mountId: string, namePrefix: string, mountLabel: string
  ): Promise<MentionSearchResult[]> {
    const params: unknown[] = [productionId, mountTypes, mountId];
    const nameCond = namePrefix ? `AND a.name ILIKE $${params.push(`${namePrefix}%`)}` : "";
    const r = await pool.query<{ id: string; name: string | null; asset_type: string }>(
      `SELECT a.id, a.name, a.asset_type FROM asset a
       JOIN asset_mount am ON am.asset_id = a.id
       WHERE am.production_id = $1 AND am.mount_type = ANY($2::text[]) AND am.mount_id = $3 ${nameCond}
       ORDER BY a.name LIMIT 8`,
      params
    );
    return r.rows.map(row => withVer({
      kind: "asset", id: row.id,
      aux: `${mountTypes[0]}:${mountId}`,
      displayLabel: `#asset.${mountLabel}-${row.name ?? "?"}`,
      description: row.asset_type,
    }));
  }

  async function searchAssets(mountQuery: string, namePrefix: string): Promise<MentionSearchResult[]> {
    // Production: "production.folder/path"
    if (mountQuery.startsWith("production.") || mountQuery === "production") {
      const folderPath = mountQuery.startsWith("production.") ? mountQuery.slice("production.".length) : "";
      const params: unknown[] = [productionId];
      const folderCond = folderPath ? `AND am.folder_path ILIKE $${params.push(`${folderPath}%`)}` : "";
      const nameCond = namePrefix ? `AND a.name ILIKE $${params.push(`${namePrefix}%`)}` : "";
      const r = await pool.query<{ id: string; name: string | null; folder_path: string | null; asset_type: string }>(
        `SELECT a.id, a.name, am.folder_path, a.asset_type FROM asset a
         JOIN asset_mount am ON am.asset_id = a.id
         WHERE am.production_id = $1 AND am.mount_type = 'production' ${folderCond} ${nameCond}
         ORDER BY a.name LIMIT 8`,
        params
      );
      return r.rows.map(row => withVer({
        kind: "asset", id: row.id,
        aux: `production:${row.folder_path ?? ""}`,
        displayLabel: `#asset.production.${row.folder_path ?? ""}-${row.name ?? "?"}`,
        description: row.asset_type,
      }));
    }

    // Page mention (p.N) — pages have no asset mount type
    if (/^p\.\d+$/.test(mountQuery)) return [];

    // Block via page drill: p.N-M
    const blockPageM = mountQuery.match(/^p\.(\d+)-(\d+)$/i);
    if (blockPageM) {
      const pageNum = parseInt(blockPageM[1]);
      const blockIdx = parseInt(blockPageM[2]) - 1;
      const pageMap = await getPageMap();
      const pageBlockIds = Object.entries(pageMap).filter(([, p]) => p === pageNum).map(([id]) => id);
      let blockId: string | undefined;
      if (resolvedVersionId) {
        const r = await pool.query<{ id: string }>(
          `SELECT sv.block_id AS id FROM script_version sv
           WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key`,
          [resolvedVersionId, pageBlockIds]
        );
        blockId = r.rows[blockIdx]?.id;
      } else {
        blockId = pageBlockIds[blockIdx];
      }
      if (!blockId) return [];
      return queryAssetsByMount(["block", "block_snapshot"], blockId, namePrefix, mountQuery);
    }

    // Cue: ABBR.num (uppercase abbrev)
    const cueM = mountQuery.match(/^([A-Z][A-Z0-9]*)\.(.+)$/);
    if (cueM) {
      const [, abbr, cueNum] = cueM;
      const r = await pool.query<{ id: string; abbr: string; number: string }>(
        `SELECT c.id, cl.abbr, c.number FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE cl.production_id = $1 AND cl.abbr = $2 AND c.number = $3 LIMIT 1`,
        [productionId, abbr, cueNum]
      );
      if (!r.rows[0]) return [];
      return queryAssetsByMount(["cue", "cue_revision"], r.rows[0].id, namePrefix, `${abbr}.${cueNum}`);
    }

    // Scene+mark+block: 1-1A-3
    const markBlockM = mountQuery.match(/^(\d[\d.\-]*)([A-Za-z]+)-(\d+)$/);
    if (markBlockM) {
      const [, sceneNum, mark, posStr] = markBlockM;
      const idx = parseInt(posStr) - 1;
      const scenes = await queryScenes(`${sceneNum}`, 1);
      if (!scenes[0]) return [];
      const mfb = await markFirstBlock(scenes[0].id, mark);
      if (!mfb) return [];
      const endKey = await nextMarkSortKey(scenes[0].id, mark, mfb.sortKey);
      const blocks = await blocksInSceneRange(scenes[0].id, mfb.sortKey, endKey);
      const blockId = blocks[idx]?.id;
      if (!blockId) return [];
      return queryAssetsByMount(["block", "block_snapshot"], blockId, namePrefix, mountQuery);
    }

    // Scene+block: 1-1-3
    const sceneBlockM = mountQuery.match(/^(\d[\d.\-]*)-(\d+)$/);
    if (sceneBlockM) {
      const [, sceneNum, posStr] = sceneBlockM;
      const idx = parseInt(posStr) - 1;
      const scenes = await queryScenes(sceneNum, 1);
      if (!scenes[0]) return [];
      const blocks = await blocksInScene(scenes[0].id);
      const blockId = blocks[idx]?.id;
      if (!blockId) return [];
      return queryAssetsByMount(["block", "block_snapshot"], blockId, namePrefix, mountQuery);
    }

    // Scene+mark: 1-1A (mounts on the scene itself, no separate rehearsal mount type)
    const markM = mountQuery.match(/^(\d[\d.\-]*)([A-Za-z]+)$/);
    if (markM) {
      const [, sceneNum, mark] = markM;
      const scenes = await queryScenes(`${sceneNum}`, 1);
      if (!scenes[0]) return [];
      return queryAssetsByMount(["scene", "scene_snapshot"], scenes[0].id, namePrefix,
        `${scenes[0].num}${mark.toUpperCase()}`);
    }

    // Scene: 1-1
    if (/^\d[\d.\-]*$/.test(mountQuery)) {
      const scenes = await queryScenesText(`${mountQuery}%`, 1);
      if (!scenes[0]) return [];
      return queryAssetsByMount(["scene", "scene_snapshot"], scenes[0].id, namePrefix, scenes[0].num);
    }

    return [];
  }

  // ─── Asset prefix query ────────────────────────────────────────────────────

  const assetPrefixM = mentionQuery.match(/^asset\.(.*)/i);
  if (assetPrefixM) {
    const rest = assetPrefixM[1];
    const lastHyphen = rest.lastIndexOf("-");
    let mountQuery: string;
    let namePrefix: string;
    if (lastHyphen === -1 || /^\d+$/.test(rest.slice(lastHyphen + 1))) {
      // No hyphen, or suffix is all-digits (= block position number, part of mount spec)
      mountQuery = rest;
      namePrefix = "";
    } else {
      mountQuery = rest.slice(0, lastHyphen);
      namePrefix = rest.slice(lastHyphen + 1);
    }
    return Response.json({ results: await searchAssets(mountQuery, namePrefix) });
  }

  // ─── Drill-down mode: query ends with '-' ─────────────────────────────────

  if (mentionQuery.endsWith("-")) {
    const base = mentionQuery.slice(0, -1);

    const pageDrill = base.match(/^p\.(\d+)$/i);
    if (pageDrill) {
      const pageNum = parseInt(pageDrill[1]);
      const pageMap = await getPageMap();
      const blockIds = Object.entries(pageMap).filter(([, p]) => p === pageNum).map(([id]) => id);
      if (blockIds.length > 0) {
        let rows: BlockRow[];
        if (resolvedVersionId) {
          const r = await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key LIMIT 15`,
            [resolvedVersionId, blockIds]
          );
          rows = r.rows;
        } else {
          const r = await pool.query<BlockRow>(
            `SELECT s.id, s.type, s.content FROM script s
             WHERE s.id = ANY($1::text[]) AND s.production_id = $2 ORDER BY s.sort_key LIMIT 15`,
            [blockIds, productionId]
          );
          rows = r.rows;
        }
        return Response.json({ results: rows.map((r, i) => withVer({
          kind: "block", displayMode: "page",
          id: r.id, displayLabel: `#p.${pageNum}-${i + 1}`, description: blockDesc(r),
        })) });
      }
      return Response.json({ results: [] });
    }

    const spmDrill = base.match(/^(\d[\d.\-]*)([A-Za-z]+)$/);
    if (spmDrill) {
      const [, sceneQuery, mark] = spmDrill;
      const sceneRows = await queryScenes(`${sceneQuery}%`, 1);
      if (sceneRows[0]) {
        const scene = sceneRows[0];
        const mfb = await markFirstBlock(scene.id, mark);
        if (mfb) {
          const endKey = await nextMarkSortKey(scene.id, mark, mfb.sortKey);
          const rows = await blocksInSceneRange(scene.id, mfb.sortKey, endKey);
          const prefix = `${scene.num}${mark.toUpperCase()}`;
          return Response.json({ results: rows.map((r, i) => withVer({
            kind: "block", displayMode: "rehearsal",
            id: r.id, displayLabel: `#${prefix}-${i + 1}`, description: blockDesc(r),
          })) });
        }
      }
      return Response.json({ results: [] });
    }

    const sceneDrill = base.match(/^[\d.\-]+$/);
    if (sceneDrill) {
      const childScenes = await queryScenes(`${base}-%`, 8);
      if (childScenes.length > 0) {
        for (const scene of childScenes) {
          const fb = await firstBlockInScene(scene.id);
          if (fb) results.push(withVer({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined }));
        }
        return Response.json({ results: dedup(results) });
      }
      const exactScenes = await queryScenes(base, 1);
      if (exactScenes[0]) {
        const rows = await blocksInScene(exactScenes[0].id);
        const sceneNum = exactScenes[0].num;
        return Response.json({ results: rows.map((r, i) => withVer({
          kind: "block", displayMode: "scene",
          id: r.id, displayLabel: `#${sceneNum}-${i + 1}`, description: blockDesc(r),
        })) });
      }
      return Response.json({ results: [] });
    }
  }

  // ─── Page reference: p.N ──────────────────────────────────────────────────

  const pageMatch = mentionQuery.match(/^p\.(\d+)$/i);
  if (pageMatch) {
    const pageNum = parseInt(pageMatch[1]);
    results.push(withVer({ kind: "page", id: String(pageNum), displayLabel: `#p.${pageNum}`, description: `第${pageNum}页` }));
    return Response.json({ results });
  }

  // ─── Scene+mark: digits + letters, e.g. "1-1A" ───────────────────────────

  const scenePlusMark = mentionQuery.match(/^(\d[\d.\-]*)([A-Za-z]+)$/);
  if (scenePlusMark) {
    const [, sceneQuery, mark] = scenePlusMark;
    const sceneRows = await queryScenes(`${sceneQuery}%`, 4);
    for (const scene of sceneRows) {
      const mfb = await markFirstBlock(scene.id, mark);
      if (mfb) {
        results.push(withVer({
          kind: "rehearsal", id: scene.id, aux: mark.toUpperCase(),
          displayLabel: `#${scene.num}${mark.toUpperCase()}`, description: scene.name || undefined,
        }));
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Scene only: digits/dashes, e.g. "1-1" ───────────────────────────────

  const sceneOnly = mentionQuery.match(/^[\d.\-]+$/);
  if (sceneOnly) {
    const sceneRows = await queryScenesText(`${mentionQuery}%`, 5);
    for (const scene of sceneRows) {
      results.push(withVer({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined }));

      const marksRes = resolvedVersionId
        ? await pool.query<{ rehearsal_mark: string }>(
            `SELECT DISTINCT s.rehearsal_mark FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark IS NOT NULL
             ORDER BY s.rehearsal_mark LIMIT 5`,
            [resolvedVersionId, scene.id]
          )
        : await pool.query<{ rehearsal_mark: string }>(
            `SELECT DISTINCT rehearsal_mark FROM script
             WHERE production_id = $1 AND scene_id = $2 AND rehearsal_mark IS NOT NULL
             ORDER BY rehearsal_mark LIMIT 5`,
            [productionId, scene.id]
          );
      for (const m of marksRes.rows) {
        results.push(withVer({
          kind: "rehearsal", id: scene.id, aux: m.rehearsal_mark,
          displayLabel: `#${scene.num}${m.rehearsal_mark}`, description: scene.name || undefined,
        }));
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Cue: ABBR.number, e.g. "SQ.5" ──────────────────────────────────────

  const cueNumMatch = mentionQuery.match(/^([A-Z][A-Z0-9]*)\.(.*)$/);
  if (cueNumMatch) {
    const [, abbr, numPrefix] = cueNumMatch;
    const cueRes = await pool.query<{ id: string; number: string; name: string; abbr: string }>(
      `SELECT c.id, c.number, c.name, cl.abbr
       FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE cl.production_id = $1 AND cl.abbr = $2 AND ($3 = '' OR c.number ILIKE $4)
       ${resolvedVersionId ? "AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $5)" : ""}
       ORDER BY length(c.number), c.number LIMIT 8`,
      resolvedVersionId
        ? [productionId, abbr, numPrefix, `${numPrefix}%`, resolvedVersionId]
        : [productionId, abbr, numPrefix, `${numPrefix}%`]
    );
    for (const r of cueRes.rows) {
      results.push(withVer({ kind: "cue", id: r.id, displayLabel: `#${r.abbr}.${r.number}`, description: r.name || undefined }));
    }
    return Response.json({ results: dedup(results) });
  }

  // ─── Text search: scene name ──────────────────────────────────────────────

  const sceneTextRes = await queryScenesText(`%${mentionQuery}%`, 6);
  for (const scene of sceneTextRes) {
    results.push(withVer({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined }));
  }
  return Response.json({ results: dedup(results).slice(0, 8) });
}
