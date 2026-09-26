import { getPool } from "../pg";
import { hasEffectiveGrant, hasGrant, listGrantedResourceIds } from "../perm/grant-check";
import { type GrantActor } from "../perm/grant-check";
import { isPolicyOn } from "../perm/policy-db";
import { canEditWiki, listVisibleWikiIds } from "../wiki/perm";
import { mountConcededNodeIds, SCENE_MOUNT_TYPES } from "../node/host-visibility";
import { hasExplicitAssetDownloadGrant } from "./share-db";
import type { Asset } from "./db";

// ─── asset 内容面：个人正文授权 ∨ 全组公开 ∨ 部门分享 ∨ 挂载让渡 ──────────
// 目录可枚举独立判定。旧 meta/file@view 通配能力票不再参与内容读取；
// publication@view 是存量显式越隐私授权，保持原行含义。file@view 只控制下载。

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
  // embed 边：批量走 listVisibleWikiIds（与 mountedAssetIds 同一实现，
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

async function assetNodeBits(productionId: string, assetIds: string[]): Promise<Map<string, AssetNodeBits>> {
  if (assetIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ asset_id: string; id: string; is_public: boolean }>(
    `SELECT asset_id, id, is_public FROM node
     WHERE asset_id = ANY($1::text[]) AND production_id = $2`,
    [assetIds, productionId],
  );
  return new Map(rows.map(r => [r.asset_id, { nodeId: r.id, isPublic: r.is_public }]));
}

async function departmentSharedAssetIds(
  actor: GrantActor, productionId: string, assetIds: string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ asset_id: string }>(
    `SELECT DISTINCT n.asset_id FROM node n
     JOIN node_dept_share ns ON ns.node_id = n.id
     JOIN production_dept_member pdm ON pdm.dept_id = ns.dept_id
     WHERE n.production_id = $1 AND n.asset_id = ANY($2::text[])
       AND pdm.production_id = $1 AND pdm.user_id = $3`,
    [productionId, assetIds, actor.userId],
  );
  return new Set(rows.map(r => r.asset_id));
}

/** face="meta"=条目/预览可见；face="file"=下载/原件。 */
export async function canViewAsset(
  permCtx: GrantActor,
  productionId: string,
  asset: Pick<Asset, "id">,
  face: AssetFace,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  // 旧 publication@view 是明确的全内容授权，含原件；不能误作旧能力票收回。
  if (await hasEffectiveGrant(permCtx, productionId, "asset", asset.id, "publication", "view")) return true;
  // 下载独立控制，能预览不代表能发下载链接。
  if (face === "file" && !await hasExplicitAssetDownloadGrant(permCtx.userId, productionId, asset.id))
    return false;
  if (await hasEffectiveGrant(permCtx, productionId, "asset", asset.id, "*", "view")) return true;
  const bits = (await assetNodeBits(productionId, [asset.id])).get(asset.id);
  // #236 策略关掉只否决公开推导，不否决已有行、部门分享或挂载。
  if (bits?.isPublic && await isPolicyOn(productionId, "policy.asset_public_enabled")) return true;
  if (bits) {
    if ((await departmentSharedAssetIds(permCtx, productionId, [asset.id])).has(asset.id)) return true;
    return anyMountHostVisible(permCtx, productionId, bits.nodeId);
  }
  // 无壳时个人授权仍有效，结构性通道无处可挂。
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

/** 挂载让渡的集合式实现；目录可枚举性不投内容票。 */
async function mountedAssetIds(
  permCtx: GrantActor,
  productionId: string,
): Promise<Set<string>> {
  // 挂载让渡：共享核集合式（与单点 anyMountHostVisible 同一实现，不分叉）
  const conceded = await mountConcededNodeIds(permCtx, productionId, { kind: "asset" });
  const visible = new Set<string>();
  const assetNodes = (await getPool().query<{ asset_id: string; id: string }>(
    `SELECT asset_id, id FROM node WHERE production_id = $1 AND asset_id IS NOT NULL`,
    [productionId],
  )).rows;
  for (const n of assetNodes) {
    if (conceded.has(n.id)) visible.add(n.asset_id);
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
  const [direct, pub, mountIds, deptIds, bits] = await Promise.all([
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "*", "view"),
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "publication", "view"),
    mountedAssetIds(permCtx, productionId),
    departmentSharedAssetIds(permCtx, productionId, assets.map(a => a.id)),
    assetNodeBits(productionId, assets.map(a => a.id)),
  ]);
  const directIds = new Set(direct.ids);
  const pubIds = new Set(pub.ids);
  const publicOn = await isPolicyOn(productionId, "policy.asset_public_enabled");
  return assets.filter(a =>
    pub.wildcard || pubIds.has(a.id) || direct.wildcard || directIds.has(a.id)
    || (bits.get(a.id)?.isPublic === true && publicOn)
    || mountIds.has(a.id) || deptIds.has(a.id));
}

// ─── 双门（挂载=两域各自的一等动作）─────────────────────────────────────────

/** 站内分享走 grants@edit；存量单向发布键仅兼容其原有挂载/撤挂动作。 */
export async function canPublishAsset(
  permCtx: GrantActor,
  productionId: string,
  assetId: string,
  verb: "create" | "delete",
): Promise<boolean> {
  return await hasEffectiveGrant(permCtx, productionId, "asset", assetId, "grants", "edit")
    || hasEffectiveGrant(permCtx, productionId, "asset", assetId, "publication", verb);
}

/** 上传字节的门（presign 家族共用），按目标分叉成两把钥匙：
 *  新建资产＝资产域通配 create（"asset"/"*"/"*"/"create"）；追加版本
 *  （targetAssetId 非空）＝那个资产上的 file@create，与注册端点
 *  assets/<id>/files 同门，由创建者行集承担 own 语义。
 *
 *  #456 接线前 presign 只认前者：上传者靠创建者行集拿到的是 file@create，一旦
 *  角色上的通配 create 被回收，他给**自己的**资产传新版本会卡在签名这一步。
 *  注意这是放宽不是收紧——hasGrant 的 resource_id IN (id, '*') 语义下，持通配
 *  create 的人本来就满足 file@create，分叉后照旧过。 */
export async function canUploadAssetBytes(
  permCtx: GrantActor,
  productionId: string,
  targetAssetId?: string | null,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  if (targetAssetId)
    return hasGrant(permCtx.userId, productionId, "asset", targetAssetId, "file", "create");
  return hasGrant(permCtx.userId, productionId, "asset", "*", "*", "create");
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

/** 管理某资产的对外链接。策略关闭后仍允许查看和撤销已有链接。 */
export async function canManageShareLinks(
  permCtx: GrantActor,
  productionId: string,
  asset: Pick<Asset, "id">,
): Promise<{ allowed: boolean; downloadable: boolean }> {
  const allowed = await hasEffectiveGrant(permCtx, productionId, "asset", asset.id, "shares", "create")
    && await canViewAsset(permCtx, productionId, asset, "meta");
  if (!allowed) return { allowed: false, downloadable: false };
  const downloadable = await canViewAsset(permCtx, productionId, asset, "file");
  return { allowed: true, downloadable };
}

/** 分享链接创建规则："链接含下载 ⟺ 创建者持有 file@view"；项目出口策略与
 *  shares@create 资格串联；admin/owner 沿用全域门旁路。 */
export async function canCreateShareToken(
  permCtx: GrantActor,
  productionId: string,
  asset: Pick<Asset, "id">,
): Promise<{ allowed: boolean; downloadable: boolean }> {
  if (permCtx.isAdmin || permCtx.isOwner) return { allowed: true, downloadable: true };
  if (!await isPolicyOn(productionId, "policy.share_token_enabled")) {
    return { allowed: false, downloadable: false };
  }
  return canManageShareLinks(permCtx, productionId, asset);
}
