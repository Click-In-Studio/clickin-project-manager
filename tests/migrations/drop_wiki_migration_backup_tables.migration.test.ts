/**
 * drop_wiki_migration_backup_tables（#606）验证。
 *
 * 三张表各是 db/legacy/ 时代一次迁移的回滚依据（migrate-node-tree.sql →
 * wiki_alias_backup_node_tree / wiki_tree_backup_node_tree；migrate-wiki-dialect-v2.sql
 * → wiki_body_backup_dialect_v2），对应工程收官后只删不迁。
 *
 * 层 1 schema：三张表消失；同批未动的邻居备份表（dialect_v2_text_backup /
 *   cue_mention_text_backup）与被备份的本体表（wiki / node）仍在。
 * 层 2 integrity：库里没有任何对象（FK / 视图 / 函数 / 触发器）再引用这三张表。
 * 层 3 invariance：不适用——纯 DROP、无数据转换、无 hook。
 */
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";

const DROPPED = [
  "wiki_alias_backup_node_tree",
  "wiki_tree_backup_node_tree",
  "wiki_body_backup_dialect_v2",
] as const;

async function existingTables(names: readonly string[]): Promise<string[]> {
  const { rows } = await getPool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [names],
  );
  return rows.map(r => r.table_name);
}

// ── 层 1：schema 验证 ─────────────────────────────────────────────────────────
describe("schema verification", () => {
  it("三张迁移回滚备份表消失", async () => {
    expect(await existingTables(DROPPED)).toEqual([]);
  });

  it("邻居备份表与被备份的本体表仍在（DROP 没带走别的）", async () => {
    const kept = ["cue_mention_text_backup", "dialect_v2_text_backup", "node", "wiki"];
    expect(await existingTables(kept)).toEqual(kept);
  });
});

// ── 层 2：完整性验证 ──────────────────────────────────────────────────────────
describe("integrity verification", () => {
  it("没有 FK 再指向这三张表", async () => {
    const { rows } = await getPool().query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.confrelid
       WHERE c.contype = 'f' AND r.relname = ANY($1::text[])`,
      [DROPPED],
    );
    expect(rows).toEqual([]);
  });

  it("视图 / 函数 / 触发器的定义里没有这三张表的名字", async () => {
    const { rows } = await getPool().query<{ kind: string; name: string }>(
      `SELECT 'view' AS kind, viewname AS name FROM pg_views
         WHERE schemaname = 'public' AND definition ~ $1
       UNION ALL
       SELECT 'function', p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~ $1
       UNION ALL
       SELECT 'trigger', t.tgname FROM pg_trigger t
         WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~ $1`,
      [DROPPED.join("|")],
    );
    expect(rows).toEqual([]);
  });
});
