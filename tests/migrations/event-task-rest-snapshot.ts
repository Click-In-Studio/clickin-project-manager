/**
 * Pre-migration snapshot for migrate-event-task-rest invariance tests（批B）.
 * PRE 判据：resource_permission_level 仍有 ('event','manage') 行。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const EVENT_TASK_REST_SNAPSHOT_PATH = path.join(
  os.tmpdir(), "event-task-rest-migration-snapshot.json",
);

export type EventTaskRestSnapshot = {
  productionId: string;
  eventId: string;
  reqId: string;
  manageUserId: string;
  assignUserId: string;
  atomicUserId: string;
  roleId: string;
  deptId: string;
};

export async function isEventTaskRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'event' AND permission_level = 'manage'`,
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
    [`test-etr-${faker.string.alphanumeric(10)}`, rows[0].id, name],
  );
  return rows[0].id;
}

export async function createEventTaskRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<EventTaskRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    productionId, `批B迁移工厂-${faker.string.alphanumeric(4)}`, testUserId,
  ]);
  const eventId = `ev_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, status, created_by, start_time, end_time)
     VALUES ($1, $2, '批B事件', 'draft', $3, NOW(), NOW() + interval '1 hour')`,
    [eventId, productionId, testUserId],
  );
  const reqId = `req_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO event_tech_req (id, event_id, title, description, status)
     VALUES ($1, $2, '批B需求', '', 'pending')`,
    [reqId, eventId],
  );

  const manageUserId = await makeUser(pool, "批B-event-manage");
  const assignUserId = await makeUser(pool, "批B-task-assign");
  const atomicUserId = await makeUser(pool, "批B-atomic");

  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'event', $4, '*', 'manage', 'direct', $2),
            ($1, $3, 'tech_req', $5, '*', 'assign', 'direct', $3)`,
    [productionId, manageUserId, assignUserId, eventId, reqId],
  );
  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'event:follow',  'self_confirmed', $2),
            ($1, $2, 'task:view_any', 'self_confirmed', $2)`,
    [productionId, atomicUserId],
  );

  const roleId = `role_etr_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批B角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'event:create'), ($1, 'event:follow'), ($1, 'task:view')`,
    [roleId],
  );

  const deptId = (await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, permissions)
     VALUES ($1, $2, '{event:edit,report:edit}') RETURNING id`,
    [productionId, `批B部门${faker.string.alphanumeric(4)}`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
     VALUES ($1, $2, 'event', $3, $4)`,
    [productionId, deptId, eventId, testUserId],
  );

  return { productionId, eventId, reqId, manageUserId, assignUserId, atomicUserId, roleId, deptId };
}
