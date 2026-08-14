import { getPool } from "./pg";

// 管理后台·数字资产审查（合规）：越过个人隐私列出全部未公开资产及其
// 授权面，供管理员审查与处置。读写均走治理域显式门（route 层）。

export type PrivateAssetGrant = {
  grantId: string;
  userId: string;
  userName: string;
  resourceSub: string;
  permissionLevel: string;
  grantSource: string;
};

export type PrivateAssetRow = {
  id: string;
  name: string | null;
  fileName: string;
  assetType: string;
  mimeType: string | null;
  uploaderId: string;
  uploaderName: string;
  createdAt: string;
  mountCount: number;
  grants: PrivateAssetGrant[];
};

export async function listPrivateAssets(productionId: string): Promise<PrivateAssetRow[]> {
  const pool = getPool();
  const [assetsRes, grantsRes] = await Promise.all([
    pool.query<{
      id: string; name: string | null; file_name: string; asset_type: string; mime_type: string | null;
      uploader_user_id: string; uploader_name: string | null; created_at: Date; mount_count: string;
    }>(
      `SELECT a.id, a.name, a.file_name, a.asset_type, a.mime_type,
              a.uploader_user_id, up.name AS uploader_name, a.created_at,
              (SELECT COUNT(*) FROM asset_mount m WHERE m.asset_id = a.id)::text AS mount_count
       FROM asset a
       LEFT JOIN user_profile up ON up.user_id = a.uploader_user_id
       WHERE a.production_id = $1 AND NOT a.is_public
       ORDER BY a.created_at DESC`,
      [productionId],
    ),
    pool.query<{
      id: string; resource_id: string; user_id: string; user_name: string | null;
      resource_sub: string; permission_level: string; grant_source: string;
    }>(
      `SELECT g.id, g.resource_id, g.user_id, up.name AS user_name,
              g.resource_sub, g.permission_level, g.grant_source
       FROM production_member_grant g
       LEFT JOIN user_profile up ON up.user_id = g.user_id
       WHERE g.production_id = $1 AND g.resource_type = 'asset' AND g.resource_id <> '*'
         AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())
       ORDER BY up.name NULLS LAST`,
      [productionId],
    ),
  ]);

  const grantsByAsset = new Map<string, PrivateAssetGrant[]>();
  for (const g of grantsRes.rows) {
    const list = grantsByAsset.get(g.resource_id) ?? [];
    list.push({
      grantId: g.id,
      userId: g.user_id,
      userName: g.user_name ?? "",
      resourceSub: g.resource_sub,
      permissionLevel: g.permission_level,
      grantSource: g.grant_source,
    });
    grantsByAsset.set(g.resource_id, list);
  }

  return assetsRes.rows.map(a => ({
    id: a.id,
    name: a.name,
    fileName: a.file_name,
    assetType: a.asset_type,
    mimeType: a.mime_type,
    uploaderId: a.uploader_user_id,
    uploaderName: a.uploader_name ?? "",
    createdAt: a.created_at.toISOString(),
    mountCount: Number(a.mount_count),
    grants: grantsByAsset.get(a.id) ?? [],
  }));
}

export type AssetGrantRevokeResult = "ok" | "not_found" | "wrong_type";

/** 审查处置：撤销资产类授权（本门不可越界撤销其他类型 grant）。 */
export async function revokeAssetGrant(productionId: string, grantId: string): Promise<AssetGrantRevokeResult> {
  const check = await getPool().query<{ resource_type: string; is_revoked: boolean }>(
    "SELECT resource_type, is_revoked FROM production_member_grant WHERE id = $1 AND production_id = $2",
    [grantId, productionId],
  );
  const row = check.rows[0];
  if (!row || row.is_revoked) return "not_found";
  if (row.resource_type !== "asset") return "wrong_type";
  await getPool().query(
    `UPDATE production_member_grant SET is_revoked = true, revoked_reason = 'manual'
     WHERE id = $1 AND production_id = $2 AND NOT is_revoked`,
    [grantId, productionId],
  );
  return "ok";
}

/** 审查处置：改公开性。返回 false = 资产不存在。 */
export async function setAssetPublic(productionId: string, assetId: string, isPublic: boolean): Promise<boolean> {
  const res = await getPool().query(
    "UPDATE asset SET is_public = $3 WHERE id = $1 AND production_id = $2 RETURNING id",
    [assetId, productionId, isPublic],
  );
  return (res.rowCount ?? 0) > 0;
}
