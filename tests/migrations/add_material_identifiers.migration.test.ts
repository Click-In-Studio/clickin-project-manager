import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import {
  SNAPSHOT_PATH,
  type AddMaterialIdentifiersSnapshot,
} from "./add_material_identifiers.snapshot";

let snapshot: AddMaterialIdentifiersSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as AddMaterialIdentifiersSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("物料主键与 lot 外键均为 TEXT，旧 code 列已删除", async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public'
          AND ((table_name='production_material' AND column_name IN ('id','code'))
            OR (table_name='production_material_stock_lot' AND column_name='material_id'))
        ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: "production_material", column_name: "id", data_type: "text" },
      { table_name: "production_material_stock_lot", column_name: "material_id", data_type: "text" },
    ]);
  });

  it("编号注册表和两级计数器存在", async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])
        ORDER BY table_name`,
      [[
        "production_material_identifier",
        "production_material_number_counter",
        "production_material_stock_code_counter",
      ]],
    );
    expect(rows.map(row => row.table_name)).toEqual([
      "production_material_identifier",
      "production_material_number_counter",
      "production_material_stock_code_counter",
    ]);
  });
});

describe("integrity verification", () => {
  it("历史占用、单一物料号和单一有效内部码均有唯一约束", async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='production_material_identifier'
        ORDER BY indexname`,
    );
    const names = rows.map(row => row.indexname);
    expect(names).toEqual(expect.arrayContaining([
      "material_identifier_material_number_idx",
      "material_identifier_lot_internal_idx",
      "production_material_identifier_token_key",
    ]));
    expect(names.some(name => name.includes("production_id_normalized_valu"))).toBe(true);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("重设内部 id 后保留物料、lot、流水和实例权限", async () => {
    const { rows: materials } = await getPool().query<{
      id: string; name: string; created_by: string;
    }>(
      `SELECT id, name, created_by FROM production_material
        WHERE production_id=$1 AND name=$2`,
      [snapshot!.productionId, snapshot!.name],
    );
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ name: snapshot!.name, created_by: snapshot!.createdBy });
    expect(materials[0].id).toMatch(/^mt_[0-9a-f]{16}$/);
    expect(materials[0].id).not.toBe(snapshot!.oldMaterialId);

    const { rows: lots } = await getPool().query<{ id: string; material_id: string }>(
      `SELECT id, material_id FROM production_material_stock_lot
        WHERE production_id=$1 AND id=$2`,
      [snapshot!.productionId, snapshot!.lotId],
    );
    expect(lots).toEqual([{ id: snapshot!.lotId, material_id: materials[0].id }]);

    const { rows: identifiers } = await getPool().query<{
      kind: string; display_value: string; token: string | null;
    }>(
      `SELECT kind, display_value, token FROM production_material_identifier
        WHERE production_id=$1 AND material_id=$2 ORDER BY kind`,
      [snapshot!.productionId, materials[0].id],
    );
    expect(identifiers).toHaveLength(2);
    expect(identifiers.find(row => row.kind === "material_number")?.display_value)
      .toMatch(/^M-\d{4,}-\d$/);
    expect(identifiers.find(row => row.kind === "internal_code"))
      .toMatchObject({ display_value: expect.stringMatching(/-S001-\d$/), token: expect.any(String) });
    expect(identifiers.some(row => row.display_value === snapshot!.oldCode)).toBe(false);

    const { rows: grants } = await getPool().query<{ resource_id: string }>(
      `SELECT resource_id FROM production_member_grant
        WHERE production_id=$1 AND resource_type='material' AND permission_level='edit'`,
      [snapshot!.productionId],
    );
    expect(grants).toContainEqual({ resource_id: materials[0].id });
  });
});
