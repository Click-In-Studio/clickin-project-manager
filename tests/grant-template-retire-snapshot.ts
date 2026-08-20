/**
 * Pre-migration snapshot for migrate-retire-grant-template invariance tests.
 *
 * 这支迁移是纯 DROP，没有数据要迁——真正要守的不变量是**收编的等价性**：
 * 表里那份模板（`role_name × permission_key`）必须在 `lib/templates/*.ts` 里
 * 一键不差地重现。故快照直接存表的全部内容，迁移测试拿它逐键比对模版常量。
 *
 * isMigrationNeeded: grant_template 表还在。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";

export const GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "grant-template-retire-migration-snapshot.json",
);

export type GrantTemplateRetireSnapshot = {
  /** 通用模板（production_type IS NULL）：角色名 → 键集。'*' 是全员基线。 */
  generic: Record<string, string[]>;
  /** per-type 行（当前线上为零行；非空则说明有 type 专属模板要一并搬）。 */
  perType: { productionType: string; roleName: string; permissionKey: string }[];
};

export async function isGrantTemplateRetirePreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'grant_template'
  `);
  return rows.length > 0;
}

export async function createGrantTemplateRetirePreMigrationData(
  pool: Pool,
): Promise<GrantTemplateRetireSnapshot> {
  const generic = await pool.query<{ role_name: string; keys: string[] }>(
    `SELECT role_name, array_agg(permission_key ORDER BY permission_key) AS keys
     FROM grant_template WHERE production_type IS NULL GROUP BY role_name`,
  );
  const perType = await pool.query<{
    production_type: string; role_name: string; permission_key: string;
  }>(
    `SELECT production_type, role_name, permission_key
     FROM grant_template WHERE production_type IS NOT NULL`,
  );
  return {
    generic: Object.fromEntries(generic.rows.map((r) => [r.role_name, r.keys])),
    perType: perType.rows.map((r) => ({
      productionType: r.production_type,
      roleName: r.role_name,
      permissionKey: r.permission_key,
    })),
  };
}
