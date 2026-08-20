/**
 * Pre-migration snapshot for migrate-wiki-default-tree invariance tests.
 *
 * isMigrationNeeded: production_wiki_config 表已在（CI harness 先应用 add 文件）
 *   且存在"有报告但无 config 行"的 production（已迁移库中所有有报告的
 *   production 都有 config 行；disabled 的有行 → 不误判）。
 * createPreMigrationData: 裸 SQL 造存量形态——report wiki 无 parent、
 *   note wiki 无 title（不能走 createEventReport，运行时会自动落位）。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const WIKI_DEFAULT_TREE_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "wiki-default-tree-migration-snapshot.json",
);

export type WikiDefaultTreeSnapshot = {
  prodId: string;
  eventId: string;
  eventTitle: string;
  reportId: string;
  reportWikiId: string;
  noteWikiId: string;
  deptName: string;
};

export async function isWikiDefaultTreePreMigrationSchema(pool: Pool): Promise<boolean> {
  const tbl = await pool.query(`SELECT to_regclass('public.production_wiki_config') AS t`);
  if (!tbl.rows[0]?.t) return false;
  const { rows } = await pool.query(`
    SELECT 1
    FROM event_report er
    JOIN production_event pe ON pe.id = er.event_id
    WHERE NOT EXISTS (
      SELECT 1 FROM production_wiki_config c WHERE c.production_id = pe.production_id
    )
    LIMIT 1
  `);
  return rows.length > 0;
}

export async function createWikiDefaultTreePreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<WikiDefaultTreeSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  const eventTitle = "迁移工厂联排";
  const deptName = "迁移工厂灯光";

  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);

  const eventId = `ev${faker.string.alphanumeric(8).toLowerCase()}`;
  await pool.query(
    `INSERT INTO production_event (id, production_id, title, created_by, status)
     VALUES ($1, $2, $3, $4, 'published')`,
    [eventId, prodId, eventTitle, testUserId],
  );

  // 存量形态 report：wiki 无 parent/sort_key
  const reportId = `rp${faker.string.alphanumeric(8).toLowerCase()}`;
  const reportWiki = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, '迁移工厂报告', '正文', $2) RETURNING id::text AS id`,
    [prodId, testUserId],
  );
  await pool.query(
    `INSERT INTO event_report (id, event_id, report_type, wiki_id) VALUES ($1, $2, 'rehearsal', $3::uuid)`,
    [reportId, eventId, reportWiki.rows[0].id],
  );

  // 存量形态 note：wiki 无 title
  const dept = await pool.query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, deptName],
  );
  const noteWiki = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, body, created_by)
     VALUES ($1, '备注内容', $2) RETURNING id::text AS id`,
    [prodId, testUserId],
  );
  await pool.query(
    `INSERT INTO event_report_note (id, report_id, department_id, wiki_id, created_via)
     VALUES ($1, $2, $3, $4::uuid, 'dept')`,
    [`rn${faker.string.alphanumeric(8).toLowerCase()}`, reportId, dept.rows[0].id, noteWiki.rows[0].id],
  );

  return {
    prodId, eventId, eventTitle, reportId,
    reportWikiId: reportWiki.rows[0].id,
    noteWikiId: noteWiki.rows[0].id,
    deptName,
  };
}
