import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getActiveVersionId, listScenesByVersion, ensureScriptMarkerMigration, getMarkerLabelIndex, getVersion } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getPool } from "@/lib/pg";
import { MARKER_TYPES_SQL, VERSION_OWNED_BLOCKS_CTE } from "@/lib/script-marker-sql";
import { computePageMap } from "@/lib/script-page";
import type { ContentMentionAttrs, BlockDisplayMode } from "@/lib/mention-types";
import type { Block, BlockType } from "@/lib/script-types";
import { buildMarkerLabelIndex } from "@/lib/script-generated-labels";

type Ctx = { params: Promise<{ id: string }> };

type ResolveInput = {
  mentions: ContentMentionAttrs[];
  versionId?: string | null;
};

type PageMapBlockRow = {
  id: string;
  snapshot_id: string;
  type: string;
  content: string;
  scene_id: string | null;
  rehearsal_mark: string | null;
  stage_comment: string | null;
  force_show_character_name: boolean;
};

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return null;
  const version = await getVersion(versionId);
  return version?.productionId === productionId ? versionId : null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides } = await getProductionMemberContext(
    session.userId, session.isAdmin, productionId
  );
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = await req.json() as ResolveInput;
  const { mentions, versionId: contextVersionId } = body;
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return Response.json({ labels: [], urls: [] });
  }

  const pool = getPool();
  const effectiveVersionId = await resolveProductionVersion(productionId, contextVersionId);
  if (contextVersionId && !effectiveVersionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  if (effectiveVersionId) {
    const migration = await ensureScriptMarkerMigration(effectiveVersionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }
  }
  const vParam = effectiveVersionId ? `?v=${effectiveVersionId}` : "";
  const vAmp = effectiveVersionId ? `&v=${effectiveVersionId}` : "";
  const base = `/production/${productionId}`;

  const labels: (string | null)[] = new Array(mentions.length).fill(null);
  const urls: (string | null)[] = new Array(mentions.length).fill(null);

  let generatedSceneNumMapPromise: Promise<Map<string, string>> | null = null;
  async function loadGeneratedSceneNumMap(): Promise<Map<string, string>> {
    if (!effectiveVersionId) return new Map();
    generatedSceneNumMapPromise ??= listScenesByVersion(effectiveVersionId)
      .then((scenes) => new Map(scenes.map((scene) => [scene.id, scene.number])));
    return generatedSceneNumMapPromise;
  }
  let rehearsalLabelsPromise: ReturnType<typeof getMarkerLabelIndex> | null = null;
  function loadRehearsalLabels() {
    return rehearsalLabelsPromise ??= effectiveVersionId
      ? getMarkerLabelIndex(effectiveVersionId)
      : Promise.resolve(buildMarkerLabelIndex([]));
  }

  let pageMapPromise: Promise<Record<string, number>> | null = null;
  async function loadPageMap(): Promise<Record<string, number>> {
    if (pageMapPromise) return pageMapPromise;

    pageMapPromise = (async () => {
      const blocksRes = effectiveVersionId
        ? await pool.query<PageMapBlockRow>(
            `${VERSION_OWNED_BLOCKS_CTE},
             version_snapshots AS (
               SELECT block_id, snapshot_id
               FROM script_version
               WHERE version_id = $1
             )
             SELECT ob.id, vs.snapshot_id, ob.type, ob.content, ob.scene_id, ob.rehearsal_mark,
                    s.stage_comment, s.force_show_character_name
             FROM owned_blocks ob
             JOIN version_snapshots vs ON vs.block_id = ob.id
             JOIN script s ON s.id = vs.snapshot_id
             ORDER BY ob.sort_key`,
            [effectiveVersionId]
          )
        : await pool.query<PageMapBlockRow>(
            `SELECT id, id AS snapshot_id, type::text AS type, content, scene_id, rehearsal_mark,
                    stage_comment, force_show_character_name
             FROM script
             WHERE production_id = $1
             ORDER BY sort_key`,
            [productionId]
          );

      const snapshotIds = blocksRes.rows.map((row) => row.snapshot_id);
      const charRes = snapshotIds.length > 0
        ? await pool.query<{ script_id: string; character_id: string }>(
            "SELECT script_id, character_id FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position",
            [snapshotIds]
          )
        : { rows: [] as Array<{ script_id: string; character_id: string }> };
      const charMap = new Map<string, string[]>();
      for (const row of charRes.rows) {
        if (!charMap.has(row.script_id)) charMap.set(row.script_id, []);
        charMap.get(row.script_id)!.push(row.character_id);
      }

      const blocks: Block[] = blocksRes.rows.map((row) => ({
        id: row.id,
        type: (["stage", "chapter_marker", "scene_marker", "rehearsal_marker"].includes(row.type) ? row.type : "dialogue") as BlockType,
        content: row.content,
        stageComment: row.stage_comment,
        characterIds: charMap.get(row.snapshot_id) ?? [],
        characterAnnotations: {},
        forceShowCharacterName: row.force_show_character_name,
        lyric: row.type === "lyric",
        sceneId: row.scene_id,
        rehearsalMark: row.rehearsal_mark,
      }));
      return computePageMap(blocks, "a4", "center", !!effectiveVersionId);
    })();
    return pageMapPromise;
  }

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

  // ── scene + rehearsal ─────────────────────────────────────────────────────
  const sceneIdxs = byKind.get("scene") ?? [];
  if (sceneIdxs.length > 0 && effectiveVersionId) {
    const numByScene = await loadGeneratedSceneNumMap();
    for (const i of sceneIdxs) {
      const m = mentions[i];
      const num = numByScene.get(m.id);
      if (!num) { labels[i] = "#[已删除]"; continue; }
      labels[i] = `#${num}`;
      urls[i] = `${base}/script${vParam}`;
    }
  } else if (sceneIdxs.length > 0) {
    for (const i of sceneIdxs) {
      labels[i] = "#[未知版本]";
      urls[i] = `${base}/script${vParam}`;
    }
  }
  const rehearsalIdxs = byKind.get("rehearsal") ?? [];
  if (rehearsalIdxs.length > 0 && effectiveVersionId) {
    const rehearsalLabels = await loadRehearsalLabels();
    for (const i of rehearsalIdxs) {
      const mention = mentions[i];
      const label = rehearsalLabels.labelByMarkerId.get(mention.id);
      labels[i] = label ? `#${label}` : "#[已删除]";
      urls[i] = `${base}/script${vParam}${label ? `#block-${mention.id}` : ""}`;
    }
  } else if (rehearsalIdxs.length > 0) {
    for (const i of rehearsalIdxs) {
      labels[i] = "#[未知版本]";
      urls[i] = `${base}/script`;
    }
  }

  // ── block ─────────────────────────────────────────────────────────────────
  if (byKind.has("block")) {
    const blockIdxs = byKind.get("block")!;

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
        `${VERSION_OWNED_BLOCKS_CTE},
         numbered_blocks AS (
           SELECT id AS block_id, scene_id,
                  ROW_NUMBER() OVER (PARTITION BY scene_id ORDER BY sort_key) AS row_num
           FROM owned_blocks
           WHERE type NOT IN (${MARKER_TYPES_SQL})
         )
         SELECT block_id, scene_id, row_num
         FROM numbered_blocks
         WHERE block_id = ANY($2::text[])`,
        [effectiveVersionId, ids]
      );
      const posMap = new Map(r.rows.map(row => [row.block_id, { sceneId: row.scene_id, pos: parseInt(row.row_num) }]));

      const sceneNumMap = await loadGeneratedSceneNumMap();

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = posMap.get(blockId);
        if (!info) { labels[i] = "#[已删除]"; continue; }
        const num = sceneNumMap.get(info.sceneId);
        labels[i] = num ? `#${num}-${info.pos}` : "#[已删除]";
        urls[i] = `${base}/script${vParam}#block-${blockId}`;
      }
    }

    // page mode: compute from the effective version's marker-owned blocks
    if (byMode.has("page")) {
      const idxs = byMode.get("page")!;
      const pageMap = await loadPageMap();
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
      const r = await pool.query<{ block_id: string; scene_id: string; rehearsal_mark: string | null; row_num: string }>(
        `${VERSION_OWNED_BLOCKS_CTE},
         numbered_rehearsal_blocks AS (
           SELECT id AS block_id, scene_id, rehearsal_mark,
                  ROW_NUMBER() OVER (PARTITION BY scene_id, rehearsal_mark ORDER BY sort_key) AS row_num
           FROM owned_blocks
           WHERE type NOT IN (${MARKER_TYPES_SQL}) AND rehearsal_mark IS NOT NULL
         )
         SELECT block_id, scene_id, rehearsal_mark, row_num
         FROM numbered_rehearsal_blocks
         WHERE block_id = ANY($2::text[])`,
        [effectiveVersionId, ids]
      );
      const blockInfo = new Map(r.rows.map(row => [row.block_id, row]));
      const rehearsalLabels = await loadRehearsalLabels();

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = blockInfo.get(blockId);
        if (!info || !info.rehearsal_mark) { labels[i] = "#[已删除]"; continue; }
        const pos = parseInt(info.row_num, 10);
        const label = rehearsalLabels.labelByMarkerId.get(info.rehearsal_mark);
        labels[i] = label ? `#${label}-${pos}` : "#[已删除]";
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
          // scene_snapshot mount_id is the marker block id.
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
