import type { PoolClient } from "pg";
import { getPool } from "../pg";
import {
  convertToBaseAmount, formatCurrencyLabel, isCurrencyCode, isExchangeRate, isMoneyAmount, normalizeMoneyAmount,
  type CurrencyCode,
} from "../money";
import { FinanceError, isExpenseDate } from "./expense-read-db";

export type CurrencySnapshotInput = {
  currency: string;
  exchangeRate?: string | null;
  exchangeRateDate?: string | null;
  exchangeRateSource?: string | null;
};

export type CurrencySnapshot = {
  currency: CurrencyCode;
  baseCurrency: CurrencyCode;
  baseAmount: string;
  exchangeRate: string | null;
  exchangeRateDate: string | null;
  exchangeRateSource: string | null;
};

export async function getProductionBaseCurrency(productionId: string): Promise<CurrencyCode> {
  const result = await getPool().query<{ base_currency: string }>(
    "SELECT base_currency FROM production WHERE id = $1",
    [productionId],
  );
  const currency = result.rows[0]?.base_currency;
  if (!isCurrencyCode(currency)) throw new FinanceError("invalid_state", "项目本位币无效");
  return currency;
}

async function lockedBaseCurrency(client: PoolClient, productionId: string): Promise<CurrencyCode> {
  const result = await client.query<{ base_currency: string }>(
    "SELECT base_currency FROM production WHERE id = $1 FOR SHARE",
    [productionId],
  );
  const currency = result.rows[0]?.base_currency;
  if (!isCurrencyCode(currency)) throw new FinanceError("invalid_state", "项目本位币无效");
  return currency;
}

export async function buildCurrencySnapshot(
  client: PoolClient,
  productionId: string,
  amount: string,
  input: CurrencySnapshotInput,
  options: { fromStorage?: boolean } = {},
): Promise<CurrencySnapshot> {
  if (!isCurrencyCode(input.currency)) throw new FinanceError("invalid_state", "请选择有效币种");
  const normalizedAmount = normalizeMoneyAmount(amount, input.currency);
  if ((!options.fromStorage && !isMoneyAmount(amount, input.currency))
      || !isMoneyAmount(normalizedAmount, input.currency))
    throw new FinanceError("invalid_state", `金额小数位不符合${formatCurrencyLabel(input.currency)}的规则`);
  const baseCurrency = await lockedBaseCurrency(client, productionId);
  if (input.currency === baseCurrency) {
    return {
      currency: input.currency, baseCurrency, baseAmount: normalizedAmount,
      exchangeRate: null, exchangeRateDate: null, exchangeRateSource: null,
    };
  }
  const rate = input.exchangeRate?.trim() ?? "";
  const date = input.exchangeRateDate?.trim() ?? "";
  const source = input.exchangeRateSource?.trim() ?? "";
  if (!isExchangeRate(rate)) throw new FinanceError("invalid_state", "请填写有效的人工汇率");
  if (!isExpenseDate(date)) throw new FinanceError("invalid_state", "请填写汇率日期");
  if (!source) throw new FinanceError("invalid_state", "请填写汇率来源");
  if (source.length > 200) throw new FinanceError("invalid_state", "汇率来源不能超过 200 字");
  const baseAmount = convertToBaseAmount(normalizedAmount, rate, baseCurrency);
  if (!baseAmount) throw new FinanceError("invalid_state", "无法计算本位币金额");
  return {
    currency: input.currency, baseCurrency, baseAmount,
    exchangeRate: rate, exchangeRateDate: date, exchangeRateSource: source,
  };
}

export async function validateDraftCurrency(
  client: PoolClient,
  productionId: string,
  amount: string | null,
  currency: string,
  input: Omit<CurrencySnapshotInput, "currency"> = {},
): Promise<{
  currency: CurrencyCode; baseCurrency: CurrencyCode; exchangeRate: string | null;
  exchangeRateDate: string | null; exchangeRateSource: string | null;
}> {
  if (!isCurrencyCode(currency)) throw new FinanceError("invalid_state", "请选择有效币种");
  if (amount && !isMoneyAmount(amount, currency))
    throw new FinanceError("invalid_state", `金额小数位不符合${formatCurrencyLabel(currency)}的规则`);
  const exchangeRate = input.exchangeRate?.trim() || null;
  const exchangeRateDate = input.exchangeRateDate?.trim() || null;
  const exchangeRateSource = input.exchangeRateSource?.trim() || null;
  if (exchangeRate && !isExchangeRate(exchangeRate))
    throw new FinanceError("invalid_state", "人工汇率格式不正确");
  if (exchangeRateDate && !isExpenseDate(exchangeRateDate))
    throw new FinanceError("invalid_state", "汇率日期格式不正确");
  if (exchangeRateSource && exchangeRateSource.length > 200)
    throw new FinanceError("invalid_state", "汇率来源不能超过 200 字");
  return {
    currency, baseCurrency: await lockedBaseCurrency(client, productionId),
    exchangeRate, exchangeRateDate, exchangeRateSource,
  };
}

export async function updateProductionBaseCurrency(
  productionId: string,
  currency: string,
): Promise<CurrencyCode> {
  if (!isCurrencyCode(currency)) throw new FinanceError("invalid_state", "请选择有效币种");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const production = await client.query<{ base_currency: string }>(
      "SELECT base_currency FROM production WHERE id = $1 FOR UPDATE",
      [productionId],
    );
    if (!production.rows[0]) throw new FinanceError("conflict", "项目不存在");
    if (production.rows[0].base_currency === currency) {
      await client.query("COMMIT");
      return currency;
    }
    const frozen = await client.query<{ frozen: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM production_budget_item
          WHERE production_id = $1 AND amount IS NOT NULL
         UNION ALL
         SELECT 1 FROM production_expense
          WHERE production_id = $1 AND status <> 'draft'
       ) AS frozen`,
      [productionId],
    );
    if (frozen.rows[0]?.frozen)
      throw new FinanceError("conflict", "已有预算额度或已提交报销，不能修改项目本位币");
    await client.query("UPDATE production SET base_currency = $2 WHERE id = $1", [productionId, currency]);
    await client.query(
      `UPDATE production_budget_item
          SET currency = $2, base_currency = $2, updated_at = now()
        WHERE production_id = $1 AND amount IS NULL`,
      [productionId, currency],
    );
    await client.query(
      `UPDATE production_budget_category
          SET currency = $2, updated_at = now()
        WHERE production_id = $1`,
      [productionId, currency],
    );
    await client.query(
      `UPDATE production_expense
          SET base_currency = $2, updated_at = now()
        WHERE production_id = $1 AND status = 'draft'`,
      [productionId, currency],
    );
    await client.query("COMMIT");
    return currency;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
