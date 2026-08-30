/**
 * Migration tests for migrate-script-view.sql（#336 B2：版式搬进 script_view 表）。
 *
 *   1. Schema     — script_view 表与列、CHECK 约束、production.master_view_id 与 FK
 *   2. Integrity  — 每个演出恰有一个主本且归属一致；script_config 不再残留版式键；
 *                   page_map 的键全是本演出的 view id；迁移可重复执行
 *   3. Invariance — 版式不丢（letter/compact 原样进主本）、页码不丢（page_map 按主本
 *                   id 挂着原 letter 那份）、其余设置不动、非法值落回缺省；
 *                   loadProduction 装配出的 config 与迁移前一致
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { getMasterScriptViewId, loadPageMap, loadProduction, saveScriptConfig } from "@/lib/db";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script-types";
import { makeProduction, cleanupProduction } from "./factories";
import { SCRIPT_VIEW_SNAPSHOT_PATH, type ScriptViewSnapshot } from "./script-view-snapshot";

let snapshot: ScriptViewSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SCRIPT_VIEW_SNAPSHOT_PATH, "utf8")) as ScriptViewSnapshot;
} catch {
  snapshot = null;
}

const MIGRATION_SQL = readFileSync("db/migrate-script-view.sql", "utf8");

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("script_view 表存在，列与可空性符合预期", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string; data_type: string }>(`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'script_view'
    `);
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    for (const col of ["id", "production_id", "name", "page_layout", "text_layout_mode", "page_sequence", "template_overrides", "sort_order", "created_at"]) {
      expect(byName.get(col), `script_view.${col} 应存在`).toBeDefined();
      expect(byName.get(col)!.is_nullable, `script_view.${col} 应 NOT NULL`).toBe("NO");
    }
    expect(byName.get("id")!.data_type).toBe("text");
    expect(byName.get("page_sequence")!.data_type).toBe("jsonb");
    expect(byName.get("template_overrides")!.data_type).toBe("jsonb");
  });

  it("production.master_view_id 存在并带指向 script_view 的 FK", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'production' AND column_name = 'master_view_id'
    `);
    expect(rows).toHaveLength(1);
    const fk = await getPool().query<{ definition: string; delete_rule: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition, rc.delete_rule
      FROM pg_constraint c
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = c.conname
      WHERE c.conname = 'production_master_view_id_fkey'
    `);
    // 复合 FK：主本在库层只能指向本演出的视图
    expect(fk.rows[0]?.definition).toBe(
      "FOREIGN KEY (master_view_id, id) REFERENCES script_view(id, production_id)",
    );
    // 主本不可单独删除：FK 不带 ON DELETE
    expect(fk.rows[0]?.delete_rule).toBe("NO ACTION");
  });

  it("主本指向别的演出的视图会被库层拒绝", async () => {
    const a = await makeProduction();
    const b = await makeProduction();
    try {
      const bMaster = await getMasterScriptViewId(b.prodId);
      await expect(
        getPool().query("UPDATE production SET master_view_id = $1 WHERE id = $2", [bMaster, a.prodId]),
      ).rejects.toThrow(/foreign key|violates/i);
    } finally {
      await cleanupProduction(a.prodId).catch(() => {});
      await cleanupProduction(b.prodId).catch(() => {});
    }
  });

  it("page_layout / text_layout_mode 受 CHECK 约束", async () => {
    const { prodId } = await makeProduction();
    try {
      await expect(
        getPool().query("INSERT INTO script_view (id, production_id, page_layout) VALUES ('sv_bad1', $1, 'b5')", [prodId]),
      ).rejects.toThrow(/check/i);
      await expect(
        getPool().query("INSERT INTO script_view (id, production_id, text_layout_mode) VALUES ('sv_bad2', $1, 'sideways')", [prodId]),
      ).rejects.toThrow(/check/i);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("每个演出都有主本，且主本归属本演出", async () => {
    const orphan = await getPool().query(`
      SELECT p.id FROM production p
      LEFT JOIN script_view sv ON sv.id = p.master_view_id
      WHERE p.master_view_id IS NULL OR sv.id IS NULL OR sv.production_id <> p.id
      LIMIT 1
    `);
    expect(orphan.rows).toHaveLength(0);
  });

  it("production / version 的 script_config 不再残留版式键", async () => {
    const p = await getPool().query(`
      SELECT 1 FROM production WHERE script_config ?| ARRAY['pageLayout', 'textLayoutMode'] LIMIT 1
    `);
    expect(p.rows).toHaveLength(0);
    const v = await getPool().query(`
      SELECT 1 FROM version WHERE script_config ?| ARRAY['pageLayout', 'textLayoutMode'] LIMIT 1
    `);
    expect(v.rows).toHaveLength(0);
  });

  it("page_map 的键全部是本演出的 script_view id（无版式串残留）", async () => {
    const { rows } = await getPool().query(`
      SELECT p.id, k.key FROM production p, jsonb_object_keys(p.page_map) AS k(key)
      WHERE NOT EXISTS (SELECT 1 FROM script_view sv WHERE sv.id = k.key AND sv.production_id = p.id)
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("新建演出即带主本；迁移可重复执行且不多建视图", async () => {
    const { prodId } = await makeProduction();
    try {
      const masterId = await getMasterScriptViewId(prodId);
      expect(masterId).toBeTruthy();
      const before = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM script_view");
      await getPool().query(MIGRATION_SQL);
      const after = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM script_view");
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(await getMasterScriptViewId(prodId)).toBe(masterId);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  it("写路径自愈：主本缺席时 saveScriptConfig 补一条并落版式，再次调用不多建", async () => {
    const { prodId, versionId } = await makeProduction();
    try {
      // 造「迁移前建的演出且迁移未跑」的形态：解开指针、删掉视图
      const orig = await getMasterScriptViewId(prodId);
      await getPool().query("UPDATE production SET master_view_id = NULL WHERE id = $1", [prodId]);
      await getPool().query("DELETE FROM script_view WHERE id = $1", [orig]);
      expect(await getMasterScriptViewId(prodId)).toBeNull();

      await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, pageLayout: "letter", textLayoutMode: "compact" });
      const healed = await getMasterScriptViewId(prodId);
      expect(healed).toBeTruthy();
      expect((await loadProduction(prodId, versionId))?.state.config).toMatchObject({ pageLayout: "letter", textLayoutMode: "compact" });

      await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, pageLayout: "a4" });
      expect(await getMasterScriptViewId(prodId)).toBe(healed);
      const n = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM script_view WHERE production_id = $1", [prodId]);
      expect(n.rows[0].n).toBe("1");
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  it("主本不可单独删除（FK 挡住），删演出则级联带走", async () => {
    const { prodId } = await makeProduction();
    const masterId = await getMasterScriptViewId(prodId);
    await expect(getPool().query("DELETE FROM script_view WHERE id = $1", [masterId])).rejects.toThrow(/foreign key|violates/i);
    await cleanupProduction(prodId);
    const { rows } = await getPool().query("SELECT 1 FROM script_view WHERE id = $1", [masterId]);
    expect(rows).toHaveLength(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("letter/compact 演出：版式原样进主本，其余设置不动", async () => {
    const sv = await getPool().query<{ page_layout: string; text_layout_mode: string; name: string }>(
      `SELECT sv.page_layout, sv.text_layout_mode, sv.name
       FROM production p JOIN script_view sv ON sv.id = p.master_view_id WHERE p.id = $1`,
      [snapshot!.letterProdId],
    );
    expect(sv.rows[0]).toMatchObject({ page_layout: "letter", text_layout_mode: "compact" });
    const cfg = await getPool().query<{ script_config: Record<string, unknown> }>(
      "SELECT script_config FROM production WHERE id = $1", [snapshot!.letterProdId],
    );
    expect(cfg.rows[0].script_config).toEqual({ stageDelimOpen: "（", stageDelimClose: "）", useRehearsalMarks: false });
  });

  it.skipIf(!snapshot)("letter/compact 演出：page_map 按主本 id 挂着原 letter 那份，其余三份丢弃", async () => {
    const masterId = await getMasterScriptViewId(snapshot!.letterProdId);
    expect(await loadPageMap(snapshot!.letterProdId)).toEqual({ [masterId!]: snapshot!.letterPageMap });
  });

  it.skipIf(!snapshot)("letter/compact 演出：loadProduction 装配出的 config 与迁移前一致", async () => {
    const loaded = await loadProduction(snapshot!.letterProdId, snapshot!.letterVersionId);
    expect(loaded?.state.config).toMatchObject({
      pageLayout: "letter", textLayoutMode: "compact",
      stageDelimOpen: "（", stageDelimClose: "）", useRehearsalMarks: false,
    });
  });

  it.skipIf(!snapshot)("无版式键的演出：主本 a4/center，page_map 仍为空", async () => {
    const sv = await getPool().query<{ page_layout: string; text_layout_mode: string }>(
      `SELECT sv.page_layout, sv.text_layout_mode
       FROM production p JOIN script_view sv ON sv.id = p.master_view_id WHERE p.id = $1`,
      [snapshot!.defaultProdId],
    );
    expect(sv.rows[0]).toEqual({ page_layout: "a4", text_layout_mode: "center" });
    expect(await loadPageMap(snapshot!.defaultProdId)).toEqual({});
  });

  it.skipIf(!snapshot)("版式键为非法值的演出：落回 a4/center，旧键被剥掉，错版式的 page_map 清空", async () => {
    expect(await loadPageMap(snapshot!.invalidProdId)).toEqual({});
    const sv = await getPool().query<{ page_layout: string; text_layout_mode: string; script_config: Record<string, unknown> }>(
      `SELECT sv.page_layout, sv.text_layout_mode, p.script_config
       FROM production p JOIN script_view sv ON sv.id = p.master_view_id WHERE p.id = $1`,
      [snapshot!.invalidProdId],
    );
    expect(sv.rows[0]).toMatchObject({ page_layout: "a4", text_layout_mode: "center" });
    expect(sv.rows[0].script_config).toEqual({ useRehearsalMarks: true });
  });
});
