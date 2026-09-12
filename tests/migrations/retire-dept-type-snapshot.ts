/**
 * Pre-migration snapshot for migrate-retire-dept-type（#327）invariance tests.
 *
 * isMigrationNeeded: resource_permission_level 里仍有 org_dept 词汇行
 *   （迁移后这四行被删）。
 * createPreMigrationData: 裸 SQL 造并类型前的形态——org_dept 侧的授权行 / 三张区间
 *   表的节点键 / 在途申请 / 资源审批人配置，外加 dept 侧的 notes 行（验它**不动**）
 *   与一对 org_dept↔dept 撞行（验去重只留一行、不炸唯一索引）。
 *   不能走应用层 helper：代码已经全面改写成 dept，写不出 org_dept 的存量形态。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const RETIRE_DEPT_TYPE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "retire-dept-type-migration-snapshot.json",
);

export type RetireDeptTypeSnapshot = {
  prodId: string;
  deptId: string;
  roleId: string;
  userId: string;
  approvalId: string;
};

export async function isRetireDeptTypePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level WHERE resource_type = 'org_dept' LIMIT 1`,
  );
  return rows.length > 0;
}

export async function createRetireDeptTypePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<RetireDeptTypeSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);
  await pool.query(
    "INSERT INTO production_member (production_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [prodId, testUserId],
  );

  const dept = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, kind)
     VALUES ($1, '迁移工厂部门', 'dept') RETURNING id::text AS id`,
    [prodId],
  );
  const deptId = dept.rows[0].id;

  const role = await pool.query<{ id: string }>(
    `INSERT INTO production_role (id, production_id, name)
     VALUES ($1, $2, '迁移工厂角色') RETURNING id`,
    [`r${faker.string.alphanumeric(7).toLowerCase()}`, prodId],
  );
  const roleId = role.rows[0].id;

  // ① org_dept 授权行：一条通配（id='*'）、一条锚在具体部门上——验 id 位原样保留
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'org_dept', '*',  'members', 'create', 'direct'),
            ($1, $2, 'org_dept', $3,   'poc',     'create', 'direct')`,
    [prodId, testUserId, deptId],
  );

  // ② 撞行：org_dept 与 dept 各有一条同节点同动词的活行，迁移后必须只剩一条
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'org_dept', '*', 'grants', 'edit', 'direct'),
            ($1, $2, 'dept',     '*', 'grants', 'edit', 'direct')`,
    [prodId, testUserId],
  );

  // ③ notes 行（dept 侧）：本次迁移不该碰它一下
  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'dept', $3, 'notes', 'create', 'auto')`,
    [prodId, testUserId, deptId],
  );

  // ④ 三张区间表的 org_dept 节点键
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'node:org_dept/*@create')`,
    [roleId],
  );
  await pool.query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
     VALUES ($1, $2, 'node:org_dept/*/members@create', 'manual')`,
    [prodId, deptId],
  );
  await pool.query(
    `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
     VALUES ($1, $2, 'node:org_dept/*@delete', true)`,
    [prodId, testUserId],
  );

  // ⑤ 在途申请：批准时会照 resource_type 发行，死类型会发出一行谁也不读的授权
  const approval = await pool.query<{ id: string }>(
    `INSERT INTO approval_request
       (production_id, subject_id, type, resource_type, resource_id, resource_sub, permission_level, status)
     VALUES ($1, $2, 'resource_access', 'org_dept', '*', 'members', 'create', 'pending_resource')
     RETURNING id::text AS id`,
    [prodId, testUserId],
  );

  // ⑥ 资源审批人配置（#262）
  await pool.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'org_dept', '*', '*', $3)`,
    [prodId, deptId, testUserId],
  );
  await pool.query(
    `INSERT INTO resource_person_manage
       (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'org_dept', '*', '*', $2)`,
    [prodId, testUserId],
  );

  return { prodId, deptId, roleId, userId: testUserId, approvalId: approval.rows[0].id };
}
