/**
 * Pre-migration snapshot for migrate-asset-rest invariance（批D）.
 * PRE 判据：resource_permission_level 仍有 ('asset','manage') 行。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const ASSET_REST_SNAPSHOT_PATH = path.join(os.tmpdir(), "asset-rest-migration-snapshot.json");

export type AssetRestSnapshot = {
  productionId: string;
  assetId: string;
  uploaderId: string;
  manageUserId: string;
  mountUserId: string;
  atomicUserId: string;
  roleId: string;
};

export async function isAssetRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'asset' AND permission_level = 'manage'`,
  );
  return rows.length > 0;
}

async function makeUser(pool: Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO app_user (created_at) VALUES (NOW()) RETURNING id",
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW())`,
    [`test-ar-${faker.string.alphanumeric(10)}`, rows[0].id, name],
  );
  return rows[0].id;
}

export async function createAssetRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<AssetRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    productionId, `批D迁移工厂-${faker.string.alphanumeric(4)}`,
  ]);

  const uploaderId = await makeUser(pool, "批D-uploader");
  const manageUserId = await makeUser(pool, "批D-asset-manage");
  const mountUserId = await makeUser(pool, "批D-asset-mount");
  const atomicUserId = await makeUser(pool, "批D-atomic");

  const assetId = `ast_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO asset (id, production_id, uploader_user_id, asset_type, file_name, mime_type,
       is_universal, storage_type)
     VALUES ($1, $2, $3, 'reference', '批D.pdf', 'application/pdf', true, 'r2')`,
    [assetId, productionId, uploaderId],
  );

  // RG 老级别行：manage / mount
  await pool.query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'asset', $4, '*', 'manage', 'direct', $2),
            ($1, $3, 'asset', $4, '*', 'mount',  'direct', $3)`,
    [productionId, manageUserId, mountUserId, assetId],
  );

  // atomic 活跃行：能力票族 + any 族 + own 键（own 应被删除不转换）
  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'asset:view',      'self_confirmed', $2),
            ($1, $2, 'asset:download',  'self_confirmed', $2),
            ($1, $2, 'asset:share',     'self_confirmed', $2),
            ($1, $2, 'asset:mount_any', 'self_confirmed', $2),
            ($1, $2, 'asset:rename',    'self_confirmed', $2)`,
    [productionId, atomicUserId],
  );

  const roleId = `role_ar_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批D角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'asset:create'), ($1, 'asset:view_any'), ($1, 'asset:delete_any')`,
    [roleId],
  );

  return { productionId, assetId, uploaderId, manageUserId, mountUserId, atomicUserId, roleId };
}
