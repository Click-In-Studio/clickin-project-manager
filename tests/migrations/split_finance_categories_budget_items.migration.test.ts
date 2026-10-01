import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type SplitFinanceSnapshot } from "./split_finance_categories_budget_items.snapshot";

let snapshot: SplitFinanceSnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as SplitFinanceSnapshot; } catch { snapshot = null; }

describe("schema verification", () => {
  it("建立独立费用科目、预算项与报销预算项引用", async () => {
    const tables = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
       AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [["production_budget_item", "production_expense_category"]],
    );
    expect(tables.rows.map(r => r.table_name)).toEqual(["production_budget_item", "production_expense_category"]);
    const column = await getPool().query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='production_expense' AND column_name='budget_item_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "YES" }]);
  });
});

describe("integrity verification", () => {
  it("同一部门不能重复配置同一科目，预算允许空值但不允许负数", async () => {
    const indexes = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'
       AND indexname IN ('production_budget_item_dept_unique_idx','production_budget_item_public_unique_idx')`,
    );
    expect(indexes.rows).toHaveLength(2);
    const check = await getPool().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='production_budget_item'::regclass AND contype='c'`,
    );
    expect(check.rows.some(r => r.definition.includes("amount >="))).toBe(true);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("旧科目和报销完整映射，零预算转为无上限", async () => {
    const result = await getPool().query<{ name: string; amount: string | null; legacy_category_id: string; budget_item_id: string }>(
      `SELECT c.name, bi.amount::text, bi.legacy_category_id, e.budget_item_id
       FROM production_budget_item bi
       JOIN production_expense_category c ON c.id=bi.category_id
       JOIN production_expense e ON e.id=$2
       WHERE bi.production_id=$1`, [snapshot!.productionId, snapshot!.expenseId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: snapshot!.categoryName, amount: null, legacy_category_id: snapshot!.legacyCategoryId });
    expect(result.rows[0].budget_item_id).toMatch(/^bi_/);
  });

  it.skipIf(!snapshot)("同一原子迁移为存量项目补齐默认科目，不额外生成预算项", async () => {
    const categories = await getPool().query<{ name: string }>(
      `SELECT name FROM production_expense_category
       WHERE production_id=$1 ORDER BY sort_order, name`,
      [snapshot!.productionId],
    );
    expect(categories.rows.map(row => row.name)).toEqual(expect.arrayContaining([
      "交通费", "餐饮费", "住宿费", "打印费", "运输物流费",
      "设备租赁费", "场地租赁费", "耗材采购费", "临时劳务费", "宣传推广费",
      "搭建费", "服化制作费", "道具制作费", snapshot!.categoryName,
    ]));
    const budgetItems = await getPool().query<{ category_name: string }>(
      `SELECT c.name AS category_name
       FROM production_budget_item bi
       JOIN production_expense_category c ON c.id=bi.category_id
       WHERE bi.production_id=$1`,
      [snapshot!.productionId],
    );
    expect(budgetItems.rows).toEqual([{ category_name: snapshot!.categoryName }]);
  });
});
