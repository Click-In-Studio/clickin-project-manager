import os from "os";
import path from "path";
import { createProduction } from "@/lib/production/production-db";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "drop-production-sort-order-migration-snapshot.json",
);

export type DropProductionSortOrderSnapshot = {
  ownerId: string;
  productions: Array<{ id: string; name: string }>;
  orderRows: Array<{ productionId: string; sortKey: string }>;
};

export const createPreMigrationData: MigrationHook<DropProductionSortOrderSnapshot>["createPreMigrationData"] =
  async ({ pool, faker, testOwner }) => {
    const productions = [0, 1].map((index) => ({
      id: `ordcontract-${faker.string.alphanumeric(8).toLowerCase()}`,
      name: `排序列退役迁移项目 ${index + 1}`,
    }));
    for (const production of productions) {
      await createProduction(production.id, production.name, testOwner);
    }

    // 在旧 schema 上写入非默认值，证明迁移面对真实存量值时也只删除废弃列。
    await pool.query(
      `UPDATE production
       SET sort_order = CASE id WHEN $1 THEN 90 WHEN $2 THEN 10 END
       WHERE id = ANY($3::text[])`,
      [productions[0].id, productions[1].id, productions.map((row) => row.id)],
    );

    const orderRows = [
      { productionId: productions[1].id, sortKey: "1000000000" },
      { productionId: productions[0].id, sortKey: "2000000000" },
    ];
    for (const [index, row] of orderRows.entries()) {
      await pool.query(
        `INSERT INTO user_production_order (id, user_id, production_id, sort_key)
         VALUES ($1, $2, $3, $4)`,
        [`upo_contract_${faker.string.alphanumeric(8).toLowerCase()}_${index}`, testOwner, row.productionId, row.sortKey],
      );
    }

    return { ownerId: testOwner, productions, orderRows };
  };

export const cleanup: MigrationHook<DropProductionSortOrderSnapshot>["cleanup"] =
  async (pool, snapshot) => {
    await pool.query("DELETE FROM production WHERE id = ANY($1::text[])", [
      snapshot.productions.map((row) => row.id),
    ]);
  };
