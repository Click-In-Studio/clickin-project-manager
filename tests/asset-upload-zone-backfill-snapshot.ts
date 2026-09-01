/**
 * Pre-migration snapshot for migrate-asset-upload-zone-backfill invariance tests.
 *
 * 无谓词，setup 无条件建厂+迁移：数据回填在空库（CI）测不出"未迁移形态"，
 * 数据谓词恒 false 会让 invariance 在最需要它的 PR CI 里整段跳过；本迁移
 * 按项目 scoped 且幂等，重放对已迁移库无副作用，无条件重放是安全的。
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
  /** 幂等验证：global-setup 里第二次执行迁移 SQL 的总插入行数（应为 0）。 */
  secondRunInsertedRows?: number;
};

export async function createAssetUploadZonePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<AssetUploadZoneSnapshot> {
  const makeProd = async (): Promise<string> => {
    const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
    await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
      prodId, faker.company.name(), testUserId,
    ]);
    // 主本随建（script-view 迁移的整体性断言要求每个演出都有主本；
    // 本块排在 script-view 迁移之后，裸 production 不会再被它回填）
    const viewId = `sv_${faker.string.alphanumeric(10).toLowerCase()}`;
    await pool.query(
      "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
      [viewId, prodId],
    );
    await pool.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [viewId, prodId]);
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
