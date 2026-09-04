import { getPool } from "../pg";
import { hasGrant, hasAnyGrant, listGrantedResourceIds } from "../grant-check";
import { type PermissionContext } from "../permissions";
import { isPolicyOn } from "../policy-db";
import { canEditWiki, listVisibleWikiIds } from "../wiki/perm";
import type { Asset } from "./db";

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
  // wiki 边：文档可见 ⇒ 正文里的图可见。批量走 listVisibleWikiIds（与
  // structurallyVisibleAssetIds 同一实现，天然不分叉），多挂载也只一趟
  const wikiMounts = mounts.filter(m => m.mount_type === "wiki");
  if (wikiMounts.length > 0) {
    const vis = await listVisibleWikiIds(permCtx, productionId);
    if (wikiMounts.some(m => vis.wildcard || vis.ids.has(m.mount_id))) return true;
  }
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
  // #236 policy.asset_public_enabled：关掉后 is_public 这条结构让渡失效，可见性只认
  // 挂载边。形状 C 天然追溯——不落行，关掉即刻收缩（M-8）。
  if (asset.isPublic && await isPolicyOn(productionId, "policy.asset_public_enabled")) return true;
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
  const visible = new Set(rows.map(r => r.asset_id));
  // wiki 边（与 canViewAsset 的 wiki 分支同源——列表与单实例判定不得分叉，批D 教训）：
  // 可见性程序化（canViewWiki），SQL 内联不了，单独一趟集合式补齐
  const wikiMounts = (await getPool().query<{ asset_id: string; mount_id: string }>(
    `SELECT asset_id, mount_id FROM asset_mount WHERE production_id = $1 AND mount_type = 'wiki'`,
    [productionId],
  )).rows;
  if (wikiMounts.length > 0) {
    const vis = await listVisibleWikiIds(permCtx, productionId);
    for (const m of wikiMounts) {
      if (vis.wildcard || vis.ids.has(m.mount_id)) visible.add(m.asset_id);
    }
  }
  return visible;
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
  // 与 canViewAsset 同源：is_public 这条让渡受 policy.asset_public_enabled 管。
  // 两处必须同读——列表与单实例判定分叉过一次（批D 教训），分叉即「列表看得见、
  // 点进去 403」。
  const publicOn = await isPolicyOn(productionId, "policy.asset_public_enabled");
  return assets.filter(a =>
    pub.wildcard || pubIds.has(a.id)
    || ((meta.wildcard || metaIds.has(a.id)) && ((a.isPublic && publicOn) || structIds.has(a.id))));
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
  // wiki 边：把图挂进文档 = 编辑该文档
  if (mountType === "wiki") return canEditWiki(permCtx, productionId, mountId);
  // version/block/block_snapshot/comment/cue/cue_revision 均属剧本流
  return hasGrant(permCtx.userId, productionId, "script", "*", "mounts", "create");
}

/**
 * 分享令牌规则："令牌含下载 ⟺ 发令牌者持有 file@view"（不能分享自己没有的能力）。
 *
 * ⚠ 那条规则管的是**不越过发令牌者自身能力**，**不是**"不越过项目意志"——上传者本人
 * 就持 file@view（C-5 发的），故它对「我上传的我就能对外发全量」零约束。项目级的出口
 * 由 policy.share_token_enabled 把守（#236 形状 C），两者**串联**：能力票 ∧ 项目开关。
 *
 * 出口为什么要单独一道：令牌受众不在 production_member 里、一行 grant 都不产生，
 * 于是 TTL 全覆盖（M-11）、退出项目全撤、POC 卸任撤销**一条都覆盖不到它**——这是
 * 全系统唯一把访问权发到权限系统之外的动作。
 *
 * 但**旁路照旧在门顶端**（§2.5 不变量：isAdmin ∨ isOwner 在每个门顶端恒真）。
 * 曾把开关放在旁路之前，理由是「旁路不该绕过项目对外的意志」——那是错的：
 * 破一次不变量就变成「除了这个门」，而且挡不住任何事（owner 被拦住转手就去把开关
 * 打开，他本来就有 config 权），纯成本零收益。owner 想分享，本身就是项目的意志。
 */
export async function canCreateShareToken(
  permCtx: PermissionContext,
  productionId: string,
  asset: Pick<Asset, "id" | "isPublic">,
): Promise<{ allowed: boolean; downloadable: boolean }> {
  if (permCtx.isAdmin || permCtx.isOwner) return { allowed: true, downloadable: true };
  // 项目关掉出口 ⇒ 普通持票人发不了（与能力票串联：能力票 ∧ 项目开关）
  if (!await isPolicyOn(productionId, "policy.share_token_enabled")) {
    return { allowed: false, downloadable: false };
  }
  const allowed = await hasGrant(permCtx.userId, productionId, "asset", asset.id, "shares", "create")
    && await canViewAsset(permCtx, productionId, asset, "meta");
  if (!allowed) return { allowed: false, downloadable: false };
  const downloadable = await canViewAsset(permCtx, productionId, asset, "file");
  return { allowed: true, downloadable };
}
