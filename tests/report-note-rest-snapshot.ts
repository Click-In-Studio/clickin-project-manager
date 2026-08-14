/**
 * Pre-migration snapshot for migrate-report-note-rest invariance（批C PR-C2）.
 * PRE 判据：resource_permission_level 仍有 ('report','manage') 行。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const REPORT_NOTE_REST_SNAPSHOT_PATH = path.join(os.tmpdir(), "report-note-rest-migration-snapshot.json");

export type ReportNoteRestSnapshot = {
  productionId: string;
  eventId: string;
  reportId: string;
  manageUserId: string;
  atomicUserId: string;
  roleId: string;
  deptId: string;
};

export async function isReportNoteRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'report' AND permission_level = 'manage'`,
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
    [`test-rnr-${faker.string.alphanumeric(10)}`, rows[0].id, name],
  );
  return rows[0].id;
}

export async function createReportNoteRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<ReportNoteRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    productionId, `批C迁移工厂-${faker.string.alphanumeric(4)}`,
  ]);
  const eventId = `ev_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, status, created_by, start_time, end_time)
     VALUES ($1, $2, '批C事件', 'draft', $3, NOW(), NOW() + interval '1 hour')`,
    [eventId, productionId, testUserId],
  );
  const reportId = `rpt_${faker.string.alphanumeric(8)}`;
  await pool.query(
    `WITH w AS (
       INSERT INTO wiki (production_id, title, created_by) VALUES ($1, '批C报告', $3) RETURNING id
     )
     INSERT INTO event_report (id, event_id, report_type, wiki_id)
     SELECT $2, $4, 'rehearsal', w.id FROM w`,
    [productionId, reportId, testUserId, eventId],
  );

  const manageUserId = await makeUser(pool, "批C-report-manage");
  const atomicUserId = await makeUser(pool, "批C-atomic");

  await pool.query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'report', $3, '*', 'manage', 'direct', $2)`,
    [productionId, manageUserId, reportId],
  );
  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'report:create', 'self_confirmed', $2),
            ($1, $2, 'report:reply',  'self_confirmed', $2)`,
    [productionId, atomicUserId],
  );

  const roleId = `role_rnr_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批C角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'report:create'), ($1, 'report:reply')`,
    [roleId],
  );

  const deptId = (await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, permissions)
     VALUES ($1, $2, '{report:edit}') RETURNING id`,
    [productionId, `批C部门${faker.string.alphanumeric(4)}`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
     VALUES ($1, $2, 'report', $3, $4)`,
    [productionId, deptId, reportId, testUserId],
  );

  return { productionId, eventId, reportId, manageUserId, atomicUserId, roleId, deptId };
}
