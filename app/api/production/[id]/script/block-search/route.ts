import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId, getVersion, loadProduction, getEstimatedPageMap } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import { buildMarkerLabelIndex, type MarkerLabelIndex } from "@/lib/script-generated-labels";
import type { MentionSearchResult } from "@/lib/mention-types";
import type { Block } from "@/lib/script-types";

export type { MentionSearchResult as ScriptBlockSearchResult };

type Ctx = { params: Promise<{ id: string }> };
type SceneRow = { id: string; num: string; name: string };
const SCENE_REHEARSAL_LABEL_RE = /^(\d(?:[\d.\-]*\d)?)-?([A-Za-z]+)$/;

/**
 * 一次请求内的剧本索引。正文只经 `loadProduction()` 读一次（#336：剧本正文的读取面
 * 收敛到这一个闸口，#339 的权限门只需加在那里），其余全部内存过滤——逐场 / 逐排练
 * 记号 / 逐页的候选本来就只取前 15 条，不值得各开一条 SQL。
 *
 * `textBlocks` 走与分页器、打印页同一条投影链（marker 归属 → legacy 投影），所以
 * 这里的 sceneId / rehearsalMark 与页码、与屏上的分组判定同源。
 */
type ScriptIndex = {
  textBlocks: Block[];
  scenes: SceneRow[];
  labels: MarkerLabelIndex;
  pageMap: () => Promise<Record<string, number>>;
};

function likePatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${source}$`, "i");
}

function blockDesc(r: { content: string }): string {
  return r.content.slice(0, 60);
}

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return null;
  const version = await getVersion(versionId);
  return version?.productionId === productionId ? versionId : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId
  );
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view")))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!q) return Response.json({ results: [] });

  const paramVersionId = req.nextUrl.searchParams.get("v") || null;
  const versionId = await resolveProductionVersion(productionId, paramVersionId);
  if (paramVersionId && !versionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  // 版本退役（PR #300）后每个演出恒有 head。万一没有：剧本域（场 / 块 / 页）一律
  // 空结果，不再走「无版本按 production_id 直查 script 表」的老路；cue 域不依赖
  // 版本，照常可搜（无版本过滤时 DISTINCT ON 才有活干，见 cue-mention-resolve 测试）。

  // 「版本名:查询」前缀曾在此解析——version.name 已随版本退役 DROP，那段 SQL 一跑
  // 就 500（用户搜带冒号的台词即触发），故整段删除；带冒号的查询按原文处理。
  const mentionQuery = q;

  const pool = getPool();
  const results: MentionSearchResult[] = [];
  const dedup = (r: MentionSearchResult[]) => {
    const seen = new Set<string>();
    return r.filter(x => {
      const key = `${x.kind}:${x.id}:${x.aux ?? ""}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };

  // ── 剧本索引（懒加载，整个请求只读一次正文）──────────────────────────────
  let scriptPromise: Promise<ScriptIndex | null> | null = null;
  function loadScript(): Promise<ScriptIndex | null> {
    return scriptPromise ??= (async () => {
      if (!versionId) return null;
      const loaded = await loadProduction(productionId, versionId);
      if (!loaded) return null;
      const owned = withMarkerOwnership(loaded.state.blocks);
      const textBlocks = withLegacyOwnershipProjection(owned).filter((block) => !isMarkerBlock(block));
      let pageMapPromise: Promise<Record<string, number>> | null = null;
      return {
        textBlocks,
        scenes: loaded.state.scenes.map((scene) => ({ id: scene.id, num: scene.number, name: scene.name })),
        labels: buildMarkerLabelIndex(owned),
        pageMap: () => pageMapPromise ??= getEstimatedPageMap(productionId, versionId, loaded.state),
      };
    })();
  }

  async function firstBlockInScene(sceneId: string): Promise<Block | null> {
    const script = await loadScript();
    return script?.textBlocks.find((block) => block.sceneId === sceneId) ?? null;
  }

  async function blocksInScene(sceneId: string): Promise<Block[]> {
    const script = await loadScript();
    return script?.textBlocks.filter((block) => block.sceneId === sceneId).slice(0, 15) ?? [];
  }

  /**
   * 某场里挂在某个排练记号下的正文块（按序，前 15 条）。记号下没有块时返回 null——
   * 与旧行为一致：空记号不进候选。
   */
  async function markBlocks(sceneId: string, mark: string): Promise<{ markerId: string; blocks: Block[] } | null> {
    const script = await loadScript();
    if (!script) return null;
    const markerId = script.labels.markerIdByParentAndLabel.get(`${sceneId}\u0000${mark.toUpperCase()}`);
    if (!markerId) return null;
    const blocks = script.textBlocks.filter((block) => block.sceneId === sceneId && block.rehearsalMark === markerId);
    return blocks.length > 0 ? { markerId, blocks: blocks.slice(0, 15) } : null;
  }

  async function blocksOnPage(pageNum: number): Promise<Block[]> {
    const script = await loadScript();
    if (!script) return [];
    const pageMap = await script.pageMap();
    return script.textBlocks.filter((block) => pageMap[block.id] === pageNum).slice(0, 15);
  }

  async function queryScenes(numPattern: string, limit: number): Promise<SceneRow[]> {
    const matcher = likePatternToRegex(numPattern);
    return ((await loadScript())?.scenes ?? [])
      .filter(scene => matcher.test(scene.num))
      .slice(0, limit);
  }

  async function queryScenesText(textPattern: string, limit: number): Promise<SceneRow[]> {
    const matcher = likePatternToRegex(textPattern);
    return ((await loadScript())?.scenes ?? [])
      .filter(scene => matcher.test(scene.num) || matcher.test(scene.name))
      .slice(0, limit);
  }

  async function loadRehearsalLabels(): Promise<MarkerLabelIndex> {
    return (await loadScript())?.labels ?? buildMarkerLabelIndex([]);
  }

  // ── Asset: asset.{mount_query}-{name_prefix} ──────────────────────────────

  // #420：挂载边在 node_mount（锚稳定 id），经壳节点 join asset
  async function queryAssetsByMount(
    mountType: string, mountId: string, namePrefix: string, mountLabel: string
  ): Promise<MentionSearchResult[]> {
    const params: unknown[] = [productionId, mountType, mountId];
    const nameCond = namePrefix ? `AND a.name ILIKE $${params.push(`${namePrefix}%`)}` : "";
    const r = await pool.query<{ id: string; name: string | null; asset_type: string }>(
      `SELECT a.id, a.name, a.asset_type FROM asset a
       JOIN node n ON n.asset_id = a.id
       JOIN node_mount nm ON nm.node_id = n.id
       WHERE nm.production_id = $1 AND nm.mount_type = $2 AND nm.mount_id = $3 ${nameCond}
       ORDER BY a.name LIMIT 8`,
      params
    );
    return r.rows.map(row => ({
      kind: "asset", id: row.id,
      aux: `${mountType}:${mountId}`,
      displayLabel: `#asset.${mountLabel}-${row.name ?? "?"}`,
      description: row.asset_type,
    }));
  }

  async function searchAssets(mountQuery: string, namePrefix: string): Promise<MentionSearchResult[]> {
    // Production: "production.folder/path"（#420：production mount ≡ 树可枚举——
    // 「共享资产」= listable 的 asset 节点，folder 路径由祖先 folder 链实时拼出）
    if (mountQuery.startsWith("production.") || mountQuery === "production") {
      const folderPath = mountQuery.startsWith("production.") ? mountQuery.slice("production.".length) : "";
      const params: unknown[] = [productionId];
      const folderCond = folderPath ? `AND array_to_string(t.segs, '/') ILIKE $${params.push(`${folderPath}%`)}` : "";
      const nameCond = namePrefix ? `AND a.name ILIKE $${params.push(`${namePrefix}%`)}` : "";
      const r = await pool.query<{ id: string; name: string | null; folder_path: string | null; asset_type: string }>(
        `WITH RECURSIVE anc AS (
           SELECT n.id AS asset_node, n.asset_id, n.parent_id, ARRAY[]::text[] AS segs
           FROM node n
           WHERE n.production_id = $1 AND n.kind = 'asset' AND n.listable
           UNION ALL
           SELECT anc.asset_node, anc.asset_id, p.parent_id,
                  -- 顶层的「资产」根不进路径（它的 parent 是 NULL）
                  CASE WHEN p.kind = 'folder' AND p.parent_id IS NOT NULL
                       THEN p.title || anc.segs ELSE anc.segs END
           FROM anc JOIN node p ON p.id = anc.parent_id
         )
         SELECT a.id, a.name, NULLIF(array_to_string(t.segs, '/'), '') AS folder_path, a.asset_type
         FROM anc t
         JOIN asset a ON a.id = t.asset_id
         WHERE t.parent_id IS NULL ${folderCond} ${nameCond}
         ORDER BY a.name LIMIT 8`,
        params
      );
      return r.rows.map(row => ({
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
      const blockId = (await blocksOnPage(pageNum))[blockIdx]?.id;
      if (!blockId) return [];
      return queryAssetsByMount("block", blockId, namePrefix, mountQuery);
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
      // #420：cue 挂载锚稳定 cue_id
      const stable = await pool.query<{ cue_id: string }>(
        `SELECT cue_id FROM cue WHERE id = $1`, [r.rows[0].id]);
      return queryAssetsByMount("cue", stable.rows[0]?.cue_id ?? r.rows[0].id, namePrefix, `${abbr}.${cueNum}`);
    }

    // Scene+mark+block: 1-1A-3
    const markBlockM = mountQuery.match(/^(\d[\d.\-]*)([A-Za-z]+)-(\d+)$/);
    if (markBlockM) {
      const [, sceneNum, mark, posStr] = markBlockM;
      const idx = parseInt(posStr) - 1;
      const scenes = await queryScenes(`${sceneNum}`, 1);
      if (!scenes[0]) return [];
      const blockId = (await markBlocks(scenes[0].id, mark))?.blocks[idx]?.id;
      if (!blockId) return [];
      return queryAssetsByMount("block", blockId, namePrefix, mountQuery);
    }

    // Scene+block: 1-1-3
    const sceneBlockM = mountQuery.match(/^(\d[\d.\-]*)-(\d+)$/);
    if (sceneBlockM) {
      const [, sceneNum, posStr] = sceneBlockM;
      const idx = parseInt(posStr) - 1;
      const scenes = await queryScenes(sceneNum, 1);
      if (!scenes[0]) return [];
      const blockId = (await blocksInScene(scenes[0].id))[idx]?.id;
      if (!blockId) return [];
      return queryAssetsByMount("block", blockId, namePrefix, mountQuery);
    }

    // Scene+mark: 1-1A (mounts on the scene itself, no separate rehearsal mount type)
    const markM = mountQuery.match(SCENE_REHEARSAL_LABEL_RE);
    if (markM) {
      const [, sceneNum, mark] = markM;
      const scenes = await queryScenes(`${sceneNum}`, 1);
      if (!scenes[0]) return [];
      return queryAssetsByMount("scene", scenes[0].id, namePrefix,
        `${scenes[0].num}-${mark.toUpperCase()}`);
    }

    // Scene: 1-1
    if (/^\d[\d.\-]*$/.test(mountQuery)) {
      const scenes = await queryScenesText(`${mountQuery}%`, 1);
      if (!scenes[0]) return [];
      return queryAssetsByMount("scene", scenes[0].id, namePrefix, scenes[0].num);
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
      const rows = await blocksOnPage(pageNum);
      return Response.json({ results: rows.map((r, i) => ({
        kind: "block", displayMode: "page",
        id: r.id, displayLabel: `#p.${pageNum}-${i + 1}`, description: blockDesc(r),
      })) });
    }

    const spmDrill = base.match(SCENE_REHEARSAL_LABEL_RE);
    if (spmDrill) {
      const [, sceneQuery, mark] = spmDrill;
      const sceneRows = await queryScenes(`${sceneQuery}%`, 1);
      if (sceneRows[0]) {
        const found = await markBlocks(sceneRows[0].id, mark);
        if (found) {
          const labels = await loadRehearsalLabels();
          const prefix = labels.labelByMarkerId.get(found.markerId);
          if (!prefix) return Response.json({ results: [] });
          return Response.json({ results: found.blocks.map((r, i) => ({
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
          if (fb) results.push({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined });
        }
        return Response.json({ results: dedup(results) });
      }
      const exactScenes = await queryScenes(base, 1);
      if (exactScenes[0]) {
        const rows = await blocksInScene(exactScenes[0].id);
        const sceneNum = exactScenes[0].num;
        return Response.json({ results: rows.map((r, i) => ({
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
    results.push({ kind: "page", id: String(pageNum), displayLabel: `#p.${pageNum}`, description: `第${pageNum}页` });
    return Response.json({ results });
  }

  // ─── Scene+mark: digits + letters, e.g. "1-1A" ───────────────────────────

  const scenePlusMark = mentionQuery.match(SCENE_REHEARSAL_LABEL_RE);
  if (scenePlusMark) {
    const [, sceneQuery, mark] = scenePlusMark;
    const sceneRows = await queryScenes(`${sceneQuery}%`, 4);
    const labels = await loadRehearsalLabels();
    for (const scene of sceneRows) {
      const found = await markBlocks(scene.id, mark);
      if (found) {
        const displayLabel = labels.labelByMarkerId.get(found.markerId);
        if (!displayLabel) continue;
        results.push({
          kind: "rehearsal", id: found.markerId,
          displayLabel: `#${displayLabel}`, description: scene.name || undefined,
        });
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Scene only: digits/dashes, e.g. "1-1" ───────────────────────────────

  const sceneOnly = mentionQuery.match(/^[\d.\-]+$/);
  if (sceneOnly) {
    const sceneRows = await queryScenesText(`${mentionQuery}%`, 5);
    const labels = await loadRehearsalLabels();
    for (const scene of sceneRows) {
      results.push({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined });

      for (const markerId of labels.rehearsalLabelByMarkerId.keys()) {
        if (labels.parentIdByMarkerId.get(markerId) !== scene.id) continue;
        const displayLabel = labels.labelByMarkerId.get(markerId);
        if (!displayLabel) continue;
        results.push({
          kind: "rehearsal", id: markerId,
          displayLabel: `#${displayLabel}`, description: scene.name || undefined,
        });
        if (results.length >= 8) break;
      }
    }
    return Response.json({ results: dedup(results).slice(0, 8) });
  }

  // ─── Cue: ABBR.number, e.g. "SQ.5" ──────────────────────────────────────

  const cueNumMatch = mentionQuery.match(/^([A-Z][A-Z0-9]*)\.(.*)$/);
  if (cueNumMatch) {
    const [, abbr, numPrefix] = cueNumMatch;
    // 交给编辑器的是**稳定 cue_id**（#302），不是行 id——行 id 会被 CoW 换掉，
    // 插进正文就成了改一次即失效的引用。无版本过滤时同一逻辑 cue 可能有多条修订，
    // DISTINCT ON 先收敛到一条，否则重复行会在 dedup 之前就把 LIMIT 8 吃光。
    const cueRes = await pool.query<{ cue_id: string; number: string; name: string; abbr: string }>(
      `SELECT d.cue_id, d.number, d.name, d.abbr FROM (
         SELECT DISTINCT ON (c.cue_id) c.cue_id, c.number, c.name, cl.abbr
         FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE cl.production_id = $1 AND cl.abbr = $2 AND ($3 = '' OR c.number ILIKE $4)
         ${versionId ? "AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $5)" : ""}
         ORDER BY c.cue_id, c.id DESC
       ) d
       ORDER BY length(d.number), d.number LIMIT 8`,
      versionId
        ? [productionId, abbr, numPrefix, `${numPrefix}%`, versionId]
        : [productionId, abbr, numPrefix, `${numPrefix}%`]
    );
    for (const r of cueRes.rows) {
      results.push({ kind: "cue", id: r.cue_id, displayLabel: `#${r.abbr}.${r.number}`, description: r.name || undefined });
    }
    return Response.json({ results: dedup(results) });
  }

  // ─── Text search: scene name ──────────────────────────────────────────────

  const sceneTextRes = await queryScenesText(`%${mentionQuery}%`, 6);
  for (const scene of sceneTextRes) {
    results.push({ kind: "scene", id: scene.id, displayLabel: `#${scene.num}`, description: scene.name || undefined });
  }
  return Response.json({ results: dedup(results).slice(0, 8) });
}
