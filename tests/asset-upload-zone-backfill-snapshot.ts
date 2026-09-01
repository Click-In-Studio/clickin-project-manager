/**
 * Pre-migration snapshot for migrate-asset-upload-zone-backfill invariance tests.
 *
 * isMigrationNeeded: 存在「所属项目的 dept/role 区间均不含 node:asset/*@create」
 *   的非弃用 role（批D 收紧后存量项目的形态；模版项目区间至少一处持键）。
 * createPreMigrationData: 造三个项目——
 *   legacy   区间全空（回填目标：普通 role 得键、弃用 role 不得）
 *   roleCtl  某 role 区间已持键（对照：同项目无键 role 不得被补）
 *   deptCtl  某 dept 区间已持键（对照：role 不得被补）
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const ASSET_UPLOAD_ZONE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "asset-upload-zone-backfill-migration-snapshot.json",
);

export const ASSET_UPLOAD_ZONE_KEY = "node:asset/*@create";

export type AssetUploadZoneSnapshot = {
  legacyProdId: string;
  legacyRoleId: string;
  legacyDeprecatedRoleId: string;
  roleCtlProdId: string;
  roleCtlKeylessRoleId: string;
  deptCtlProdId: string;
  deptCtlKeylessRoleId: string;
};

export async function isAssetUploadZonePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM production_role r
     WHERE NOT r.is_deprecated
       AND NOT EXISTS (
         SELECT 1 FROM production_role_permission prp
         JOIN production_role r2 ON r2.id = prp.role_id
         WHERE r2.production_id = r.production_id AND prp.permission_key = $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM production_dept_permission pdp
         WHERE pdp.production_id = r.production_id AND pdp.permission_key = $1
       )
     LIMIT 1`,
    [ASSET_UPLOAD_ZONE_KEY],
  );
  return rows.length > 0;
}

export async function createAssetUploadZonePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<AssetUploadZoneSnapshot> {
  const makeProd = async (): Promise<string> => {
    const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
    await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
      prodId, faker.company.name(), testUserId,
    ]);
    return prodId;
  };
  const makeRole = async (prodId: string, deprecated = false): Promise<string> => {
    const roleId = `role${faker.string.alphanumeric(8).toLowerCase()}`;
    await pool.query(
      "INSERT INTO production_role (id, production_id, name, is_deprecated) VALUES ($1, $2, $3, $4)",
      [roleId, prodId, faker.string.alphanumeric(10), deprecated],
    );
    return roleId;
  };

  // legacy：区间全空
  const legacyProdId = await makeProd();
  const legacyRoleId = await makeRole(legacyProdId);
  const legacyDeprecatedRoleId = await makeRole(legacyProdId, true);

  // roleCtl：一个 role 已持键 + 一个无键 role
  const roleCtlProdId = await makeProd();
  const roleCtlKeyedRoleId = await makeRole(roleCtlProdId);
  await pool.query(
    "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, $2)",
    [roleCtlKeyedRoleId, ASSET_UPLOAD_ZONE_KEY],
  );
  const roleCtlKeylessRoleId = await makeRole(roleCtlProdId);

  // deptCtl：一个 dept 已持键 + 一个无键 role
  const deptCtlProdId = await makeProd();
  const { rows: deptRows } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id",
    [deptCtlProdId, faker.string.alphanumeric(10)],
  );
  await pool.query(
    "INSERT INTO production_dept_permission (production_id, dept_id, permission_key) VALUES ($1, $2, $3)",
    [deptCtlProdId, deptRows[0].id, ASSET_UPLOAD_ZONE_KEY],
  );
  const deptCtlKeylessRoleId = await makeRole(deptCtlProdId);

  return {
    legacyProdId, legacyRoleId, legacyDeprecatedRoleId,
    roleCtlProdId, roleCtlKeylessRoleId,
    deptCtlProdId, deptCtlKeylessRoleId,
  };
}
