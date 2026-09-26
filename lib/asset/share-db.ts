import { getPool } from "../pg";

export type AssetSharePerson = { userId: string; canDownload: boolean; removable: boolean };

/** 下载必须持明确的 file@view；普通 *@view 只授予正文阅读。 */
export async function listExplicitAssetDownloadIds(userId: string, productionId: string): Promise<{ wildcard: boolean; ids: string[] }> {
  const { rows } = await getPool().query<{ resource_id: string }>(
    `SELECT DISTINCT resource_id FROM production_member_grant
     WHERE production_id=$1 AND user_id=$2::uuid AND resource_type='asset'
       AND resource_sub='file' AND permission_level='view' AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > now())`,
    [productionId, userId],
  );
  const ids = rows.map(r => r.resource_id);
  return { wildcard: ids.includes("*"), ids: ids.filter(id => id !== "*") };
}

export async function hasExplicitAssetDownloadGrant(userId: string, productionId: string, assetId: string): Promise<boolean> {
  const { wildcard, ids } = await listExplicitAssetDownloadIds(userId, productionId);
  return wildcard || ids.includes(assetId);
}

/** 列实例正文读者；迁移/审批行可见但不能当成 direct 分享撤销。 */
export async function listAssetSharePeople(assetId: string, productionId: string): Promise<AssetSharePerson[]> {
  const { rows } = await getPool().query<{ user_id: string; can_download: boolean; removable: boolean }>(
    `SELECT user_id::text AS user_id,
       bool_or(resource_sub = 'file') AS can_download,
       bool_or(resource_id = $2 AND resource_sub = '*' AND grant_source = 'direct') AS removable
     FROM production_member_grant
     WHERE production_id = $1 AND resource_type = 'asset' AND resource_id IN ($2, '*')
       AND resource_sub IN ('*', 'file')
       AND permission_level = 'view' AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > now())
     GROUP BY user_id
     HAVING bool_or(resource_id = $2 AND resource_sub = '*')`,
    [productionId, assetId],
  );
  return rows.map(r => ({ userId: r.user_id, canDownload: r.can_download, removable: r.removable }));
}

/** 一次发行目录、内容和可选下载行；成员资格与发行同事务核查。 */
export async function addAssetSharePerson(
  assetId: string, productionId: string,
  args: { userId: string; canDownload: boolean; confirmedBy: string },
): Promise<"ok" | "not_member"> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const member = await client.query(
      `SELECT 1 FROM production_member WHERE production_id=$1 AND user_id=$2::uuid
       AND status='active' FOR SHARE`, [productionId, args.userId],
    );
    if (!member.rows[0]) { await client.query("ROLLBACK"); return "not_member"; }
    const subs = args.canDownload ? ["meta", "*", "file"] : ["meta", "*"];
    await client.query(
      `UPDATE production_member_grant SET is_revoked=true,revoked_reason='manual'
       WHERE production_id=$1 AND user_id=$2::uuid AND resource_type='asset' AND resource_id=$3
         AND resource_sub = ANY($4::text[]) AND permission_level='view'
         AND NOT is_revoked AND expires_at <= now()`,
      [productionId, args.userId, assetId, subs],
    );
    await client.query(
      `INSERT INTO production_member_grant
       (production_id,user_id,resource_type,resource_id,resource_sub,
        permission_level,grant_source,confirmed_by)
       SELECT $1,$2::uuid,'asset',$3,s.sub,'view','direct',$4::uuid
       FROM unnest($5::text[]) AS s(sub)
       ON CONFLICT (production_id,user_id,resource_type,resource_id,resource_sub,permission_level)
         WHERE is_revoked=false DO NOTHING`,
      [productionId, args.userId, assetId, args.confirmedBy, subs],
    );
    await client.query("COMMIT");
    return "ok";
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 撤销由个人分享发行的行，保留创建者、审批及迁移授权。 */
export async function removeAssetSharePerson(
  assetId: string, productionId: string, userId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE production_member_grant SET is_revoked=true,revoked_reason='manual'
     WHERE production_id=$1 AND user_id=$2::uuid AND resource_type='asset'
       AND resource_id=$3 AND grant_source='direct' AND NOT is_revoked
       AND resource_sub IN ('meta','*','file') AND permission_level='view'`,
    [productionId, userId, assetId],
  );
}
