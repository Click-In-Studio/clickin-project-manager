/**
 * Pre-migration snapshot for migrate-version-retire invariance tests.
 *
 * 这支迁移删的是版本概念的存储化石：asset_version_rel 表、asset.is_universal、
 * version.name/description/tags/status（及 version_status 枚举）。真正要守的
 * 不变量只有一条：**资产文件解析不丢**——迁移前被版本 pin 住文件的资产，
 * 迁移后（latest-wins）仍然解析得到文件。version 的化石列是零读者的元数据，
 * 没有数据要迁。
 *
 * 工厂数据（旧 schema 上裸 SQL 造，当前应用代码已不写这些列/表）：
 *   · 一个演出（createProduction，对新旧 schema 都兼容）
 *   · 一个 is_universal=false 的「版本相关」资产，两份文件，
 *     asset_version_rel 把**旧文件**pin 到活跃版本——最刁钻的形态：
 *     迁移后解析必须切到 latest（新文件），且不为 null。
 *
 * isMigrationNeeded: asset_version_rel 表还在。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { createProduction } from "@/lib/db";

export const VERSION_RETIRE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "version-retire-migration-snapshot.json",
);

export type VersionRetireSnapshot = {
  prodId: string;
  versionId: string;
  assetId: string;
  /** 迁移前被 pin 到活跃版本的旧文件 */
  pinnedFileId: string;
  /** created_at 最新的文件——迁移后 latest-wins 应解析到它 */
  latestFileId: string;
};

export async function isVersionRetirePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'asset_version_rel'
  `);
  return rows.length > 0;
}

export async function createVersionRetirePreMigrationData(
  pool: Pool,
  ownerUserId: string,
): Promise<VersionRetireSnapshot> {
  const prodId = `test-verretire-${Date.now().toString(36)}`;
  await createProduction(prodId, "版本退役迁移工厂演出", ownerUserId);
  const versionId = (await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM production WHERE id = $1", [prodId],
  )).rows[0].active_version_id;

  const assetId = `ast_verretire_${Date.now().toString(36)}`;
  const pinnedFileId = `af_verretire_old`;
  const latestFileId = `af_verretire_new`;
  await pool.query(
    `INSERT INTO asset (id, production_id, uploader_user_id, asset_type, file_name, mime_type,
       is_universal, is_public, storage_type)
     VALUES ($1, $2, $3, 'reference', 'verretire.png', 'image/png', false, false, 'r2')`,
    [assetId, prodId, ownerUserId],
  );
  // asset-rest 迁移测试的全库不变量：每个 asset 的 uploader 必须有 person 归属行。
  // 裸 SQL 造的资产要自带这行，否则会把别支迁移的 integrity 层打红。
  await pool.query(
    `INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'asset', $3, '*', $2)
     ON CONFLICT DO NOTHING`,
    [prodId, ownerUserId, assetId],
  );
  await pool.query(
    `INSERT INTO asset_file (id, asset_id, r2_key, created_at)
     VALUES ($1, $3, 'r2/verretire-old', now() - interval '1 hour'),
            ($2, $3, 'r2/verretire-new', now())`,
    [pinnedFileId, latestFileId, assetId],
  );
  // 刁钻形态：pin 的是旧文件（老语义下该版本应看到旧文件）
  await pool.query(
    "INSERT INTO asset_version_rel (asset_id, version_id, asset_file_id) VALUES ($1, $2, $3)",
    [assetId, versionId, pinnedFileId],
  );

  return { prodId, versionId, assetId, pinnedFileId, latestFileId };
}
