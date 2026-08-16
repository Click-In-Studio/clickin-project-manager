/**
 * Migration tests for migrate-wiki-default-tree.sql（存量归位默认文档树）.
 *
 * Migration path (CI): global-setup 检测"有报告但无 config 行"→ 裸 SQL 造存量
 *   （report wiki 无 parent、note wiki 无 title）→ 应用 add+migrate → 写快照。
 * Normal path (本地已迁移库): 快照不存在，invariance skipIf 跳过。
 *
 * Layers: 1 schema（config 表/锚点列） 2 integrity（锚点引用一致性）
 *         3 invariance（工厂存量归位到 报告/<event>/ 树 + note 赋题）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  WIKI_DEFAULT_TREE_SNAPSHOT_PATH,
  type WikiDefaultTreeSnapshot,
} from "./wiki-default-tree-snapshot";

let snapshot: WikiDefaultTreeSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(WIKI_DEFAULT_TREE_SNAPSHOT_PATH, "utf8")) as WikiDefaultTreeSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("production_wiki_config exists with expected columns", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_wiki_config'
    `);
    const cols = new Map(rows.map(r => [r.column_name, r.is_nullable]));
    expect(cols.get("reports_tree_enabled")).toBe("NO");
    expect(cols.get("reports_root_title")).toBe("NO");
    expect(cols.get("reports_root_wiki_id")).toBe("YES");
  });

  it("production_event.report_doc_wiki_id exists (uuid, nullable)", async () => {
    const { rows } = await getPool().query<{ data_type: string; is_nullable: string }>(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_event' AND column_name = 'report_doc_wiki_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("YES");
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("config root anchors point at wikis of the same production", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_wiki_config c
      JOIN wiki w ON w.id = c.reports_root_wiki_id
      WHERE w.production_id <> c.production_id
    `);
    expect(rows).toHaveLength(0);
  });

  it("event doc anchors point at wikis of the same production", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_event pe
      JOIN wiki w ON w.id = pe.report_doc_wiki_id
      WHERE w.production_id <> pe.production_id
    `);
    expect(rows).toHaveLength(0);
  });

  it("no enabled production with reports lacks a config row", async () => {
    const { rows } = await getPool().query(`
      SELECT DISTINCT pe.production_id
      FROM event_report er JOIN production_event pe ON pe.id = er.event_id
      WHERE NOT EXISTS (SELECT 1 FROM production_wiki_config c WHERE c.production_id = pe.production_id)
    `);
    expect(rows).toHaveLength(0);
  });
});

// ── 3. Invariance verification（快照工厂数据归位）──────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("report wiki is re-parented under 报告/<event>/", async () => {
    const s = snapshot!;
    const w = await getPool().query<{ parent_id: string | null; sort_key: string | null }>(
      `SELECT parent_id::text AS parent_id, sort_key FROM wiki WHERE id = $1::uuid`,
      [s.reportWikiId],
    );
    expect(w.rows[0].parent_id).toBeTruthy();
    expect(w.rows[0].sort_key).toBeTruthy();

    const doc = await getPool().query<{ title: string; is_public: boolean; parent_id: string | null }>(
      `SELECT title, is_public, parent_id::text AS parent_id FROM wiki WHERE id = $1::uuid`,
      [w.rows[0].parent_id!],
    );
    expect(doc.rows[0].title).toBe(s.eventTitle);
    expect(doc.rows[0].is_public).toBe(true);

    const root = await getPool().query<{ title: string; is_public: boolean; parent_id: string | null }>(
      `SELECT title, is_public, parent_id::text AS parent_id FROM wiki WHERE id = $1::uuid`,
      [doc.rows[0].parent_id!],
    );
    expect(root.rows[0].title).toBe("报告");
    expect(root.rows[0].is_public).toBe(true);
    expect(root.rows[0].parent_id).toBeNull();

    const cfg = await getPool().query<{ reports_root_wiki_id: string }>(
      `SELECT reports_root_wiki_id::text AS reports_root_wiki_id FROM production_wiki_config WHERE production_id = $1`,
      [s.prodId],
    );
    expect(cfg.rows[0].reports_root_wiki_id).toBe(doc.rows[0].parent_id);

    const ev = await getPool().query<{ report_doc_wiki_id: string }>(
      `SELECT report_doc_wiki_id::text AS report_doc_wiki_id FROM production_event WHERE id = $1`,
      [s.eventId],
    );
    expect(ev.rows[0].report_doc_wiki_id).toBe(w.rows[0].parent_id);
  });

  it.skipIf(!snapshot)("note wiki gains title '<部门> · 备注' and parents under the report wiki", async () => {
    const s = snapshot!;
    const w = await getPool().query<{ title: string | null; parent_id: string | null; sort_key: string | null }>(
      `SELECT title, parent_id::text AS parent_id, sort_key FROM wiki WHERE id = $1::uuid`,
      [s.noteWikiId],
    );
    expect(w.rows[0].title).toBe(`${s.deptName} · 备注`);
    expect(w.rows[0].parent_id).toBe(s.reportWikiId);
    expect(w.rows[0].sort_key).toBeTruthy();
  });

  it.skipIf(!snapshot)("report body/title survive the migration untouched", async () => {
    const s = snapshot!;
    const w = await getPool().query<{ title: string | null; body: string }>(
      `SELECT title, body FROM wiki WHERE id = $1::uuid`, [s.reportWikiId]);
    expect(w.rows[0].title).toBe("迁移工厂报告");
    expect(w.rows[0].body).toBe("正文");
  });
});
