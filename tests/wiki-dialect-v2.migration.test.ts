/**
 * migrate-wiki-dialect-v2 三层验证。
 *
 * 本迁移没有 DDL，所以「层 1 schema」验的是备份表（它同时是迁移标记与回滚依据），
 * 「层 2 完整性」验全库不再残留 v1 形态，「层 3 invariance」验工厂正文迁移前后
 * **引用集合逐字相等**——只许换形态，不许增减、不许改指向。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getPool } from "@/lib/pg";
import { normalizeWikiDialect, hasLegacyDialect } from "@/lib/wiki-dialect-migrate";
import { extractMentionEdges } from "@/lib/wiki-db";
import {
  WIKI_DIALECT_V2_SNAPSHOT_PATH,
  type WikiDialectV2Snapshot,
} from "./wiki-dialect-v2-snapshot";

const pool = getPool();

function edgeKey(body: string): string {
  return extractMentionEdges(body)
    .map(e => `${e.entityType} ${e.entityId}`)
    .sort()
    .join("\n");
}

// 必须在模块求值期同步读取：it.skipIf 的条件在**收集期**求值，塞进 beforeAll
// 会让 invariance 层永远静默跳过（跑起来全绿，实际什么都没验）。
let snapshot: WikiDialectV2Snapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(WIKI_DIALECT_V2_SNAPSHOT_PATH, "utf8"),
  ) as WikiDialectV2Snapshot;
} catch {
  snapshot = null; // 本地已迁移环境：无快照，invariance 层跳过
}

// 注意：**不要** afterAll(pool.end)。getPool() 是 globalThis 单例，关掉它会把
// 同一 worker 里排在后面的 DB 测试全部带崩（曾因此出现 9 文件 45 项连带失败，
// 且随调度顺序漂移所以难复现）。池的生命周期归 tests/global-setup.ts 的 teardown。

// ── 层 1：schema 验证 ─────────────────────────────────────────────────────────
describe("schema verification", () => {
  it("备份表存在（迁移标记 + 回滚依据）", async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('wiki_body_backup_dialect_v2') IS NOT NULL AS exists",
    );
    expect(rows[0].exists).toBe(true);
  });

  it("备份表列型正确：wiki_id UUID PK / body TEXT NOT NULL", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'wiki_body_backup_dialect_v2' ORDER BY column_name`,
    );
    const byName = new Map(rows.map(r => [r.column_name, r]));
    expect(byName.get("wiki_id")?.data_type).toBe("uuid");
    expect(byName.get("body")?.data_type).toBe("text");
    expect(byName.get("body")?.is_nullable).toBe("NO");
  });

  it("本迁移不含 DDL 改动：wiki.body 仍是 TEXT NOT NULL", async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'wiki' AND column_name = 'body'`,
    );
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });
});

// ── 层 2：完整性验证 ──────────────────────────────────────────────────────────
describe("integrity verification", () => {
  it("全库 wiki.body 不再残留任何 v1 形态", async () => {
    const { rows } = await pool.query<{ id: string; title: string | null; body: string }>(
      "SELECT id::text AS id, title, body FROM wiki",
    );
    const stragglers = rows
      .filter(r => hasLegacyDialect(r.body))
      .map(r => `${r.id} ${r.title ?? "(无标题)"}`);
    expect(stragglers).toEqual([]);
  });

  it("备份表无孤儿行（FK 到 wiki，CASCADE 删除）", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wiki_body_backup_dialect_v2 b
       LEFT JOIN wiki w ON w.id = b.wiki_id WHERE w.id IS NULL`,
    );
    expect(rows[0].n).toBe("0");
  });

  it("wiki_entity_link 里没有指向 user 的边——@提及不落引用边", async () => {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM wiki_entity_link WHERE entity_type = 'user'",
    );
    expect(rows[0].n).toBe("0");
  });
});

// ── 层 3：invariance 验证（最关键）─────────────────────────────────────────────
describe("invariance verification", () => {
  it.skipIf(!snapshot)("工厂正文全部完成形态迁移", async () => {
    const ids = snapshot!.wikis.map(w => w.id);
    const { rows } = await pool.query<{ id: string; body: string }>(
      "SELECT id::text AS id, body FROM wiki WHERE id = ANY($1::uuid[])",
      [ids],
    );
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) {
      const label = snapshot!.wikis.find(w => w.id === r.id)!.label;
      expect(hasLegacyDialect(r.body), `${label} 仍含 v1 形态`).toBe(false);
    }
  });

  it.skipIf(!snapshot)("引用集合迁移前后逐字相等——只许换形态，不许增减或改指向", async () => {
    const { rows } = await pool.query<{ id: string; body: string }>(
      "SELECT id::text AS id, body FROM wiki WHERE id = ANY($1::uuid[])",
      [snapshot!.wikis.map(w => w.id)],
    );
    const after = new Map(rows.map(r => [r.id, r.body]));
    for (const w of snapshot!.wikis) {
      expect(edgeKey(after.get(w.id)!), `${w.label} 的引用集合漂移了`)
        .toBe(edgeKey(w.bodyBefore));
    }
  });

  it.skipIf(!snapshot)("备份表存的是迁移**前**的正文（回滚依据不能被覆盖）", async () => {
    const { rows } = await pool.query<{ wiki_id: string; body: string }>(
      "SELECT wiki_id::text AS wiki_id, body FROM wiki_body_backup_dialect_v2 WHERE wiki_id = ANY($1::uuid[])",
      [snapshot!.wikis.map(w => w.id)],
    );
    const backup = new Map(rows.map(r => [r.wiki_id, r.body]));
    for (const w of snapshot!.wikis) {
      expect(backup.get(w.id), `${w.label} 缺备份行`).toBe(w.bodyBefore);
    }
  });

  it.skipIf(!snapshot)("迁移结果 = 归一化函数的输出（库里的内容与代码里的规则一致）", async () => {
    const { rows } = await pool.query<{ id: string; body: string }>(
      "SELECT id::text AS id, body FROM wiki WHERE id = ANY($1::uuid[])",
      [snapshot!.wikis.map(w => w.id)],
    );
    const after = new Map(rows.map(r => [r.id, r.body]));
    for (const w of snapshot!.wikis) {
      expect(after.get(w.id), w.label).toBe(normalizeWikiDialect(w.bodyBefore));
    }
  });
});
