/**
 * Migration tests for migrate-wiki-entity-link.sql（wiki_link → wiki_entity_link）.
 *
 * Migration path (CI): global-setup 检测 wiki_link 表仍在 → 裸 SQL 造两篇 wiki
 *   + 一条 wiki_link 边 → 应用迁移 → 写快照。
 * Normal path (本地已迁移库): 快照不存在，invariance skipIf 跳过。
 *
 * Layers: 1 schema（新表列/旧表消失） 2 integrity（无孤儿 wiki_id、origin 词表）
 *         3 invariance（存量 wiki→wiki 边平移为 entity_type='wiki' 行）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  WIKI_ENTITY_LINK_SNAPSHOT_PATH,
  type WikiEntityLinkSnapshot,
} from "./wiki-entity-link-snapshot";

let snapshot: WikiEntityLinkSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(WIKI_ENTITY_LINK_SNAPSHOT_PATH, "utf8")) as WikiEntityLinkSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("wiki_entity_link exists with expected columns", async () => {
    const { rows } = await getPool().query<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'wiki_entity_link'
    `);
    const cols = new Map(rows.map(r => [r.column_name, r]));
    expect(cols.get("wiki_id")?.data_type).toBe("uuid");
    expect(cols.get("wiki_id")?.is_nullable).toBe("NO");
    expect(cols.get("production_id")?.data_type).toBe("text");
    expect(cols.get("entity_type")?.data_type).toBe("text");
    expect(cols.get("entity_id")?.data_type).toBe("text");
    expect(cols.get("origin")?.is_nullable).toBe("NO");
    expect(cols.get("created_by")?.is_nullable).toBe("YES");
  });

  it("old wiki_link table is gone", async () => {
    const { rows } = await getPool().query(`SELECT to_regclass('public.wiki_link') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it("reverse-lookup index exists", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'wiki_entity_link_entity_idx'`);
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no orphan wiki_id (FK side of the edge)", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM wiki_entity_link l
      WHERE NOT EXISTS (SELECT 1 FROM wiki w WHERE w.id = l.wiki_id)
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_id agrees with the source wiki's production", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM wiki_entity_link l
      JOIN wiki w ON w.id = l.wiki_id
      WHERE w.production_id <> l.production_id
    `);
    expect(rows).toHaveLength(0);
  });

  it("origin values stay within the vocabulary", async () => {
    const { rows } = await getPool().query(`
      SELECT DISTINCT origin FROM wiki_entity_link
      WHERE origin NOT IN ('wiki_body', 'manual')
    `);
    expect(rows).toHaveLength(0);
  });
});

// ── 3. Invariance verification（快照工厂数据平移）─────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("legacy wiki→wiki edge maps to entity_type='wiki' row", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ production_id: string; entity_id: string; origin: string }>(
      `SELECT production_id, entity_id, origin FROM wiki_entity_link
       WHERE wiki_id = $1::uuid AND entity_type = 'wiki'`,
      [s.sourceWikiId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].production_id).toBe(s.prodId);
    expect(rows[0].entity_id).toBe(s.targetWikiId);
    expect(rows[0].origin).toBe("wiki_body");
  });

  it.skipIf(!snapshot)("both factory wikis survive the migration untouched", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM wiki WHERE id = ANY($1::uuid[]) ORDER BY title`,
      [[s.sourceWikiId, s.targetWikiId]],
    );
    expect(rows.map(r => r.title)).toEqual(["迁移工厂来源", "迁移工厂目标"]);
  });
});
