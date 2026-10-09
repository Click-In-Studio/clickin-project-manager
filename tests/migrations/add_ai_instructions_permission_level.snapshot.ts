import os from "os";
import path from "path";
import type { MigrationHookContext } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "add-ai-instructions-permission-level-snapshot.json",
);

export type AddAiInstructionsPermissionLevelSnapshot = {
  productionId: string;
  roleId: string;
  userId: string;
};

/** 迁移前造一个持制作人通配区间的存量成员，验证新增词汇不改资格来源。 */
export async function createPreMigrationData(
  { pool, faker, testUser, testOwner }: MigrationHookContext,
): Promise<AddAiInstructionsPermissionLevelSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const roleId = `role_${faker.string.alphanumeric(10).toLowerCase()}`;
  const viewId = `sv_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query(
    "INSERT INTO production (id, name, owner_id) VALUES ($1, 'AI 指令词汇迁移工厂', $2)",
    [productionId, testOwner],
  );
  await pool.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
    [viewId, productionId],
  );
  await pool.query(
    "UPDATE production SET master_view_id = $1 WHERE id = $2",
    [viewId, productionId],
  );
  await pool.query(
    "INSERT INTO production_member (production_id, user_id) VALUES ($1, $2)",
    [productionId, testUser],
  );
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '制作人')",
    [roleId, productionId],
  );
  await pool.query(
    "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, 'node:*/*@*')",
    [roleId],
  );
  await pool.query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [productionId, testUser, roleId],
  );
  return { productionId, roleId, userId: testUser };
}

export async function cleanup(
  pool: MigrationHookContext["pool"],
  snapshot: AddAiInstructionsPermissionLevelSnapshot,
) {
  await pool.query("DELETE FROM production WHERE id = $1", [snapshot.productionId]);
}
