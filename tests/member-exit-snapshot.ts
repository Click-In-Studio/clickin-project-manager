/**
 * Pre-migration snapshot for migrate-member-exit-states.sql（#141）invariance tests.
 *
 * isMigrationNeeded: production_member 上仍有一条 CHECK 允许 'pending_exit'
 *   （#137 埋的五态枚举；迁移后收窄为 active/suspended/exited）。
 *
 * createPreMigrationData: 造出五态时代的残留形态——一条 pending_exit 成员、一条
 *   disputed 成员，各自带一条未撤销的授权行。不能走应用层 helper：代码里从来没有
 *   写入这两个值的路径（它们是死值），只能裸 SQL 造。
 *
 * 层 3 要钉的是**归一方向是冻结而不是撤销**：两条成员行必须还在、授权行必须一条
 *   都没被撤。归错方向（顺手撤权）人工推不回来——那才是这条迁移唯一会造成不可逆
 *   损失的地方。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const MEMBER_EXIT_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "member-exit-migration-snapshot.json",
);

export type MemberExitSnapshot = {
  prodId: string;
  /** 迁移前 status='pending_exit' 的成员 */
  pendingExitUserId: string;
  /** 迁移前 status='disputed' 的成员 */
  disputedUserId: string;
  /** 两人各自持有的未撤销授权行 id（验迁移不碰它们） */
  grantIds: string[];
};

/** 五态枚举是否还在——迁移后 'pending_exit' 不再出现在任何 CHECK 里。 */
export async function isMemberExitPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = 'production_member'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%pending_exit%'
      LIMIT 1`,
  );
  return rows.length > 0;
}

export async function createMemberExitPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<MemberExitSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId,
    faker.company.name(),
    testUserId,
  ]);

  const grantIds: string[] = [];
  const userIds: string[] = [];

  for (const status of ["pending_exit", "disputed"] as const) {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO app_user DEFAULT VALUES RETURNING id::text AS id",
    );
    const userId = rows[0].id;
    userIds.push(userId);

    // 五态时代的成员行：status_source 列此刻已由 add-member-exit-fields.sql 建好，
    // 但跨列不变式（active ⇔ source IS NULL）要到迁移里才装——所以这里留 NULL
    // 正是真实的存量形态。
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, status) VALUES ($1, $2, $3)",
      [prodId, userId, status],
    );

    const grant = await pool.query<{ id: string }>(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source)
       VALUES ($1, $2, 'task', '*', '*', 'view', 'migrated')
       RETURNING id::text AS id`,
      [prodId, userId],
    );
    grantIds.push(grant.rows[0].id);
  }

  return {
    prodId,
    pendingExitUserId: userIds[0],
    disputedUserId: userIds[1],
    grantIds,
  };
}
