import { getPool } from "../pg";
import { policyFilteredRows } from "../policy-db";
import { insertNode } from "../node/db";
import { ensureAssetsRootAnchor } from "../node/anchors";

let _seq = 0;
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

export type { AssetType } from "./types";
import type { AssetType } from "./types";
export type StorageType = "r2" | "feishu_link";

// is_public 已随 #420 迁到 node 壳上（asset 列已删）——语义不变：只免除结构面
// 要求、仍需能力票（lib/asset/perm.ts）。
export type Asset = {
  id: string;
  productionId: string;
  uploaderUserId: string;
  assetType: AssetType;
  name: string | null;
  fileName: string;
  mimeType: string | null;
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
  storage_type: string; feishu_url: string | null;
  created_at: Date;
};
export function rowToAsset(r: AssetRow): Asset {
  return {
    id: r.id, productionId: r.production_id, uploaderUserId: r.uploader_user_id,
    assetType: r.asset_type as AssetType, name: r.name, fileName: r.file_name, mimeType: r.mime_type,
    storageType: r.storage_type as StorageType,
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
  /** 壳节点落点（node id）。缺省＝「资产」根（懒建）。第二批的缺省落点机制
   *  （业务上下文自动归档）在此参数之上生长。 */
  nodeParentId?: string | null;
  /** 树可枚举性。缺省 false＝私有（原「无 production mount」语义）；true＝
   *  全员可枚举（原「项目全局」共享区语义）。 */
  listable?: boolean;
}): Promise<{ asset: Asset; file: AssetFile; nodeId: string }> {
  const assetId = uid("ast");
  const fileId = uid("af");
  const client = await getPool().connect();
  let nodeId: string;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO asset (id, production_id, uploader_user_id, asset_type, name, file_name, mime_type,
         storage_type, feishu_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [assetId, params.productionId, params.uploaderUserId, params.assetType, params.name ?? null,
       params.fileName, params.mimeType,
       params.storageType, params.feishuUrl ?? null]
    );
    // 壳节点与内容行同事务（1:1 不变量不许有窗口）；父缺省=「资产」根懒建
    const parentId = params.nodeParentId ?? await ensureAssetsRootAnchor(params.productionId, client);
    nodeId = await insertNode({
      productionId: params.productionId, kind: "asset",
      parentId, sortKey: null, assetId,
      listable: params.listable ?? false, isPublic: params.isPublic ?? false,
      createdBy: params.uploaderUserId,
    }, client);
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
    return { asset: rowToAsset(assetRes.rows[0]), file: rowToAssetFile(fileRes.rows[0]), nodeId };
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

// ─── 工作台读面（#420 第二批 PR-C）────────────────────────────────────────────

/** 每个 asset 壳节点的祖先链标题（「在树里哪儿」）。纯函数：入参就是
 *  listNodeLibrary 的产物，displayTitle 已解析，走链零额外查询；环/断链
 *  由深度上限兜底。 */
export function assetTreePaths(
  library: { id: string; parentId: string | null; assetId: string | null; displayTitle: string | null }[],
): Map<string, string[]> {
  const byId = new Map(library.map(n => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const n of library) {
    if (!n.assetId) continue;
    const path: string[] = [];
    let cur = n;
    for (let i = 0; cur.parentId && i < 20; i++) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      path.unshift(parent.displayTitle ?? "（无标题）");
      cur = parent;
    }
    out.set(n.assetId, path);
  }
  return out;
}

/** 按 asset 聚合文件占用 + 全 production 客观占用（#429 最简形态：现查不物化）。
 *  口径：**全部** asset_file 行（含暂不可达的历史版本，与 #428 回收联动，修完
 *  趋同）；file_size 为 NULL 的存量行不计入字节、计入 unknownFiles。未来计费/
 *  limit 消费方注意这不是「可回收后的活跃占用」。 */
export async function assetSizeStats(productionId: string): Promise<{
  sizeByAsset: Map<string, number>;
  totalBytes: number;
  unknownFiles: number;
}> {
  const { rows } = await getPool().query<{ asset_id: string; bytes: string | null; unknown: string }>(
    `SELECT af.asset_id, sum(af.file_size)::bigint::text AS bytes,
            count(*) FILTER (WHERE af.file_size IS NULL)::text AS unknown
     FROM asset_file af JOIN asset a ON a.id = af.asset_id
     WHERE a.production_id = $1 GROUP BY af.asset_id`,
    [productionId],
  );
  const sizeByAsset = new Map<string, number>();
  let totalBytes = 0, unknownFiles = 0;
  for (const r of rows) {
    if (r.bytes != null) sizeByAsset.set(r.asset_id, Number(r.bytes));
    totalBytes += Number(r.bytes ?? 0);
    unknownFiles += Number(r.unknown);
  }
  return { sizeByAsset, totalBytes, unknownFiles };
}
