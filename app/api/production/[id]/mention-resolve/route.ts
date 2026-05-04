import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getPool } from "@/lib/pg";
import type { ContentMentionAttrs, BlockDisplayMode } from "@/lib/mention-types";

type Ctx = { params: Promise<{ id: string }> };

type ResolveInput = {
  mentions: ContentMentionAttrs[];
  versionId?: string | null;
};

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as ResolveInput;
  const { mentions, versionId: contextVersionId } = body;
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return Response.json({ labels: [], urls: [] });
  }

  const pool = getPool();
  const effectiveVersionId = contextVersionId ?? await getActiveVersionId(productionId);
  const vParam = effectiveVersionId ? `?v=${effectiveVersionId}` : "";
  const vAmp = effectiveVersionId ? `&v=${effectiveVersionId}` : "";
  const base = `/production/${productionId}`;

  const labels: (string | null)[] = new Array(mentions.length).fill(null);
  const urls: (string | null)[] = new Array(mentions.length).fill(null);

  // Group by kind for batch queries
  const byKind = new Map<string, number[]>();
  for (let i = 0; i < mentions.length; i++) {
    const key = mentions[i].kind;
    if (!byKind.has(key)) byKind.set(key, []);
    byKind.get(key)!.push(i);
  }

  // ── page ──────────────────────────────────────────────────────────────────
  if (byKind.has("page")) {
    for (const i of byKind.get("page")!) {
      labels[i] = `#p.${mentions[i].id}`;
      urls[i] = `${base}/script${vParam}`;
    }
  }

  // ── scene + rehearsal (both need scene_version) ───────────────────────────
  const sceneIdxs = [...(byKind.get("scene") ?? []), ...(byKind.get("rehearsal") ?? [])];
  if (sceneIdxs.length > 0 && effectiveVersionId) {
    const sceneIds = sceneIdxs.map(i => mentions[i].id);
    const r = await pool.query<{ scene_id: string; num: string }>(
      `SELECT scene_id, num FROM scene_version WHERE version_id = $1 AND scene_id = ANY($2::text[])`,
      [effectiveVersionId, sceneIds]
    );
    const numByScene = new Map(r.rows.map(row => [row.scene_id, row.num]));
    for (const i of sceneIdxs) {
      const m = mentions[i];
      const num = numByScene.get(m.id);
      if (!num) { labels[i] = "#[已删除]"; continue; }
      labels[i] = m.kind === "rehearsal" && m.aux
        ? `#${num}${m.aux}`
        : `#${num}`;
      urls[i] = `${base}/script${vParam}`;
    }
  } else if (sceneIdxs.length > 0) {
    for (const i of sceneIdxs) {
      labels[i] = "#[未知版本]";
      urls[i] = `${base}/script${vParam}`;
    }
  }

  // ── block ─────────────────────────────────────────────────────────────────
  if (byKind.has("block")) {
    const blockIdxs = byKind.get("block")!;
    const blockIds = blockIdxs.map(i => mentions[i].id);

    // Group by displayMode
    const byMode = new Map<BlockDisplayMode, number[]>();
    for (const i of blockIdxs) {
      const mode = mentions[i].displayMode ?? "scene";
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode)!.push(i);
    }

    // scene mode: find scene num and position within scene
    if (byMode.has("scene") && effectiveVersionId) {
      const idxs = byMode.get("scene")!;
      const ids = idxs.map(i => mentions[i].id);
      const r = await pool.query<{ block_id: string; scene_id: string; row_num: string }>(
        `SELECT sv.block_id, s.scene_id,
                ROW_NUMBER() OVER (PARTITION BY s.scene_id ORDER BY sv.sort_key) AS row_num
         FROM script_version sv
         JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[])`,
        [effectiveVersionId, ids]
      );
      const posMap = new Map(r.rows.map(row => [row.block_id, { sceneId: row.scene_id, pos: parseInt(row.row_num) }]));

      // Fetch scene nums
      const sceneIds = [...new Set(r.rows.map(row => row.scene_id))];
      let sceneNumMap = new Map<string, string>();
      if (sceneIds.length > 0 && effectiveVersionId) {
        const sr = await pool.query<{ scene_id: string; num: string }>(
          `SELECT scene_id, num FROM scene_version WHERE version_id = $1 AND scene_id = ANY($2::text[])`,
          [effectiveVersionId, sceneIds]
        );
        sceneNumMap = new Map(sr.rows.map(row => [row.scene_id, row.num]));
      }

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = posMap.get(blockId);
        if (!info) { labels[i] = "#[已删除]"; continue; }
        const num = sceneNumMap.get(info.sceneId);
        labels[i] = num ? `#${num}-${info.pos}` : "#[已删除]";
        urls[i] = `${base}/script${vParam}#block-${blockId}`;
      }
    }

    // page mode: compute from page_map
    if (byMode.has("page")) {
      const idxs = byMode.get("page")!;
      const pmRes = await pool.query<{ page_map: Record<string, Record<string, number>> | null }>(
        "SELECT page_map FROM production WHERE id = $1", [productionId]
      );
      const pageMap: Record<string, number> = pmRes.rows[0]?.page_map?.["a4"] ?? {};
      // Group block ids by page
      const pageGroups = new Map<number, string[]>();
      for (const [bid, pg] of Object.entries(pageMap)) {
        if (!pageGroups.has(pg)) pageGroups.set(pg, []);
        pageGroups.get(pg)!.push(bid);
      }
      for (const i of idxs) {
        const blockId = mentions[i].id;
        const page = pageMap[blockId];
        if (!page) { labels[i] = "#[已删除]"; continue; }
        const pageBlocks = pageGroups.get(page) ?? [];
        const pos = pageBlocks.indexOf(blockId) + 1;
        labels[i] = `#p.${page}-${pos}`;
        urls[i] = `${base}/script${vParam}#block-${blockId}`;
      }
    }

    // rehearsal mode: find position within rehearsal mark range
    if (byMode.has("rehearsal") && effectiveVersionId) {
      const idxs = byMode.get("rehearsal")!;
      const ids = idxs.map(i => mentions[i].id);
      const r = await pool.query<{ block_id: string; scene_id: string; rehearsal_mark: string | null; sort_key: string }>(
        `SELECT sv.block_id, s.scene_id, s.rehearsal_mark, sv.sort_key
         FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
         WHERE sv.version_id = $1 AND sv.block_id = ANY($2::text[])`,
        [effectiveVersionId, ids]
      );
      const blockInfo = new Map(r.rows.map(row => [row.block_id, row]));

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = blockInfo.get(blockId);
        if (!info || !info.rehearsal_mark) { labels[i] = "#[已删除]"; continue; }

        // Count blocks with same mark in same scene before this sort_key
        const posRes = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM script_version sv JOIN script s ON s.id = sv.snapshot_id
           WHERE sv.version_id = $1 AND s.scene_id = $2 AND s.rehearsal_mark = $3 AND sv.sort_key <= $4`,
          [effectiveVersionId, info.scene_id, info.rehearsal_mark, info.sort_key]
        );
        const pos = parseInt(posRes.rows[0]?.count ?? "0");

        // Get scene num
        const snRes = await pool.query<{ num: string }>(
          `SELECT num FROM scene_version WHERE version_id = $1 AND scene_id = $2`,
          [effectiveVersionId, info.scene_id]
        );
        const num = snRes.rows[0]?.num;
        labels[i] = num ? `#${num}${info.rehearsal_mark}-${pos}` : "#[已删除]";
        urls[i] = `${base}/script${vParam}#block-${blockId}`;
      }
    }

    // Fallback for blocks without effectiveVersionId
    if (!effectiveVersionId) {
      for (const i of blockIdxs) {
        if (labels[i] === null) labels[i] = "#[未知版本]";
        urls[i] = `${base}/script`;
      }
    }
  }

  // ── cue ───────────────────────────────────────────────────────────────────
  if (byKind.has("cue")) {
    const cueIdxs = byKind.get("cue")!;
    const cueIds = cueIdxs.map(i => mentions[i].id);
    const r = await pool.query<{ id: string; number: string; name: string | null; abbr: string; cue_list_id: string }>(
      `SELECT c.id, c.number, c.name, cl.abbr, c.cue_list_id
       FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE c.id = ANY($1::text[])`,
      [cueIds]
    );
    const cueMap = new Map(r.rows.map(row => [row.id, row]));
    for (const i of cueIdxs) {
      const cue = cueMap.get(mentions[i].id);
      if (!cue) { labels[i] = "#[已删除]"; continue; }
      labels[i] = cue.name
        ? `${cue.abbr}.${cue.number}: ${cue.name}`
        : `${cue.abbr}.${cue.number}`;
      urls[i] = `${base}/cues?cueList=${cue.cue_list_id}&cueId=${cue.id}${vAmp}`;
    }
  }

  // ── asset ─────────────────────────────────────────────────────────────────
  if (byKind.has("asset")) {
    const assetIdxs = byKind.get("asset")!;
    const assetIds = assetIdxs.map(i => mentions[i].id);
    const r = await pool.query<{ id: string; name: string | null; file_name: string }>(
      `SELECT id, name, file_name FROM asset WHERE id = ANY($1::text[])`,
      [assetIds]
    );
    const assetMap = new Map(r.rows.map(row => [row.id, row]));

    // Collect cue-mounted assets for batch cue_list lookup
    const cueMountIdxs: { i: number; cueId: string }[] = [];

    for (const i of assetIdxs) {
      const asset = assetMap.get(mentions[i].id);
      labels[i] = asset ? (asset.name ?? asset.file_name) : "#[已删除]";

      if (!asset) continue;

      const mention = mentions[i];
      const auxStr = mention.aux ?? "";
      const colonIdx = auxStr.indexOf(":");
      const mountType = colonIdx >= 0 ? auxStr.slice(0, colonIdx) : auxStr;
      const mountId = colonIdx >= 0 ? auxStr.slice(colonIdx + 1) : "";

      switch (mountType) {
        case "production":
        case "version":
          urls[i] = `${base}/assets`;
          break;
        case "scene":
        case "scene_snapshot":
          // scene_snapshot mount_id is the stable scene_id
          urls[i] = `${base}/dramaturgy${vParam ? vParam + "&" : "?"}sceneId=${mountId}`;
          break;
        case "block":
          urls[i] = `${base}/script${vParam}#block-${mountId}`;
          break;
        case "block_snapshot": {
          // mount_id is a snapshot_id; reverse-map to block_id
          const bsr = await pool.query<{ block_id: string }>(
            `SELECT block_id FROM script_version WHERE snapshot_id = $1 LIMIT 1`,
            [mountId]
          );
          const blockId = bsr.rows[0]?.block_id;
          if (blockId) urls[i] = `${base}/script${vParam}#block-${blockId}`;
          break;
        }
        case "cue":
          cueMountIdxs.push({ i, cueId: mountId });
          break;
        case "cue_revision": {
          // mount_id is a revision_id; reverse-map to cue_id + cue_list_id
          const crr = await pool.query<{ cue_id: string; cue_list_id: string }>(
            `SELECT cv.cue_id, c.cue_list_id FROM cue_version cv JOIN cue c ON c.id = cv.cue_id
             WHERE cv.revision_id = $1 LIMIT 1`,
            [mountId]
          );
          if (crr.rows[0]) {
            const { cue_id, cue_list_id } = crr.rows[0];
            urls[i] = `${base}/cues?cueList=${cue_list_id}&cueId=${cue_id}${vAmp}`;
          }
          break;
        }
        case "event":
          urls[i] = `${base}/events/${mountId}/view`;
          break;
        default:
          urls[i] = `${base}/assets`;
      }
    }

    // Batch resolve cue_list_id for cue-mounted assets
    if (cueMountIdxs.length > 0) {
      const cueIds = cueMountIdxs.map(x => x.cueId);
      const cr = await pool.query<{ id: string; cue_list_id: string }>(
        `SELECT id, cue_list_id FROM cue WHERE id = ANY($1::text[])`,
        [cueIds]
      );
      const cueListMap = new Map(cr.rows.map(row => [row.id, row.cue_list_id]));
      for (const { i, cueId } of cueMountIdxs) {
        const cueListId = cueListMap.get(cueId);
        if (cueListId) {
          urls[i] = `${base}/cues?cueList=${cueListId}&cueId=${cueId}${vAmp}`;
        }
      }
    }
  }

  return Response.json({ labels, urls });
}
