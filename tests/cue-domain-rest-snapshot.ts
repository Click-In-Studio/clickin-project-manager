/**
 * Pre-migration snapshot for migrate-cue-domain-rest invariance tests（批A）.
 *
 * isCueDomainRestPreMigrationSchema: true when resource_permission_level still
 * has the ('cue_list','manage') legacy level row（迁移后被删除）.
 *
 * createCueDomainRestPreMigrationData: inserts, on the PRE schema:
 *   - a production + cue list
 *   - a user holding a legacy production_member_grant 'manage' row on that list
 *   - a user holding a legacy production_member_grant 'edit' row
 *   - a user with active atomic grants: cue_list:view + cue:comment + cue_list:rename_any
 *   - a production role holding cue keys in production_role_permission
 *     (cue_list:view / cue_list:create / cue_list:delete[base,无转换])
 *
 * Invariance layer verifies the 拆解/转换 mapping after migration.
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const CUE_DOMAIN_REST_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "cue-domain-rest-migration-snapshot.json",
);

export type CueDomainRestSnapshot = {
  productionId: string;
  cueListId: string;
  manageUserId: string;
  editUserId: string;
  atomicUserId: string;
  roleId: string;
  deptId: string;
};

export async function isCueDomainRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'cue_list' AND permission_level = 'manage'`,
  );
  return rows.length > 0;
}

async function makeUser(pool: Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO app_user (created_at) VALUES (NOW()) RETURNING id",
  );
  const userId = rows[0].id;
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW())`,
    [`test-cdr-${faker.string.alphanumeric(10)}`, userId, name],
  );
  return userId;
}

export async function createCueDomainRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<CueDomainRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const cueListId = `cl_${faker.string.alphanumeric(8).toLowerCase()}`;

  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    productionId, `批A迁移工厂-${faker.string.alphanumeric(4)}`,
  ]);
  await pool.query(
    "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, '迁移表', '', $3)",
    [cueListId, productionId, testUserId],
  );

  const manageUserId = await makeUser(pool, "批A-manage持有者");
  const editUserId = await makeUser(pool, "批A-edit持有者");
  const atomicUserId = await makeUser(pool, "批A-atomic持有者");

  // 旧级别 production_member_grant 行
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'cue_list', $4, '*', 'manage', 'direct', $2),
            ($1, $3, 'cue_list', $4, '*', 'edit',   'direct', $3)`,
    [productionId, manageUserId, editUserId, cueListId],
  );

  // 激活的 atomic 行（读键 + _any 写键）
  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'cue_list:view',       'self_confirmed', $2),
            ($1, $2, 'cue:comment',         'self_confirmed', $2),
            ($1, $2, 'cue_list:rename_any', 'self_confirmed', $2)`,
    [productionId, atomicUserId],
  );

  // 角色的 cue 键（view→节点串转换；create→集合键；delete=base 写键→无转换）
  const roleId = `role_cdr_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批A角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'cue_list:view'), ($1, 'cue_list:create'), ($1, 'cue_list:delete')`,
    [roleId],
  );

  // dept 伪键：'cue_list:edit' 数组项 + rdm 管理该表 → 迁移应产出实例级 dept 区间行
  const deptId = (await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, permissions)
     VALUES ($1, $2, '{cue_list:edit,event:edit}') RETURNING id`,
    [productionId, `批A部门${faker.string.alphanumeric(4)}`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
     VALUES ($1, $2, 'cue_list', $3, $4)`,
    [productionId, deptId, cueListId, testUserId],
  );

  return { productionId, cueListId, manageUserId, editUserId, atomicUserId, roleId, deptId };
}
