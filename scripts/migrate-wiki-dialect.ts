/**
 * wiki 正文方言 v1 → v2 全量迁移执行器。
 *
 * 从仓库根目录运行：
 *   psql "$DATABASE_URL" -f db/migrate-wiki-dialect-v2.sql   # 先建备份表
 *   npx tsx scripts/migrate-wiki-dialect.ts [--dry-run]
 *
 * 改写规则的唯一实现在 lib/wiki-dialect-migrate.ts（21 项单测护栏），本脚本
 * 只负责扫表、比对、落库、核账——不含任何形态知识。
 *
 * 幂等：normalizeWikiDialect 对 v2 正文原样返回，所以重跑只会报 0 条改写。
 *
 * ⚠️ 必须先执行 db/migrate-wiki-dialect-v2.sql：没有备份表就没有回滚依据，
 *    本脚本会直接拒绝执行。
 */
import path from "node:path";
import dotenv from "dotenv";
import { getPool } from "../lib/pg";
import { normalizeWikiDialect } from "../lib/wiki-dialect-migrate";
import { extractMentionEdges } from "../lib/wiki-db";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

/** 引用集合指纹——迁移的 invariance 断言：只许换形态，不许增减、不许改指向。 */
function edgeKey(body: string): string {
  return extractMentionEdges(body)
    .map(e => `${e.entityType} ${e.entityId}`)
    .sort()
    .join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pool = getPool();

  const guard = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('wiki_body_backup_dialect_v2') IS NOT NULL AS exists",
  );
  if (!guard.rows[0]?.exists) {
    console.error("✗ 备份表 wiki_body_backup_dialect_v2 不存在——请先执行 db/migrate-wiki-dialect-v2.sql");
    process.exit(1);
  }

  const { rows } = await pool.query<{ id: string; title: string | null; body: string }>(
    "SELECT id::text AS id, title, body FROM wiki ORDER BY created_at",
  );

  let changed = 0;
  let unchanged = 0;
  const edgeDrift: { id: string; title: string | null; before: string; after: string }[] = [];

  for (const row of rows) {
    const next = normalizeWikiDialect(row.body);
    if (next === row.body) { unchanged++; continue; }

    // 逐篇核账：引用集合必须逐字相等，否则这一篇不写、留给人看
    const before = edgeKey(row.body);
    const after = edgeKey(next);
    if (before !== after) {
      edgeDrift.push({ id: row.id, title: row.title, before, after });
      continue;
    }

    changed++;
    if (!dryRun) {
      await pool.query("UPDATE wiki SET body = $1 WHERE id = $2::uuid", [next, row.id]);
    }
  }

  console.log(`扫描 ${rows.length} 篇：改写 ${changed}，无需改写 ${unchanged}，引用漂移 ${edgeDrift.length}`);
  if (dryRun) console.log("（--dry-run，未落库）");

  if (edgeDrift.length > 0) {
    console.error("\n✗ 以下文档迁移前后引用集合不一致，已跳过，需人工处理：");
    for (const d of edgeDrift) {
      console.error(`  ${d.id} ${d.title ?? "(无标题)"}`);
      console.error(`    before: ${d.before.replace(/\n/g, " | ")}`);
      console.error(`    after : ${d.after.replace(/\n/g, " | ")}`);
    }
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  console.log("✓ 完成");
}

main().catch(err => { console.error(err); process.exit(1); });
