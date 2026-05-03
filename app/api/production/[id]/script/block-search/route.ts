import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, savePageMap } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getPool } from "@/lib/pg";
import { computePageMap } from "@/lib/script-page";

export type ScriptBlockSearchResult = {
  blockId: string;
  label: string;
  description?: string;
  url?: string;
};

type Ctx = { params: Promise<{ id: string }> };
type BlockRow = { id: string; type: string; content: string; char_names: string };

function blockDesc(r: { type: string; content: string; char_names: string }): string {
  const preview = r.content.slice(0, 40);
  return r.type === "dialogue" && r.char_names ? `${r.char_names}: ${preview}` : preview;
}

const CHAR_NAMES_SUBQ = `COALESCE((
  SELECT string_agg(ch.name, ', ' ORDER BY sc.position)
  FROM script_character sc JOIN character ch ON ch.id = sc.character_id
  WHERE sc.script_id = s.id
), '')`;

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

  const versionId = req.nextUrl.searchParams.get("v") || null;
  const pool = getPool();
  const results: ScriptBlockSearchResult[] = [];
  const dedup = (r: ScriptBlockSearchResult[]) => {
    const seen = new Set<string>();
    return r.filter(x => seen.has(x.blockId) ? false : (seen.add(x.blockId), true));
  };

  // ─── Version-aware query helpers ──────────────────────────────────────────────

  async function firstBlockInScene(sceneId: string): Promise<{ id: string } | null> {
    if (versionId) {
      const r = await pool.query<{ id: string }>(
        `SELECT sv.block_id AS id FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 ORDER BY sv.sort_key LIMIT 1`,
        [versionId, sceneId]
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
    if (versionId) {
      const r = await pool.query<{ id: string; sort_key: string }>(
        `SELECT sv.block_id AS id, sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark ILIKE $3
         ORDER BY sv.sort_key LIMIT 1`,
        [versionId, sceneId, mark]
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
    if (versionId) {
      const r = await pool.query<{ sort_key: string }>(
        `SELECT sv.sort_key FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark IS NOT NULL
           AND s.rehearsal_mark NOT ILIKE $3 AND sv.sort_key > $4
         ORDER BY sv.sort_key LIMIT 1`,
        [versionId, sceneId, mark, afterKey]
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
    if (versionId) {
      const r = await pool.query<BlockRow>(
        `SELECT sv.block_id AS id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
         FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND s.scene_id = $2 ORDER BY sv.sort_key LIMIT 15`,
        [versionId, sceneId]
      );
      return r.rows;
    }
    const r = await pool.query<BlockRow>(
      `SELECT s.id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
       FROM script s WHERE s.production_id = $1 AND s.scene_id = $2 ORDER BY s.sort_key LIMIT 15`,
      [productionId, sceneId]
    );
    return r.rows;
  }

  async function blocksInSceneRange(sceneId: string, fromKey: string, toKey: string | null): Promise<BlockRow[]> {
    if (versionId) {
      const r = toKey
        ? await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND sv.sort_key >= $3 AND sv.sort_key < $4
             ORDER BY sv.sort_key LIMIT 15`,
            [versionId, sceneId, fromKey, toKey]
          )
        : await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND sv.sort_key >= $3
             ORDER BY sv.sort_key LIMIT 15`,
            [versionId, sceneId, fromKey]
          );
      return r.rows;
    }
    const r = toKey
      ? await pool.query<BlockRow>(
          `SELECT s.id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
           FROM script s WHERE s.production_id = $1 AND s.scene_id = $2 AND s.sort_key >= $3 AND s.sort_key < $4
           ORDER BY s.sort_key LIMIT 15`,
          [productionId, sceneId, fromKey, toKey]
        )
      : await pool.query<BlockRow>(
          `SELECT s.id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
           FROM script s WHERE s.production_id = $1 AND s.scene_id = $2 AND s.sort_key >= $3
           ORDER BY s.sort_key LIMIT 15`,
          [productionId, sceneId, fromKey]
        );
    return r.rows;
  }

  // Page map is production-level (not version-specific). Block IDs in the map are logical.
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
    const ids = blocksRes.rows.map(r => r.id);
    const charRes = ids.length > 0
      ? await pool.query<{ script_id: string; character_id: string }>(
          "SELECT script_id, character_id FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position",
          [ids]
        )
      : { rows: [] };
    const charMap = new Map<string, string[]>();
    for (const r of charRes.rows) {
      if (!charMap.has(r.script_id)) charMap.set(r.script_id, []);
      charMap.get(r.script_id)!.push(r.character_id);
    }
    const blocks = blocksRes.rows.map(r => ({
      id: r.id, type: r.type === "stage" ? "stage" as const : "dialogue" as const,
      content: r.content, sceneId: r.scene_id,
      characterIds: charMap.get(r.id) ?? [], characterAnnotations: {} as Record<string, string>,
      lyric: false, rehearsalMark: null,
    }));
    const computed = computePageMap(blocks);
    savePageMap(productionId, { a4: computed }).catch(() => {});
    return computed;
  }

  // ─── Drill-down mode: query ends with '-' ─────────────────────────────────────
  if (q.endsWith("-")) {
    const base = q.slice(0, -1);

    const pageDrill = base.match(/^p\.(\d+)$/i);
    if (pageDrill) {
      const pageNum = parseInt(pageDrill[1]);
      const pageMap = await getPageMap();
      const blockIds = Object.entries(pageMap).filter(([, p]) => p === pageNum).map(([id]) => id);
      if (blockIds.length > 0) {
        // Page map IDs are logical block_ids; fetch the blocks directly
        let rows: BlockRow[];
        if (versionId) {
          const r = await pool.query<BlockRow>(
            `SELECT sv.block_id AS id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key LIMIT 15`,
            [versionId, blockIds]
          );
          rows = r.rows;
        } else {
          const r = await pool.query<BlockRow>(
            `SELECT s.id, s.type, s.content, ${CHAR_NAMES_SUBQ} AS char_names
             FROM script s WHERE s.id = ANY($1::text[]) AND s.production_id = $2 ORDER BY s.sort_key LIMIT 15`,
            [blockIds, productionId]
          );
          rows = r.rows;
        }
        return Response.json({ results: rows.map((r, i) => ({
          blockId: r.id, label: `p.${pageNum}-${i + 1}`, description: blockDesc(r),
        })) });
      }
      return Response.json({ results: [] });
    }

    const spmDrill = base.match(/^(\d[\d.\-]*)([A-Za-z]+)$/);
    if (spmDrill) {
      const [, sceneQuery, mark] = spmDrill;
      const sceneRes = await pool.query<{ id: string; num: string }>(
        `SELECT id, num FROM scene WHERE production_id = $1 AND num ILIKE $2 ORDER BY sort_order LIMIT 1`,
        [productionId, `${sceneQuery}%`]
      );
      if (sceneRes.rows[0]) {
        const scene = sceneRes.rows[0];
        const mfb = await markFirstBlock(scene.id, mark);
        if (mfb) {
          const endKey = await nextMarkSortKey(scene.id, mark, mfb.sortKey);
          const rows = await blocksInSceneRange(scene.id, mfb.sortKey, endKey);
          const prefix = `${scene.num}${mark.toUpperCase()}`;
          return Response.json({ results: rows.map((r, i) => ({
            blockId: r.id, label: `${prefix}-${i + 1}`, description: blockDesc(r),
          })) });
        }
      }
      return Response.json({ results: [] });
    }

    const sceneDrill = base.match(/^[\d.\-]+$/);
    if (sceneDrill) {
      const childRes = await pool.query<{ id: string; num: string; name: string }>(
        `SELECT id, num, name FROM scene WHERE production_id = $1 AND num ILIKE $2 ORDER BY sort_order LIMIT 8`,
        [productionId, `${base}-%`]
      );
      if (childRes.rows.length > 0) {
        for (const scene of childRes.rows) {
          const fb = await firstBlockInScene(scene.id);
          if (fb) results.push({ blockId: fb.id, label: scene.num, description: scene.name || undefined });
        }
        return Response.json({ results: dedup(results) });
      }

      const exactSceneRes = await pool.query<{ id: string }>(
        "SELECT id FROM scene WHERE production_id = $1 AND num = $2 LIMIT 1",
        [productionId, base]
      );
      if (exactSceneRes.rows[0]) {
        const rows = await blocksInScene(exactSceneRes.rows[0].id);
        return Response.json({ results: rows.map((r, i) => ({
          blockId: r.id, label: `${base}-${i + 1}`, description: blockDesc(r),
        })) });
      }
      return Response.json({ results: [] });
    }
  }

  // ─── Page reference: p.N ─────────────────────────────────────────────────────
  const pageMatch = q.match(/^p\.(\d+)$/i);
  if (pageMatch) {
    const pageNum = parseInt(pageMatch[1]);
    const pageMap = await getPageMap();
    const blockIds = Object.entries(pageMap).filter(([, p]) => p === pageNum).map(([id]) => id);
    if (blockIds.length > 0) {
      const fb = versionId
        ? (await pool.query<{ id: string }>(
            `SELECT sv.block_id AS id FROM script_version sv WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[]) ORDER BY sv.sort_key LIMIT 1`,
            [versionId, blockIds]
          )).rows[0]
        : (await pool.query<{ id: string }>(
            "SELECT id FROM script WHERE id = ANY($1) AND production_id = $2 ORDER BY sort_key LIMIT 1",
            [blockIds, productionId]
          )).rows[0];
      if (fb) results.push({ blockId: fb.id, label: `p.${pageNum}`, description: `第${pageNum}页` });
    }
    return Response.json({ results });
  }

  // ─── Scene+mark: digits + letters, e.g. "1-1A" ───────────────────────────────
  const scenePlusMark = q.match(/^(\d[\d.\-]*)([A-Za-z]+)$/);
  if (scenePlusMark) {
    const [, sceneQuery, mark] = scenePlusMark;
    const sceneRes = await pool.query<{ id: string; num: string; name: string }>(
      `SELECT id, num, name FROM scene WHERE production_id = $1 AND num ILIKE $2 ORDER BY sort_order LIMIT 4`,
      [productionId, `${sceneQuery}%`]
    );
    for (const scene of sceneRes.rows) {
      const mfb = await markFirstBlock(scene.id, mark);
      if (mfb) {
        results.push({
          blockId: mfb.id,
          label: `${scene.num}${mark.toUpperCase()}`,
          description: scene.name || undefined,
        });
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Scene only: digits/dashes, e.g. "1-1" ───────────────────────────────────
  const sceneOnly = q.match(/^[\d.\-]+$/);
  if (sceneOnly) {
    const sceneRes = await pool.query<{ id: string; num: string; name: string }>(
      `SELECT id, num, name FROM scene WHERE production_id = $1 AND (num ILIKE $2 OR name ILIKE $2) ORDER BY sort_order LIMIT 5`,
      [productionId, `${q}%`]
    );
    for (const scene of sceneRes.rows) {
      const fb = await firstBlockInScene(scene.id);
      if (fb) results.push({ blockId: fb.id, label: scene.num, description: scene.name || undefined });

      const marksRes = versionId
        ? await pool.query<{ id: string; rehearsal_mark: string }>(
            `SELECT DISTINCT ON (s.rehearsal_mark) sv.block_id AS id, s.rehearsal_mark
             FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
             WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark IS NOT NULL
             ORDER BY s.rehearsal_mark, sv.sort_key LIMIT 5`,
            [versionId, scene.id]
          )
        : await pool.query<{ id: string; rehearsal_mark: string }>(
            `SELECT DISTINCT ON (rehearsal_mark) id, rehearsal_mark FROM script
             WHERE production_id = $1 AND scene_id = $2 AND rehearsal_mark IS NOT NULL
             ORDER BY rehearsal_mark, sort_key LIMIT 5`,
            [productionId, scene.id]
          );
      for (const m of marksRes.rows) {
        results.push({ blockId: m.id, label: `${scene.num}${m.rehearsal_mark}`, description: scene.name || undefined });
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Cue: ABBR.number, e.g. "SQ.5" ──────────────────────────────────────────
  const cueNumMatch = q.match(/^([A-Za-z]+)\.(.*)$/);
  if (cueNumMatch) {
    const [, abbr, numPrefix] = cueNumMatch;
    const cueRes = await pool.query<{ id: string; number: string; name: string; cue_list_id: string; abbr: string }>(
      `SELECT c.id, c.number, c.name, cl.id AS cue_list_id, cl.abbr
       FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE cl.production_id = $1 AND cl.abbr ILIKE $2 AND ($3 = '' OR c.number ILIKE $4)
       ${versionId ? "AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $5)" : ""}
       ORDER BY length(c.number), c.number LIMIT 8`,
      versionId
        ? [productionId, abbr, numPrefix, `${numPrefix}%`, versionId]
        : [productionId, abbr, numPrefix, `${numPrefix}%`]
    );
    for (const r of cueRes.rows) {
      results.push({
        blockId: r.id, label: `${r.abbr}.${r.number}`, description: r.name || undefined,
        url: `/production/${productionId}/cues?cueList=${r.cue_list_id}&cueId=${r.id}`,
      });
    }
    return Response.json({ results: dedup(results) });
  }

  // ─── Cue sheet abbreviation: letters only, e.g. "SQ" ─────────────────────────
  const abbrMatch = q.match(/^[A-Za-z]+$/);
  if (abbrMatch) {
    const clRes = await pool.query<{ id: string; name: string; abbr: string }>(
      `SELECT id, name, abbr FROM cue_list WHERE production_id = $1 AND abbr ILIKE $2 ORDER BY abbr LIMIT 5`,
      [productionId, `${q}%`]
    );
    for (const r of clRes.rows) {
      results.push({
        blockId: r.id, label: r.abbr!, description: r.name || undefined,
        url: `/production/${productionId}/cues?cueList=${r.id}`,
      });
    }
    return Response.json({ results: dedup(results) });
  }

  // ─── Text search: scene name ──────────────────────────────────────────────────
  const sceneTextRes = await pool.query<{ id: string; num: string; name: string }>(
    `SELECT id, num, name FROM scene WHERE production_id = $1 AND (name ILIKE $2 OR num ILIKE $2) ORDER BY sort_order LIMIT 6`,
    [productionId, `%${q}%`]
  );
  for (const scene of sceneTextRes.rows) {
    const fb = await firstBlockInScene(scene.id);
    if (fb) results.push({ blockId: fb.id, label: scene.num, description: scene.name || undefined });
  }
  return Response.json({ results: dedup(results).slice(0, 8) });
}
