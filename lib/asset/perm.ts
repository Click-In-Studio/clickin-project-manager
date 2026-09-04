import { getPool } from "../pg";
import { hasGrant, listGrantedResourceIds } from "../grant-check";
import { type GrantActor } from "../grant-check";
import { isPolicyOn } from "../policy-db";
import { canEditWiki, listVisibleWikiIds } from "../wiki/perm";
import { listEnumerableNodeIds } from "../node/perm";
import { mountConcededNodeIds, SCENE_MOUNT_TYPES } from "../node/host-visibility";
import type { Asset } from "./db";

// ─── asset 可见性判定（批D 隐私/公开模型，#420 node 化）─────────────────────
//
// 可见 = publication@view（越隐私：实例授权/显式通配，保留段）
//      ∨ 能力票（meta|file@view，通配=能力不是 any 实例票）
//        ∧ (node.is_public ∨ node 可枚举 ∨ ∃挂载边: 宿主可见)   ← 结构让渡
//
// #420 变化：
//   · is_public 迁到 node 上（asset 列已删）；语义不变——只免除结构面要求、
//     仍需能力票（比 wiki 的「无条件全员可见」窄一档）。
//   · 原 production mount「根共享区」通道 → **node 可枚举**（树上 listable 链通
//     ⇒ 让渡成立）。语义等价：production mount ≡ 可枚举 node（#420 定谳）。
//   · 挂载让渡通道保留（2026-09-04 拍板 5）：**可见与可枚举是两个概念**——
//     挂载边等价于分享（内容面），不投枚举票（树面）。宿主可见 ⇒ 资产可读，
//     如同 wiki 被分享后父链不可枚举也看不到位置但能读。
//   · 'embed' 边（原 'wiki' mount）：文档可见 ⇒ 正文里的图可见。

export type AssetFace = "meta" | "file";

// 宿主可见锚已收敛到 lib/node/host-visibility.ts（PR-A：wiki/asset 两域同源消费，
// 顺带补上 event 通道——即批一 mountHostSidePermitted 注释挂账的 event 系修正之一）。
// embed 通道是 asset 特有（文档可见 ⇒ 正文里的图可见），留在本域。

async function anyMountHostVisible(
  permCtx: GrantActor,
  productionId: string,
  nodeId: string,
): Promise<boolean> {
  const conceded = await mountConcededNodeIds(permCtx, productionId, { nodeIds: [nodeId] });
  if (conceded.has(nodeId)) return true;
  // embed 边：批量走 listVisibleWikiIds（与 structurallyVisibleAssetIds 同一实现，
  // 天然不分叉）
  const embedMounts = (await getPool().query<{ mount_id: string }>(
    `SELECT mount_id FROM node_mount
     WHERE production_id = $1 AND node_id = $2 AND mount_type = 'embed'`,
    [productionId, nodeId],
  )).rows;
  if (embedMounts.length > 0) {
    const vis = await listVisibleWikiIds(permCtx, productionId);
    if (embedMounts.some(m => vis.wildcard || vis.ids.has(m.mount_id))) return true;
  }
  return false;
}

type AssetNodeBits = { nodeId: string; isPublic: boolean };

async function assetNodeBits(assetIds: string[]): Promise<Map<string, AssetNodeBits>> {
  if (assetIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ asset_id: string; id: string; is_public: boolean }>(
    `SELECT asset_id, id, is_public FROM node WHERE asset_id = ANY($1::text[])`,
    [assetIds],
  );
  return new Map(rows.map(r => [r.asset_id, { nodeId: r.id, isPublic: r.is_public }]));
}

/** face="meta"=条目/预览可见；face="file"=下载/原件。 */
export async function canViewAsset(
  permCtx: GrantActor,
  productionId: string,
  asset: Pick<Asset, "id">,
  face: AssetFace,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  if (await hasGrant(permCtx.userId, productionId, "asset", asset.id, "publication", "view")) return true;
  if (!await hasGrant(permCtx.userId, productionId, "asset", asset.id, face, "view")) return false;
  const bits = (await assetNodeBits([asset.id])).get(asset.id);
  // #236 policy.asset_public_enabled：关掉后 is_public 让渡失效（形状 C 天然追溯）
  if (bits?.isPublic && await isPolicyOn(productionId, "policy.asset_public_enabled")) return true;
  // node 可枚举 ⇒ 结构让渡（原 production 根共享区通道的树化形态）
  if (bits) {
    const e = await listEnumerableNodeIds(permCtx, productionId);
    if (e.wildcard || e.ids.has(bits.nodeId)) return true;
    return anyMountHostVisible(permCtx, productionId, bits.nodeId);
  }
  // 无壳（1:1 不变量破损）⇒ 挂载边无处可挂，结构面不成立
  return false;
}

/** id 版单点判定（node/link 等只持 asset id 的调用方用）。 */
export async function canViewAssetById(
  permCtx: GrantActor,
  productionId: string,
  assetId: string,
  face: AssetFace,
): Promise<boolean> {
  return canViewAsset(permCtx, productionId, { id: assetId }, face);
}

/** 结构面集合式：该用户经「可枚举 ∨ 挂载让渡」可见的 asset id 集合（不含授权面、
 *  不含 is_public——那两条在 filterVisibleAssets 合取）。 */
async function structurallyVisibleAssetIds(
  permCtx: GrantActor,
  productionId: string,
): Promise<Set<string>> {
  // 挂载让渡：共享核集合式（与单点 anyMountHostVisible 同一实现，不分叉）
  const conceded = await mountConcededNodeIds(permCtx, productionId, { kind: "asset" });
  const visible = new Set<string>();
  // 可枚举通道（原 production 根共享区）：一次集合式对撞 asset 节点
  const e = await listEnumerableNodeIds(permCtx, productionId);
  const assetNodes = (await getPool().query<{ asset_id: string; id: string }>(
    `SELECT asset_id, id FROM node WHERE production_id = $1 AND asset_id IS NOT NULL`,
    [productionId],
  )).rows;
  for (const n of assetNodes) {
    if (conceded.has(n.id) || e.wildcard || e.ids.has(n.id)) visible.add(n.asset_id);
  }
  // embed 边（与 canViewAsset 的 embed 分支同源——列表与单实例不得分叉，批D 教训）
  const embedMounts = (await getPool().query<{ asset_id: string; mount_id: string }>(
    `SELECT n.asset_id, nm.mount_id
     FROM node_mount nm JOIN node n ON n.id = nm.node_id
     WHERE nm.production_id = $1 AND nm.mount_type = 'embed' AND n.asset_id IS NOT NULL`,
    [productionId],
  )).rows;
  if (embedMounts.length > 0) {
    const vis = await listVisibleWikiIds(permCtx, productionId);
    for (const m of embedMounts) {
      if (vis.wildcard || vis.ids.has(m.mount_id)) visible.add(m.asset_id);
    }
  }
  return visible;
}

/** 列表过滤（与 canViewAsset(meta) 同语义的集合式实现，同读 policy）。 */
export async function filterVisibleAssets<T extends Pick<Asset, "id">>(
  permCtx: GrantActor,
  productionId: string,
  assets: T[],
): Promise<T[]> {
  if (permCtx.isAdmin || permCtx.isOwner || assets.length === 0) return assets;
  const [meta, pub, structIds, bits] = await Promise.all([
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "meta", "view"),
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "publication", "view"),
    structurallyVisibleAssetIds(permCtx, productionId),
    assetNodeBits(assets.map(a => a.id)),
  ]);
  const metaIds = new Set(meta.ids);
  const pubIds = new Set(pub.ids);
  const publicOn = await isPolicyOn(productionId, "policy.asset_public_enabled");
  return assets.filter(a =>
    pub.wildcard || pubIds.has(a.id)
    || ((meta.wildcard || metaIds.has(a.id))
        && ((bits.get(a.id)?.isPublic === true && publicOn) || structIds.has(a.id))));
}

// ─── 双门（挂载=两域各自的一等动作）─────────────────────────────────────────

/** asset 侧门：挂载/解除 = 该 asset 的发布面动作 */
export async function canPublishAsset(
  permCtx: GrantActor,
  productionId: string,
  assetId: string,
  verb: "create" | "delete",
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  return hasGrant(permCtx.userId, productionId, "asset", assetId, "publication", verb);
}

/** 宿主侧门。'production'/'wiki' 挂载类型已退役（#420）：全局共享走 node 树
 *  listable、文档嵌图走 'embed'（门=编辑该文档）。 */
export async function mountHostSidePermitted(
  permCtx: GrantActor,
  productionId: string,
  mountType: string,
  mountId: string,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  if (SCENE_MOUNT_TYPES.includes(mountType))
    return hasGrant(permCtx.userId, productionId, "scene", mountId, "mounts", "create");
  // embed：把图挂进文档 = 编辑该文档
  if (mountType === "embed") return canEditWiki(permCtx, productionId, mountId);
  // block/comment/cue/event/event_schedule/task/event_report 沿用剧本流原子键
  //（event 系错配修正挂账 #420 第二批——批一行为保真）
  return hasGrant(permCtx.userId, productionId, "script", "*", "mounts", "create");
}

/** 分享令牌规则（论证全文见 git 史）："令牌含下载 ⟺ 发令牌者持有 file@view"；
 *  项目出口由 policy.share_token_enabled 把守，两者串联；admin/owner 旁路在顶端。 */
export async function canCreateShareToken(
  permCtx: GrantActor,
  productionId: string,
  asset: Pick<Asset, "id">,
): Promise<{ allowed: boolean; downloadable: boolean }> {
  if (permCtx.isAdmin || permCtx.isOwner) return { allowed: true, downloadable: true };
  if (!await isPolicyOn(productionId, "policy.share_token_enabled")) {
    return { allowed: false, downloadable: false };
  }
  const allowed = await hasGrant(permCtx.userId, productionId, "asset", asset.id, "shares", "create")
    && await canViewAsset(permCtx, productionId, asset, "meta");
  if (!allowed) return { allowed: false, downloadable: false };
  const downloadable = await canViewAsset(permCtx, productionId, asset, "file");
  return { allowed: true, downloadable };
}
