import { getPool } from "./pg";
import { hasGrant, hasAnyGrant, listGrantedResourceIds } from "./grant-check";
import { type PermissionContext } from "./permissions";
import type { Asset } from "./asset-db";

// ─── 批D：asset 可见性判定（隐私/公开模型）──────────────────────────────────
//
// 可见 = publication@view（越隐私：实例授权/显式通配，保留段）
//      ∨ 能力票（meta|file@view，通配=能力不是 any 实例票）
//        ∧ (is_public ∨ ∃挂载边: 宿主可见)          ← 结构让渡，永不落 grant 行
//
// 挂载 = 按方向让渡可见性给宿主可见集；推导一跳，宿主可见用该域现有判定
// （scene/script 域批E 前沿用原子键；cue 域已 REST 化用 cues@view 行）。

export type AssetFace = "meta" | "file";

/** 宿主可见锚：每种挂载点"能看到宿主的哪个面"才算接收了让渡 */
const SCRIPT_MOUNT_TYPES = ["version", "block", "block_snapshot", "comment"];
const SCENE_MOUNT_TYPES = ["scene", "scene_snapshot"];
const CUE_MOUNT_TYPES = ["cue", "cue_revision"];

async function cueMountHostVisible(
  userId: string,
  productionId: string,
  mounts: { mount_type: string; mount_id: string }[],
): Promise<boolean> {
  const cueMounts = mounts.filter(m => CUE_MOUNT_TYPES.includes(m.mount_type));
  if (cueMounts.length === 0) return false;
  const pool = getPool();
  const listRes = await pool.query<{ cue_list_id: string }>(
    `SELECT DISTINCT c.cue_list_id
     FROM cue c JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE cl.production_id = $1
       AND (c.cue_id = ANY($2::text[]) OR c.id = ANY($2::text[]))`,
    [productionId, cueMounts.map(m => m.mount_id)],
  );
  for (const row of listRes.rows) {
    if (await hasGrant(userId, productionId, "cue_list", row.cue_list_id, "cues", "view")) return true;
  }
  return false;
}

async function anyMountHostVisible(
  permCtx: PermissionContext,
  productionId: string,
  assetId: string,
): Promise<boolean> {
  const mounts = (await getPool().query<{ mount_type: string; mount_id: string }>(
    `SELECT mount_type, mount_id FROM asset_mount WHERE asset_id = $1 AND production_id = $2`,
    [assetId, productionId],
  )).rows;
  if (mounts.length === 0) return false;
  // production 根共享区：成员即接收让渡（调用方已验成员身份）
  if (mounts.some(m => m.mount_type === "production")) return true;
  if (mounts.some(m => SCRIPT_MOUNT_TYPES.includes(m.mount_type))
      && await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view")) return true;
  if (mounts.some(m => SCENE_MOUNT_TYPES.includes(m.mount_type))
      && await hasAnyGrant(permCtx.userId, productionId, "scene", ["meta"], "view")) return true;
  return cueMountHostVisible(permCtx.userId, productionId, mounts);
}

/** face="meta"=条目/预览可见；face="file"=下载/原件。 */
export async function canViewAsset(
  permCtx: PermissionContext,
  productionId: string,
  asset: Pick<Asset, "id" | "isPublic">,
  face: AssetFace,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  if (await hasGrant(permCtx.userId, productionId, "asset", asset.id, "publication", "view")) return true;
  if (!await hasGrant(permCtx.userId, productionId, "asset", asset.id, face, "view")) return false;
  if (asset.isPublic) return true;
  return anyMountHostVisible(permCtx, productionId, asset.id);
}

/** 结构面一次 SQL：该用户经挂载让渡可见的 asset id 集合（不含授权面）。 */
async function structurallyVisibleAssetIds(
  permCtx: PermissionContext,
  productionId: string,
): Promise<Set<string>> {
  const hasScriptView = await hasGrant(permCtx.userId, productionId, "script", "*", "blocks", "view");
  // E1：scene 域已行化（域级目录票；per-instance 精确化待客座授权场景出现）
  const hasSceneView = await hasAnyGrant(permCtx.userId, productionId, "scene", ["meta"], "view");
  const { rows } = await getPool().query<{ asset_id: string }>(
    `SELECT DISTINCT am.asset_id
     FROM asset_mount am
     WHERE am.production_id = $1
       AND (am.mount_type = 'production'
         OR (am.mount_type = ANY($2::text[]) AND $4)
         OR (am.mount_type = ANY($3::text[]) AND $5)
         OR (am.mount_type = ANY($6::text[]) AND EXISTS (
               SELECT 1
               FROM cue c
               JOIN production_member_grant rg
                 ON rg.resource_type = 'cue_list'
                AND rg.resource_id IN (c.cue_list_id, '*')
                AND rg.resource_sub IN ('cues', '*')
                AND rg.permission_level = 'view'
                AND rg.production_id = $1
                AND rg.user_id = $7::uuid
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
               WHERE (c.cue_id = am.mount_id OR c.id = am.mount_id)
             )))`,
    [productionId, SCRIPT_MOUNT_TYPES, SCENE_MOUNT_TYPES, hasScriptView, hasSceneView,
     CUE_MOUNT_TYPES, permCtx.userId],
  );
  return new Set(rows.map(r => r.asset_id));
}

/** 列表过滤：按可见性判定过滤 assets（与 canViewAsset(meta) 同语义的集合式实现）。 */
export async function filterVisibleAssets<T extends Pick<Asset, "id" | "isPublic">>(
  permCtx: PermissionContext,
  productionId: string,
  assets: T[],
): Promise<T[]> {
  if (permCtx.isAdmin || permCtx.isOwner || assets.length === 0) return assets;
  const [meta, pub, structIds] = await Promise.all([
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "meta", "view"),
    listGrantedResourceIds(permCtx.userId, productionId, "asset", "publication", "view"),
    structurallyVisibleAssetIds(permCtx, productionId),
  ]);
  const metaIds = new Set(meta.ids);
  const pubIds = new Set(pub.ids);
  return assets.filter(a =>
    pub.wildcard || pubIds.has(a.id)
    || ((meta.wildcard || metaIds.has(a.id)) && (a.isPublic || structIds.has(a.id))));
}

// ─── 双门（挂载=两域各自的一等动作）─────────────────────────────────────────

/** asset 侧门：挂载/解除 = 该 asset 的发布面动作 */
export async function canPublishAsset(
  permCtx: PermissionContext,
  productionId: string,
  assetId: string,
  verb: "create" | "delete",
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  return hasGrant(permCtx.userId, productionId, "asset", assetId, "publication", verb);
}

/** 宿主侧门：scene 域已行化（E1）；script/production 待批E2/F REST 化前沿用原子键 */
export async function mountHostSidePermitted(
  permCtx: PermissionContext,
  productionId: string,
  mountType: string,
  mountId: string,
): Promise<boolean> {
  if (permCtx.isAdmin || permCtx.isOwner) return true;
  if (mountType === "production") return (permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, productionId, "production", "*", "mounts", "create"));
  if (SCENE_MOUNT_TYPES.includes(mountType))
    return hasGrant(permCtx.userId, productionId, "scene", mountId, "mounts", "create");
  // version/block/block_snapshot/comment/cue/cue_revision 均属剧本流
  return hasGrant(permCtx.userId, productionId, "script", "*", "mounts", "create");
}

/** 分享令牌规则："令牌含下载 ⟺ 发令牌者持有 file@view"（不能分享自己没有的能力）。 */
export async function canCreateShareToken(
  permCtx: PermissionContext,
  productionId: string,
  asset: Pick<Asset, "id" | "isPublic">,
): Promise<{ allowed: boolean; downloadable: boolean }> {
  if (permCtx.isAdmin || permCtx.isOwner) return { allowed: true, downloadable: true };
  const allowed = await hasGrant(permCtx.userId, productionId, "asset", asset.id, "shares", "create")
    && await canViewAsset(permCtx, productionId, asset, "meta");
  if (!allowed) return { allowed: false, downloadable: false };
  const downloadable = await canViewAsset(permCtx, productionId, asset, "file");
  return { allowed: true, downloadable };
}
