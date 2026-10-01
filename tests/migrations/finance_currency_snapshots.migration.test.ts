import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type FinanceCurrencySnapshot } from "./finance_currency_snapshots.snapshot";

let snapshot: FinanceCurrencySnapshot | null = null;
try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as FinanceCurrencySnapshot; } catch { snapshot = null; }

describe("schema verification", () => {
  it("金额支持三位小数并建立本位币快照列", async () => {
    const columns = await getPool().query<{ table_name: string; column_name: string; numeric_scale: number | null }>(
      `SELECT table_name, column_name, numeric_scale
         FROM information_schema.columns
        WHERE table_schema='public'
          AND (table_name, column_name) IN (
            ('production','base_currency'),
            ('production_budget_item','base_amount'),
            ('production_budget_item','exchange_rate'),
            ('production_expense','base_amount'),
            ('production_expense','exchange_rate')
          ) ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      { table_name: "production", column_name: "base_currency", numeric_scale: null },
      { table_name: "production_budget_item", column_name: "base_amount", numeric_scale: 3 },
      { table_name: "production_expense", column_name: "base_amount", numeric_scale: 3 },
      { table_name: "production_budget_item", column_name: "exchange_rate", numeric_scale: 12 },
      { table_name: "production_expense", column_name: "exchange_rate", numeric_scale: 12 },
    ]));
  });
});

describe("integrity verification", () => {
  it("非本位币预算必须具备完整快照，草稿之外的报销也不能缺快照", async () => {
    const constraints = await getPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('production_budget_item_currency_snapshot_check','production_expense_currency_snapshot_check')
        ORDER BY conname`,
    );
    expect(constraints.rows.map(row => row.conname)).toEqual([
      "production_budget_item_currency_snapshot_check",
      "production_expense_currency_snapshot_check",
    ]);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("存量 CNY 金额无损回填为 CNY 本位币快照", async () => {
    const budget = await getPool().query<{
      currency: string; base_currency: string; amount: string; base_amount: string;
      exchange_rate: string | null; exchange_rate_date: string | null; exchange_rate_source: string | null;
    }>(
      `SELECT currency, base_currency, amount::text, base_amount::text,
              exchange_rate::text, exchange_rate_date::text, exchange_rate_source
         FROM production_budget_item WHERE id=$1`,
      [snapshot!.budgetItemId],
    );
    expect(budget.rows[0]).toEqual({
      currency: "CNY", base_currency: "CNY", amount: "123.450", base_amount: "123.450",
      exchange_rate: null, exchange_rate_date: null, exchange_rate_source: null,
    });
    const expense = await getPool().query<{ base_currency: string; amount: string; base_amount: string }>(
      "SELECT base_currency, amount::text, base_amount::text FROM production_expense WHERE id=$1",
      [snapshot!.expenseId],
    );
    expect(expense.rows[0]).toEqual({ base_currency: "CNY", amount: "88.100", base_amount: "88.100" });
  });
});
