import { getPool } from "./pg";

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

export type AssetType =
  | "drafting" | "planogram" | "demo" | "rehearsal_video" | "reference"
  | "material" | "clip" | "qlab" | "score" | "recording";

export type StorageType = "r2" | "feishu_link";

export type MountType =
  | "production" | "version"
  | "scene" | "scene_snapshot"
  | "block" | "block_snapshot"
  | "cue" | "cue_revision"
  | "comment" | "event" | "event_schedule" | "event_tech_req" | "event_report";

export type MountMode = "inherit" | "tracking" | "version_only";

export type Asset = {
  id: string;
  productionId: string;
  uploaderOpenId: string;
  assetType: AssetType;
  name: string | null;
  fileName: string;
  mimeType: string | null;
  isUniversal: boolean;
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

export type AssetMount = {
  id: string;
  assetId: string;
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId: string | null;
  folderPath: string | null;
  mountMode: MountMode | null;
  versionResolved: boolean | null;
  createdBy: string;
  createdAt: string;
};

// ─── Row mappers ──────────────────────────────────────────────────────────────

type AssetRow = {
  id: string; production_id: string; uploader_open_id: string;
  asset_type: string; name: string | null; file_name: string; mime_type: string | null;
  is_universal: boolean; storage_type: string; feishu_url: string | null;
  created_at: Date;
};
function rowToAsset(r: AssetRow): Asset {
  return {
    id: r.id, productionId: r.production_id, uploaderOpenId: r.uploader_open_id,
    assetType: r.asset_type as AssetType, name: r.name, fileName: r.file_name, mimeType: r.mime_type,
    isUniversal: r.is_universal, storageType: r.storage_type as StorageType,
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

type AssetMountRow = {
  id: string; asset_id: string; production_id: string; mount_type: string;
  mount_id: string; mount_aux_id: string | null; folder_path: string | null;
  mount_mode: string | null; version_resolved: boolean | null;
  created_by: string; created_at: Date;
};
function rowToMount(r: AssetMountRow): AssetMount {
  return {
    id: r.id, assetId: r.asset_id, productionId: r.production_id,
    mountType: r.mount_type as MountType, mountId: r.mount_id, mountAuxId: r.mount_aux_id,
    folderPath: r.folder_path, mountMode: r.mount_mode as MountMode | null,
    versionResolved: r.version_resolved, createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

// ─── Asset CRUD ───────────────────────────────────────────────────────────────

export async function createAsset(params: {
  productionId: string;
  uploaderOpenId: string;
  assetType: AssetType;
  name?: string | null;
  fileName: string;
  mimeType: string | null;
  isUniversal: boolean;
  storageType: StorageType;
  feishuUrl?: string | null;
  r2Key?: string | null;
  thumbnailR2Key?: string | null;
  fileSize?: number | null;
  versionId?: string | null;
}): Promise<{ asset: Asset; file: AssetFile }> {
  const assetId = uid("ast");
  const fileId = uid("af");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO asset (id, production_id, uploader_open_id, asset_type, name, file_name, mime_type,
         is_universal, storage_type, feishu_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [assetId, params.productionId, params.uploaderOpenId, params.assetType, params.name ?? null,
       params.fileName, params.mimeType, params.isUniversal, params.storageType, params.feishuUrl ?? null]
    );
    const fileRes = await client.query<AssetFileRow>(
      `INSERT INTO asset_file (id, asset_id, r2_key, thumbnail_r2_key, file_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fileId, assetId, params.r2Key ?? null, params.thumbnailR2Key ?? null, params.fileSize ?? null]
    );
    if (!params.isUniversal && params.versionId) {
      await client.query(
        `INSERT INTO asset_version_rel (asset_id, version_id, asset_file_id) VALUES ($1,$2,$3)`,
        [assetId, params.versionId, fileId]
      );
    }
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

/** Resolve the asset_file for a given (asset, version) pair. */
export async function resolveAssetFile(assetId: string, versionId?: string | null): Promise<AssetFile | null> {
  const asset = await getAsset(assetId);
  if (!asset) return null;
  if (asset.isUniversal) return getLatestAssetFile(assetId);
  if (!versionId) return null;
  const res = await getPool().query<AssetFileRow>(
    `SELECT af.* FROM asset_file af
     JOIN asset_version_rel avr ON avr.asset_file_id = af.id
     WHERE avr.asset_id = $1 AND avr.version_id = $2`,
    [assetId, versionId]
  );
  return res.rows[0] ? rowToAssetFile(res.rows[0]) : null;
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

/** Upload a new file version for a versioned asset, updating the relation. */
export async function createAssetFileVersion(
  assetId: string,
  versionId: string,
  r2Key: string,
  thumbnailR2Key: string | null,
  fileSize: number | null,
): Promise<AssetFile> {
  const fileId = uid("af");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<AssetFileRow>(
      `INSERT INTO asset_file (id, asset_id, r2_key, thumbnail_r2_key, file_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fileId, assetId, r2Key, thumbnailR2Key, fileSize]
    );
    await client.query(
      `INSERT INTO asset_version_rel (asset_id, version_id, asset_file_id) VALUES ($1,$2,$3)
       ON CONFLICT (asset_id, version_id) DO UPDATE SET asset_file_id = EXCLUDED.asset_file_id`,
      [assetId, versionId, fileId]
    );
    await client.query("COMMIT");
    return rowToAssetFile(res.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Mounts ───────────────────────────────────────────────────────────────────

export async function addAssetMount(params: {
  assetId: string;
  productionId: string;
  mountType: MountType;
  mountId: string;
  mountAuxId?: string | null;
  folderPath?: string | null;
  mountMode?: MountMode | null;
  versionResolved?: boolean | null;
  createdBy: string;
}): Promise<AssetMount> {
  const id = uid("am");
  const res = await getPool().query<AssetMountRow>(
    `INSERT INTO asset_mount
       (id, asset_id, production_id, mount_type, mount_id, mount_aux_id,
        folder_path, mount_mode, version_resolved, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, params.assetId, params.productionId, params.mountType, params.mountId,
     params.mountAuxId ?? null, params.folderPath ?? null,
     params.mountMode ?? null, params.versionResolved ?? null, params.createdBy]
  );
  return rowToMount(res.rows[0]);
}

export async function removeAssetMount(mountId: string): Promise<void> {
  await getPool().query(`DELETE FROM asset_mount WHERE id = $1`, [mountId]);
}

export async function listAssetMounts(assetId: string): Promise<AssetMount[]> {
  const res = await getPool().query<AssetMountRow>(
    `SELECT * FROM asset_mount WHERE asset_id = $1 ORDER BY created_at DESC`, [assetId]
  );
  return res.rows.map(rowToMount);
}

/** Get all assets (with their mounts) at a specific mount point. */
export async function getAssetsByMountPoint(
  productionId: string,
  mountType: MountType,
  mountId: string,
  mountAuxId?: string | null
): Promise<Array<{ mount: AssetMount; asset: Asset }>> {
  const params: (string | null)[] = [productionId, mountType, mountId];
  const auxClause = mountAuxId !== undefined ? " AND mount_aux_id = $4" : "";
  if (mountAuxId !== undefined) params.push(mountAuxId ?? null);

  const mountsRes = await getPool().query<AssetMountRow>(
    `SELECT * FROM asset_mount WHERE production_id = $1 AND mount_type = $2 AND mount_id = $3${auxClause} ORDER BY created_at DESC`,
    params
  );
  if (mountsRes.rows.length === 0) return [];

  const assetIds = [...new Set(mountsRes.rows.map(r => r.asset_id))];
  const assetsRes = await getPool().query<AssetRow>(
    `SELECT * FROM asset WHERE id = ANY($1)`, [assetIds]
  );
  const byId = new Map(assetsRes.rows.map(r => [r.id, rowToAsset(r)]));

  return mountsRes.rows.flatMap(r => {
    const asset = byId.get(r.asset_id);
    return asset ? [{ mount: rowToMount(r), asset }] : [];
  });
}
