import { getPool } from "../pg";
import { policyFilteredRows } from "../policy-db";

let _seq = 0;
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

export type { AssetType } from "./types";
import type { AssetType } from "./types";
export type StorageType = "r2" | "feishu_link";

export type Asset = {
  id: string;
  productionId: string;
  uploaderUserId: string;
  assetType: AssetType;
  name: string | null;
  fileName: string;
  mimeType: string | null;
  isPublic: boolean;
  storageType: StorageType;
  feishuUrl: string | null;
  createdAt: string;
};

export type AssetFile = {
  id: string;
  assetId: string;
  r2Key: string | null;
  thumbnailR2Key: string | null;
  fileSize: number | null;
  createdAt: string;
};

// ─── Row mappers ──────────────────────────────────────────────────────────────

export type AssetRow = {
  id: string; production_id: string; uploader_user_id: string;
  asset_type: string; name: string | null; file_name: string; mime_type: string | null;
  is_public: boolean; storage_type: string; feishu_url: string | null;
  created_at: Date;
};
export function rowToAsset(r: AssetRow): Asset {
  return {
    id: r.id, productionId: r.production_id, uploaderUserId: r.uploader_user_id,
    assetType: r.asset_type as AssetType, name: r.name, fileName: r.file_name, mimeType: r.mime_type,
    isPublic: r.is_public, storageType: r.storage_type as StorageType,
    feishuUrl: r.feishu_url, createdAt: r.created_at.toISOString(),
  };
}

type AssetFileRow = {
  id: string; asset_id: string; r2_key: string | null;
  thumbnail_r2_key: string | null; file_size: string | null; created_at: Date;
};
function rowToAssetFile(r: AssetFileRow): AssetFile {
  return {
    id: r.id, assetId: r.asset_id, r2Key: r.r2_key, thumbnailR2Key: r.thumbnail_r2_key,
    fileSize: r.file_size != null ? Number(r.file_size) : null,
    createdAt: r.created_at.toISOString(),
  };
}

// ─── Asset CRUD ───────────────────────────────────────────────────────────────

export async function createAsset(params: {
  productionId: string;
  uploaderUserId: string;
  assetType: AssetType;
  name?: string | null;
  fileName: string;
  mimeType: string | null;
  isPublic?: boolean;
  storageType: StorageType;
  feishuUrl?: string | null;
  r2Key?: string | null;
  thumbnailR2Key?: string | null;
  fileSize?: number | null;
}): Promise<{ asset: Asset; file: AssetFile }> {
  const assetId = uid("ast");
  const fileId = uid("af");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO asset (id, production_id, uploader_user_id, asset_type, name, file_name, mime_type,
         is_public, storage_type, feishu_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [assetId, params.productionId, params.uploaderUserId, params.assetType, params.name ?? null,
       params.fileName, params.mimeType, params.isPublic ?? false,
       params.storageType, params.feishuUrl ?? null]
    );
    // 创建者行集（批D，定式 C-5/§0.9）：uploader 十行 + person 归属。
    // own 键（rename/overwrite/mount/…）已退役，由此行集承担；存续按 §0.6 person 覆盖。
    // #236：uploader 行集先过策略开关。asset 无外部归属信号，其 grants@edit 由 M-14
    // 存在性子句强制保留、不在词汇表里；可配的是 *@delete / publication@c,d / shares@create。
    const uploaderRows = await policyFilteredRows(
      params.productionId, "asset", "uploader",
      [["meta", "view"], ["file", "view"],
       ["publication", "view"], ["publication", "create"], ["publication", "delete"],
       ["meta", "edit"], ["file", "create"],
       ["*", "delete"], ["shares", "create"], ["grants", "edit"]],
      client,
    );
    await client.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       SELECT $1, $2, 'asset', $3, s.sub, s.verb, 'self_confirmed', $2
       FROM UNNEST($4::text[], $5::text[]) AS s(sub, verb)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [params.productionId, params.uploaderUserId, assetId,
       uploaderRows.map((r) => r[0]), uploaderRows.map((r) => r[1])],
    );
    await client.query(
      `INSERT INTO resource_person_manage
         (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
       VALUES ($1, $2, 'asset', $3, '*', $2)
       ON CONFLICT DO NOTHING`,
      [params.productionId, params.uploaderUserId, assetId],
    );
    const fileRes = await client.query<AssetFileRow>(
      `INSERT INTO asset_file (id, asset_id, r2_key, thumbnail_r2_key, file_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fileId, assetId, params.r2Key ?? null, params.thumbnailR2Key ?? null, params.fileSize ?? null]
    );
    await client.query("COMMIT");
    const assetRes = await getPool().query<AssetRow>(`SELECT * FROM asset WHERE id = $1`, [assetId]);
    return { asset: rowToAsset(assetRes.rows[0]), file: rowToAssetFile(fileRes.rows[0]) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getAsset(assetId: string): Promise<Asset | null> {
  const res = await getPool().query<AssetRow>(`SELECT * FROM asset WHERE id = $1`, [assetId]);
  return res.rows[0] ? rowToAsset(res.rows[0]) : null;
}

export async function getAssetFile(fileId: string): Promise<AssetFile | null> {
  const res = await getPool().query<AssetFileRow>(`SELECT * FROM asset_file WHERE id = $1`, [fileId]);
  return res.rows[0] ? rowToAssetFile(res.rows[0]) : null;
}

export async function listAssets(productionId: string): Promise<Asset[]> {
  const res = await getPool().query<AssetRow>(
    `SELECT * FROM asset WHERE production_id = $1 ORDER BY created_at DESC`,
    [productionId]
  );
  return res.rows.map(rowToAsset);
}

export async function updateAsset(
  assetId: string,
  fields: { assetType?: AssetType; name?: string | null; fileName?: string }
): Promise<Asset | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (fields.assetType !== undefined) { sets.push(`asset_type = $${i++}`); vals.push(fields.assetType); }
  if (fields.name      !== undefined) { sets.push(`name = $${i++}`);       vals.push(fields.name); }
  if (fields.fileName  !== undefined) { sets.push(`file_name = $${i++}`);  vals.push(fields.fileName); }
  if (sets.length === 0) return getAsset(assetId);
  vals.push(assetId);
  const res = await getPool().query<AssetRow>(
    `UPDATE asset SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  return res.rows[0] ? rowToAsset(res.rows[0]) : null;
}

/** Delete asset and return R2 keys that should be cleaned up. */
export async function deleteAsset(assetId: string): Promise<{ r2Keys: string[] }> {
  const filesRes = await getPool().query<{ r2_key: string | null; thumbnail_r2_key: string | null }>(
    `SELECT r2_key, thumbnail_r2_key FROM asset_file WHERE asset_id = $1`, [assetId]
  );
  const r2Keys = filesRes.rows.flatMap(r =>
    [r.r2_key, r.thumbnail_r2_key].filter((k): k is string => k != null)
  );
  await getPool().query(`DELETE FROM asset WHERE id = $1`, [assetId]);
  return { r2Keys };
}

// ─── Asset file resolution ────────────────────────────────────────────────────

/** Get the latest asset_file for this asset. For universal assets only. */
export async function getLatestAssetFile(assetId: string): Promise<AssetFile | null> {
  const res = await getPool().query<AssetFileRow>(
    `SELECT * FROM asset_file WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [assetId]
  );
  return res.rows[0] ? rowToAssetFile(res.rows[0]) : null;
}

/** Resolve the asset_file for an asset — latest-wins for every asset.
 *  版本退役 Phase B：资产文件不再按版本 pin（asset_version_rel 停写，遗留行不读）。 */
export async function resolveAssetFile(assetId: string): Promise<AssetFile | null> {
  const asset = await getAsset(assetId);
  if (!asset) return null;
  return getLatestAssetFile(assetId);
}

/** Add a new file row for a universal asset (latest-wins on read). */
export async function addUniversalAssetFile(
  assetId: string,
  r2Key: string,
  thumbnailR2Key: string | null,
  fileSize: number | null,
): Promise<AssetFile> {
  const fileId = uid("af");
  const res = await getPool().query<AssetFileRow>(
    `INSERT INTO asset_file (id, asset_id, r2_key, thumbnail_r2_key, file_size)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [fileId, assetId, r2Key, thumbnailR2Key, fileSize]
  );
  return rowToAssetFile(res.rows[0]);
}
