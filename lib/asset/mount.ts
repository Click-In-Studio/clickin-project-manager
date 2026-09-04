import { getPool } from "../pg";
import { uid, rowToAsset, type Asset, type AssetRow } from "./db";

export type MountType =
  | "production" | "version"
  | "scene" | "scene_snapshot"
  | "block" | "block_snapshot"
  | "cue" | "cue_revision"
  | "comment" | "event" | "event_schedule" | "task" | "event_report"
  | "wiki";

export type MountMode = "inherit" | "tracking" | "version_only";

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
