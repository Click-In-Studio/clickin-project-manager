import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { listMyProductionsWithRoles } from "@/lib/production/production-db";
import {
  SNAPSHOT_PATH,
  type DropProductionSortOrderSnapshot,
} from "./drop_production_sort_order.snapshot";

let snapshot: DropProductionSortOrderSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as DropProductionSortOrderSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("production.sort_order 已删除，个人排序表仍在", async () => {
    const { rows: oldColumn } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'production' AND column_name = 'sort_order'
    `);
    expect(oldColumn).toHaveLength(0);

    const { rows: orderTable } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'user_production_order'
    `);
    expect(orderTable).toHaveLength(1);
  });
});

describe("integrity verification", () => {
  it("个人排序行没有悬空用户或项目", async () => {
    const { rows } = await getPool().query(`
      SELECT upo.id
      FROM user_production_order upo
      LEFT JOIN app_user u ON u.id = upo.user_id
      LEFT JOIN production p ON p.id = upo.production_id
      WHERE u.id IS NULL OR p.id IS NULL
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("个人排序 key 全部保持合法格式", async () => {
    const { rows } = await getPool().query(`
      SELECT id FROM user_production_order
      WHERE sort_key !~ '^[0-9a-z]{10}$'
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("项目本体在删除旧排序列后原样保留", async () => {
    const { rows } = await getPool().query<{ id: string; name: string; owner_id: string }>(
      `SELECT id, name, owner_id FROM production WHERE id = ANY($1::text[]) ORDER BY id`,
      [snapshot!.productions.map((row) => row.id)],
    );
    expect(rows).toEqual(
      snapshot!.productions
        .map(({ id, name }) => ({ id, name, owner_id: snapshot!.ownerId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it.skipIf(!snapshot)("个人 lex 顺序不受旧全局排序列删除影响", async () => {
    const rows = await listMyProductionsWithRoles(snapshot!.ownerId, false, []);
    const factoryIds = new Set(snapshot!.productions.map((row) => row.id));
    expect(rows.filter((row) => factoryIds.has(row.id)).map((row) => row.id)).toEqual(
      snapshot!.orderRows.map((row) => row.productionId),
    );
  });
});
