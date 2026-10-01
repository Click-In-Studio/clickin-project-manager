import os from "node:os";
import path from "node:path";
import type { MigrationHook } from "../_support/global-setup";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "split-finance-categories-budget-items-snapshot.json");
export type SplitFinanceSnapshot = { productionId: string; legacyCategoryId: string; expenseId: string; categoryName: string };

export const createPreMigrationData: MigrationHook<SplitFinanceSnapshot>["createPreMigrationData"] = async ({ pool, faker, testOwner }) => {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1,$2,$3)", [productionId, "财务拆分迁移", testOwner]);
  const viewId = `sv_fin_${faker.string.alphanumeric(8).toLowerCase()}`;
  await pool.query("INSERT INTO script_view (id, production_id, name) VALUES ($1,$2,'标准本')", [viewId, productionId]);
  await pool.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [viewId, productionId]);
  const categoryName = `灯光租赁-${faker.string.alphanumeric(5)}`;
  const category = await pool.query<{ id: string }>(
    `INSERT INTO production_budget_category (production_id, name, amount, created_by)
     VALUES ($1,$2,0,$3) RETURNING id`, [productionId, categoryName, testOwner],
  );
  const expense = await pool.query<{ id: string }>(
    `INSERT INTO production_expense (production_id, category_id, title, amount, submitted_by, status)
     VALUES ($1,$2,'旧报销',88.00,$3,'draft') RETURNING id`, [productionId, category.rows[0].id, testOwner],
  );
  return { productionId, legacyCategoryId: category.rows[0].id, expenseId: expense.rows[0].id, categoryName };
};

export const cleanup: MigrationHook<SplitFinanceSnapshot>["cleanup"] = async (pool, snapshot) => {
  await pool.query("DELETE FROM production WHERE id = $1", [snapshot.productionId]);
};
