import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "finance-currency-snapshots-snapshot.json");
export type FinanceCurrencySnapshot = { productionId: string; budgetItemId: string; expenseId: string };

export const createPreMigrationData: MigrationHook<FinanceCurrencySnapshot>["createPreMigrationData"] = async ({ pool, faker, testOwner }) => {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1,$2,$3)", [productionId, "币种快照迁移", testOwner]);
  const viewId = `sv_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query(
    "INSERT INTO script_view (id, production_id, name) VALUES ($1,$2,'标准本')",
    [viewId, productionId],
  );
  await pool.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [viewId, productionId]);
  const legacy = await pool.query<{ id: string }>(
    `INSERT INTO production_budget_category (production_id, name, amount, currency, created_by)
     VALUES ($1,'差旅费',123.45,'CNY',$2) RETURNING id`,
    [productionId, testOwner],
  );
  const categoryId = `ec_${faker.string.alphanumeric(10).toLowerCase()}`;
  const budgetItemId = `bi_${faker.string.alphanumeric(10).toLowerCase()}`;
  await pool.query(
    `INSERT INTO production_expense_category (id, production_id, name, created_by)
     VALUES ($1,$2,'差旅费',$3)`,
    [categoryId, productionId, testOwner],
  );
  await pool.query(
    `INSERT INTO production_budget_item
       (id, production_id, category_id, amount, currency, legacy_category_id, created_by)
     VALUES ($1,$2,$3,123.45,'CNY',$4,$5)`,
    [budgetItemId, productionId, categoryId, legacy.rows[0].id, testOwner],
  );
  const expense = await pool.query<{ id: string }>(
    `INSERT INTO production_expense
       (production_id, budget_item_id, category_id, title, amount, currency, submitted_by, status, submitted_at)
     VALUES ($1,$2,$3,'存量差旅',88.10,'CNY',$4,'pending',now()) RETURNING id`,
    [productionId, budgetItemId, legacy.rows[0].id, testOwner],
  );
  return { productionId, budgetItemId, expenseId: expense.rows[0].id };
};

export const cleanup: MigrationHook<FinanceCurrencySnapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query("DELETE FROM production WHERE id = $1", [snapshot.productionId]);
};
