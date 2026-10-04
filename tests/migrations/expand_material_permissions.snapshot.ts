import os from "os";
import path from "path";
import type { MigrationHookContext } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "expand-material-permissions-snapshot.json");

export type ExpandMaterialPermissionsSnapshot = {
  productionId: string;
  roleId: string;
  deptId: string;
  userId: string;
  grantExpiresAt: string;
};

/** 无条件造四类旧权限源；空测试库也必须真实走过回填。 */
export async function createPreMigrationData(
  { pool, faker, testUser, testOwner }: MigrationHookContext,
): Promise<ExpandMaterialPermissionsSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query(
    "INSERT INTO production (id,name,owner_id) VALUES ($1,$2,$3)",
    [productionId, "物料权限迁移工厂", testOwner],
  );
  const viewId = `sv_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query("INSERT INTO script_view (id,production_id,name) VALUES ($1,$2,'标准本')", [viewId, productionId]);
  await pool.query("UPDATE production SET master_view_id=$1 WHERE id=$2", [viewId, productionId]);
  await pool.query("INSERT INTO production_member (production_id,user_id) VALUES ($1,$2)", [productionId, testUser]);

  const roleId = `role_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query(
    "INSERT INTO production_role (id,production_id,name) VALUES ($1,$2,'制作人')",
    [roleId, productionId],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id,permission_key) VALUES
      ($1,'node:material/*@edit'),($1,'node:*/*@*')`,
    [roleId],
  );

  const { rows: depts } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id,name) VALUES ($1,'道具') RETURNING id",
    [productionId],
  );
  const deptId = depts[0].id;
  await pool.query(
    `INSERT INTO production_dept_permission (production_id,dept_id,permission_key,source)
     VALUES ($1,$2,'node:material/*@edit','resource')`,
    [productionId, deptId],
  );
  await pool.query(
    `INSERT INTO production_member_permission (production_id,user_id,permission,granted)
     VALUES ($1,$2,'node:material/*@delete',false)`,
    [productionId, testUser],
  );

  const grantExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await pool.query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,
       grant_source,confirmed_by,expires_at)
     VALUES ($1,$2,'material','*','*','edit','self_confirmed',$2,$3)`,
    [productionId, testUser, grantExpiresAt],
  );
  return { productionId, roleId, deptId, userId: testUser, grantExpiresAt };
}

export async function cleanup(
  pool: MigrationHookContext["pool"], snapshot: ExpandMaterialPermissionsSnapshot,
) {
  await pool.query("DELETE FROM production WHERE id=$1", [snapshot.productionId]);
}
