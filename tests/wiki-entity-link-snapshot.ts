/**
 * Pre-migration snapshot for migrate-wiki-entity-link invariance tests.
 *
 * isMigrationNeeded: 旧 wiki_link 表仍存在（已迁移库中它已被 DROP）。
 * createPreMigrationData: 裸 SQL 造存量形态——两篇 wiki + 一条 wiki_link 边
 *   （不能走 createWiki/updateWiki：应用代码已改写新表 wiki_entity_link）。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const WIKI_ENTITY_LINK_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "wiki-entity-link-migration-snapshot.json",
);

export type WikiEntityLinkSnapshot = {
  prodId: string;
  sourceWikiId: string;
  targetWikiId: string;
};

export async function isWikiEntityLinkPreMigrationSchema(pool: Pool): Promise<boolean> {
  const tbl = await pool.query(`SELECT to_regclass('public.wiki_link') AS t`);
  return tbl.rows[0]?.t != null;
}

export async function createWikiEntityLinkPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<WikiEntityLinkSnapshot> {
  const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    prodId, faker.company.name(), testUserId,
  ]);

  const source = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, '迁移工厂来源', '正文', $2) RETURNING id::text AS id`,
    [prodId, testUserId],
  );
  const target = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, '迁移工厂目标', '', $2) RETURNING id::text AS id`,
    [prodId, testUserId],
  );
  await pool.query(
    `INSERT INTO wiki_link (source_wiki_id, target_wiki_id) VALUES ($1::uuid, $2::uuid)`,
    [source.rows[0].id, target.rows[0].id],
  );

  return {
    prodId,
    sourceWikiId: source.rows[0].id,
    targetWikiId: target.rows[0].id,
  };
}
