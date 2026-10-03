import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type DropMaterialStatusSnapshot,
} from "./drop_material_status.snapshot";

let snapshot: DropMaterialStatusSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as DropMaterialStatusSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("自由状态表和物料的旧状态列已删除", async () => {
    const { rows: tables } = await getPool().query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'production_material_status'`,
    );
    expect(tables).toHaveLength(0);

    const { rows: columns } = await getPool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'production_material'
         AND column_name = 'status_id'`,
    );
    expect(columns).toHaveLength(0);
  });

  it("确定流转模型的批次和流水表仍在", async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [["production_material_stock_lot", "production_material_stock_movement"]],
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      "production_material_stock_lot",
      "production_material_stock_movement",
    ]);
  });
});

describe("integrity verification", () => {
  it("库内没有约束、视图、函数或触发器继续引用旧状态模型", async () => {
    const { rows } = await getPool().query<{ kind: string; name: string }>(
      `SELECT 'constraint' AS kind, c.conname AS name
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         LEFT JOIN pg_class f ON f.oid = c.confrelid
        WHERE r.relname = 'production_material_status'
           OR f.relname = 'production_material_status'
       UNION ALL
       SELECT 'view', viewname FROM pg_views
        WHERE schemaname = 'public' AND definition ~ 'production_material_status|status_id'
       UNION ALL
       SELECT 'function', p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ~ 'production_material_status|status_id'
       UNION ALL
       SELECT 'trigger', t.tgname FROM pg_trigger t
        WHERE NOT t.tgisinternal
          AND pg_get_triggerdef(t.oid) ~ 'production_material_status|status_id'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("删除废弃状态时保留物料本体事实", async () => {
    const { rows } = await getPool().query<{
      id: string;
      name: string;
      category: string;
      notes: string;
      created_by: string;
    }>(
      `SELECT id, name, category, notes, created_by
       FROM production_material
       WHERE name = $1 AND production_id = $2`,
      [snapshot!.material.name, snapshot!.productionId],
    );
    expect(rows).toEqual([expect.objectContaining({
      name: snapshot!.material.name,
      category: snapshot!.material.category,
      notes: snapshot!.material.notes,
      created_by: snapshot!.material.createdBy,
    })]);
    expect(rows[0].id).toMatch(/^mt_/);
  });
});
