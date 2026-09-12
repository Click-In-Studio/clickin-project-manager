/**
 * Pre-migration snapshot for migrate-wiki-dialect-v2 invariance。
 *
 * PRE 判据：备份表 wiki_body_backup_dialect_v2 尚不存在。
 * 本迁移没有 DDL（纯 DML 正文改写），所以判据不能用列的存在性——备份表由
 * migrate-wiki-dialect-v2.sql 建立，它同时就是「已迁移」的标记。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const WIKI_DIALECT_V2_SNAPSHOT_PATH =
  path.join(os.tmpdir(), "wiki-dialect-v2-migration-snapshot.json");

export type WikiDialectV2Snapshot = {
  productionId: string;
  /** wikiId → 迁移前的引用集合指纹（`entityType entityId` 排序后换行拼接） */
  wikis: { id: string; label: string; bodyBefore: string }[];
};

export async function isWikiDialectV2PreMigration(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('wiki_body_backup_dialect_v2') IS NULL AS exists",
  );
  return rows[0]?.exists === true;
}

/** 覆盖全部 v1 形态的工厂正文——每一条都对应 §2.4/§3.5/§5.2 迁移映射表的一行。 */
function legacyBodies(targetWikiId: string): { label: string; body: string }[] {
  const sceneId = `sc_${faker.string.alphanumeric(8)}`;
  const blockId = `blk_${faker.string.alphanumeric(8)}`;
  const cueId = `cue_${faker.string.alphanumeric(8)}`;
  const assetId = `as_${faker.string.alphanumeric(8)}`;
  const userId = `u_${faker.string.alphanumeric(8)}`;
  return [
    { label: "wiki 链接（旧 href 形态）", body: `见 [#](/__cm__wiki:${targetWikiId}) 一节。` },
    { label: "wiki 裸 token（废弃形态）", body: `参考 [#wiki:${targetWikiId}] 的说明。` },
    { label: "带 label 的场次引用", body: `[#1-1 开场](/__cm__scene:${sceneId}) 需要复排。` },
    { label: "block.<mode> 点号语法", body: `[#p.4-2](/__cm__block.page:${blockId}) 这一段。` },
    { label: "cue 引用", body: `[#LX.1](/__cm__cue:${cueId}) 提前 2 秒。` },
    { label: "asset + aux 位置参数", body: `[图纸](/__cm__asset:${assetId}:scene) 见附件。` },
    { label: "@提及旧 uid: scheme", body: `辛苦 [@张三](uid:${userId}) 跟进。` },
    { label: "@提及更旧形态", body: `@[李四](uid:${userId}) 请确认。` },
    { label: "图片嵌入", body: `![剧照.jpg](/__cm__asset:${assetId})` },
    { label: "callout 管道参数", body: `> [!🍰|#fff5eb]\n> 注意事项` },
    { label: "混合正文（多形态同篇）", body:
      `# 章节\n\n[#](/__cm__wiki:${targetWikiId}) 与 [#x](/__cm__scene:${sceneId})，`
      + `图 ![p](/__cm__asset:${assetId})，@ [@王五](uid:${userId})。\n\n`
      + "> [!📌|#abc]\n> 提示\n\n"
      + "```\n[#](/__cm__wiki:not-a-real-ref)\n```\n" },
  ];
}

export async function createWikiDialectV2PreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<WikiDialectV2Snapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    productionId, `方言v2迁移工厂-${faker.string.alphanumeric(4)}`, testUserId,
  ]);

  // 先建一篇当作链接目标，后续正文都指向它
  const target = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [productionId, "迁移工厂-目标文档", "目标正文", testUserId],
  );
  const targetId = target.rows[0].id;

  const wikis: WikiDialectV2Snapshot["wikis"] = [];
  for (const { label, body } of legacyBodies(targetId)) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, body, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [productionId, `迁移工厂-${label}`, body, testUserId],
    );
    wikis.push({ id: r.rows[0].id, label, bodyBefore: body });
  }

  return { productionId, wikis };
}
