import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getActiveVersionId, getVersion, loadProduction, getEstimatedPageMap } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { isMarkerBlock, withLegacyOwnershipProjection, withMarkerOwnership } from "@/lib/script-marker-blocks";
import { buildMarkerLabelIndex, type MarkerLabelIndex } from "@/lib/script-generated-labels";
import type { ContentMentionAttrs, BlockDisplayMode } from "@/lib/mention-types";
import type { Block } from "@/lib/script-types";

type Ctx = { params: Promise<{ id: string }> };

type ResolveInput = {
  mentions: ContentMentionAttrs[];
  versionId?: string | null;
};

/**
 * 一次请求内的剧本索引。正文只经 `loadProduction()` 读一次（#336：读取面收敛到
 * 这一个闸口，#339 的权限门只需加在那里），场内序号 / 记号内序号 / 页码全部
 * 在内存里算。`textBlocks` 走与分页器同一条投影链（marker 归属 → legacy 投影）。
 */
type ScriptIndex = {
  textBlocks: Block[];
  sceneNumById: Map<string, string>;
  labels: MarkerLabelIndex;
  pageMap: () => Promise<Record<string, number>>;
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

  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId
  );
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;

  const body = await req.json() as ResolveInput;
  const { mentions, versionId: contextVersionId } = body;
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return Response.json({ labels: [], urls: [] });
  }

  // 剧本域 kinds 沿用 script blocks@view 门；wiki kind 不受此门约束——
  // 标题=目录级信息沿引用流出（账本 §4.1），内容门在 wiki 页面/API 自身。
  // 无剧本权限不再整请求 403（混合正文会连累 wiki/@ 解析）：剧本域 kinds
  // 软跳过（labels/urls 留 null，客户端回退编辑期快照），wiki 恒可解析
  const canResolveScript = permCtx.isAdmin || permCtx.isOwner
    || await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view");
  const effectiveMentions = canResolveScript
    ? mentions
    : mentions.map(m => (m?.kind === "wiki" ? m : null));

  const pool = getPool();
  const effectiveVersionId = await resolveProductionVersion(productionId, contextVersionId);
  if (contextVersionId && !effectiveVersionId) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  const vParam = effectiveVersionId ? `?v=${effectiveVersionId}` : "";
  const vAmp = effectiveVersionId ? `&v=${effectiveVersionId}` : "";
  const base = `/production/${productionId}`;

  const labels: (string | null)[] = new Array(mentions.length).fill(null);
  const urls: (string | null)[] = new Array(mentions.length).fill(null);

  // ── 剧本索引（懒加载：没有剧本域 mention 就不碰正文）────────────────────
  let scriptPromise: Promise<ScriptIndex | null> | null = null;
  function loadScript(): Promise<ScriptIndex | null> {
    return scriptPromise ??= (async () => {
      if (!effectiveVersionId) return null;
      const loaded = await loadProduction(productionId, effectiveVersionId);
      if (!loaded) return null;
      const owned = withMarkerOwnership(loaded.state.blocks);
      const textBlocks = withLegacyOwnershipProjection(owned).filter((block) => !isMarkerBlock(block));
      let pageMapPromise: Promise<Record<string, number>> | null = null;
      return {
        textBlocks,
        sceneNumById: new Map(loaded.state.scenes.map((scene) => [scene.id, scene.number])),
        labels: buildMarkerLabelIndex(owned),
        pageMap: () => pageMapPromise ??= getEstimatedPageMap(productionId, effectiveVersionId, loaded.state),
      };
    })();
  }

  // Group by kind for batch queries
  const byKind = new Map<string, number[]>();
  for (let i = 0; i < effectiveMentions.length; i++) {
    const m = effectiveMentions[i];
    if (!m) continue; // 剧本域软跳过（无剧本权限）
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind)!.push(i);
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
    const numByScene = (await loadScript())?.sceneNumById ?? new Map<string, string>();
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
    const rehearsalLabels = (await loadScript())?.labels ?? buildMarkerLabelIndex([]);
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
      const script = await loadScript();
      const posMap = new Map<string, { sceneId: string; pos: number }>();
      const countByScene = new Map<string, number>();
      for (const block of script?.textBlocks ?? []) {
        if (!block.sceneId) continue;
        const pos = (countByScene.get(block.sceneId) ?? 0) + 1;
        countByScene.set(block.sceneId, pos);
        posMap.set(block.id, { sceneId: block.sceneId, pos });
      }

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = posMap.get(blockId);
        if (!info) { labels[i] = "#[已删除]"; continue; }
        const num = script?.sceneNumById.get(info.sceneId);
        labels[i] = num ? `#${num}-${info.pos}` : "#[已删除]";
        urls[i] = `${base}/script${vParam}#block-${blockId}`;
      }
    }

    // page mode: 页码按演出实际版式取（#336）——此前这里硬编码 a4/center。
    // 与 scene / rehearsal 分支同样以版本为前提：无版本落到下面的「#[未知版本]」，
    // 而不是把全部页引用报成「已删除」。
    if (byMode.has("page") && effectiveVersionId) {
      const idxs = byMode.get("page")!;
      const script = await loadScript();
      const pageMap = script ? await script.pageMap() : {};
      // 页内序号按**正文顺序**分组，不能按 pageMap 的键序：它来自 JSONB 存储，
      // Postgres 会按键长/字节序重排，与正文顺序无关。
      const pageGroups = new Map<number, string[]>();
      for (const block of script?.textBlocks ?? []) {
        const pg = pageMap[block.id];
        if (!pg) continue;
        if (!pageGroups.has(pg)) pageGroups.set(pg, []);
        pageGroups.get(pg)!.push(block.id);
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
      const script = await loadScript();
      const blockInfo = new Map<string, { rehearsalMark: string; pos: number }>();
      const countByMark = new Map<string, number>();
      for (const block of script?.textBlocks ?? []) {
        if (!block.rehearsalMark) continue;
        const key = `${block.sceneId ?? ""}\u0000${block.rehearsalMark}`;
        const pos = (countByMark.get(key) ?? 0) + 1;
        countByMark.set(key, pos);
        blockInfo.set(block.id, { rehearsalMark: block.rehearsalMark, pos });
      }
      const rehearsalLabels = script?.labels ?? buildMarkerLabelIndex([]);

      for (const i of idxs) {
        const blockId = mentions[i].id;
        const info = blockInfo.get(blockId);
        if (!info) { labels[i] = "#[已删除]"; continue; }
        const label = rehearsalLabels.labelByMarkerId.get(info.rehearsalMark);
        labels[i] = label ? `#${label}-${info.pos}` : "#[已删除]";
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

  // ── wiki ──────────────────────────────────────────────────────────────────
  // 标题级解析（§4.1）：持有引用（即持有 id）即得标题；无权观看者点击后由
  // wiki 页面呈现申请入口。production 归属校验防跨剧组解析。
  if (byKind.has("wiki")) {
    const wikiIdxs = byKind.get("wiki")!;
    const UUID_RE = /^[0-9a-fA-F-]{36}$/;
    const wikiIds = [...new Set(wikiIdxs.map(i => mentions[i].id).filter(id => UUID_RE.test(id)))];
    const wikiMap = new Map<string, string | null>();
    if (wikiIds.length > 0) {
      const r = await pool.query<{ id: string; title: string | null }>(
        `SELECT id::text AS id, title FROM wiki WHERE id = ANY($1::uuid[]) AND production_id = $2`,
        [wikiIds, productionId],
      );
      for (const row of r.rows) wikiMap.set(row.id, row.title);
    }
    for (const i of wikiIdxs) {
      const id = mentions[i].id.toLowerCase();
      if (!wikiMap.has(id)) { labels[i] = "#[已删除]"; continue; }
      labels[i] = wikiMap.get(id) ?? "#[无标题]";
      urls[i] = `${base}/wiki/${id}`;
    }
  }

  // ── cue ───────────────────────────────────────────────────────────────────
  // 锚**稳定 cue_id**（#302）。cue 是修订表：改 cue 会 CoW 出新行 id，锚行 id
  // 的引用会在改一次之后变成"#[已删除]"幻影。一个逻辑 cue 在库里可能留有多条
  // 修订，DISTINCT ON 优先取当前版本那条；取不到（版本已退役/该逻辑 cue 不在
  // 本版本）则回退到任一存活修订——编号/名字是逻辑 cue 的属性，拿哪条修订都对，
  // 回退成"已删除"反而正是本次要消灭的幻影。
  if (byKind.has("cue")) {
    const cueIdxs = byKind.get("cue")!;
    const cueIds = cueIdxs.map(i => mentions[i].id);
    const r = await pool.query<{ cue_id: string; number: string; name: string | null; abbr: string; cue_list_id: string }>(
      `SELECT DISTINCT ON (c.cue_id) c.cue_id, c.number, c.name, cl.abbr, c.cue_list_id
       FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE c.cue_id = ANY($1::text[]) AND cl.production_id = $2
       ORDER BY c.cue_id,
                EXISTS (SELECT 1 FROM cue_version cv
                        WHERE cv.revision_id = c.id AND cv.version_id = $3) DESC,
                c.id DESC`,
      [cueIds, productionId, effectiveVersionId]
    );
    const cueMap = new Map(r.rows.map(row => [row.cue_id, row]));
    for (const i of cueIdxs) {
      const cue = cueMap.get(mentions[i].id);
      if (!cue) { labels[i] = "#[已删除]"; continue; }
      labels[i] = cue.name
        ? `${cue.abbr}.${cue.number}: ${cue.name}`
        : `${cue.abbr}.${cue.number}`;
      urls[i] = `${base}/cues?cueList=${cue.cue_list_id}&cueId=${cue.cue_id}${vAmp}`;
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

      // 【#420 读路径兼容，故意保留】version/scene_snapshot/block_snapshot/
      // cue_revision 作为 mount_type 已随迁移退役（node_mount CHECK 白名单挡死），
      // 但这里的 mountType 来自 wiki 正文里持久化的 mention aux——文档体不随迁移
      // 改写，旧文档的化石 aux 永远存在。删这些 case = 旧深链退化到 /assets。
      // 映射表 script_version/cue_version 仍在库里，反查照常成立。
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
          // 同上：加 production 归属校验，别让外剧组的 revision_id 套出宿主信息
          const crr = await pool.query<{ cue_id: string; cue_list_id: string }>(
            `SELECT cv.cue_id, c.cue_list_id
             FROM cue_version cv
             JOIN cue c ON c.id = cv.cue_id
             JOIN cue_list cl ON cl.id = c.cue_list_id
             WHERE cv.revision_id = $1 AND cl.production_id = $2 LIMIT 1`,
            [mountId, productionId]
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

    // Batch resolve cue_list_id for cue-mounted assets.
    // 挂载点本身仍锚行 id（asset_mount 的锚定不在 #302 范围内），但**链接**必须
    // 吐稳定 cue_id——/cues 页按 cue_id 认深链参数。所以这里顺带把行 id 翻成 cue_id。
    if (cueMountIdxs.length > 0) {
      const cueIds = cueMountIdxs.map(x => x.cueId);
      // production 归属校验与上面的 cue 分支同门：这条查询的产物是用户可见 URL，
      // 少了它，拿外剧组的 cue id 构造 aux 就能套出对方的 cue_list_id/cue_id。
      const cr = await pool.query<{ id: string; cue_id: string; cue_list_id: string }>(
        `SELECT c.id, c.cue_id, c.cue_list_id
         FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
         WHERE c.id = ANY($1::text[]) AND cl.production_id = $2`,
        [cueIds, productionId]
      );
      const cueRowMap = new Map(cr.rows.map(row => [row.id, row]));
      for (const { i, cueId } of cueMountIdxs) {
        const row = cueRowMap.get(cueId);
        if (row) {
          urls[i] = `${base}/cues?cueList=${row.cue_list_id}&cueId=${row.cue_id}${vAmp}`;
        }
      }
    }
  }

  return Response.json({ labels, urls });
}
