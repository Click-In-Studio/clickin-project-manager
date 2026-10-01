/**
 * 财务预算科目数据层。报销生命周期单独位于 expense-db.ts，避免状态机与预算查询再次长成总仓。
 */

import { randomBytes } from "node:crypto";
import { getPool } from "../pg";
import type { PoolClient } from "pg";
import { isCurrencyCode, normalizeMoneyAmount } from "../money";
import { FinanceError } from "./expense-read-db";
import { reclassifyPendingExpensesForBudgetItemDeletion } from "./expense-reclassification-db";
import {
  buildCurrencySnapshot, validateDraftCurrency,
} from "./finance-currency-db";

export * from "./expense-read-db";
export * from "./expense-db";
export * from "./expense-reclassification-db";
export * from "./finance-currency-db";

export type BudgetCategory = {
  id: string;
  productionId: string;
  categoryId: string;
  name: string;
  /** 字符串而非 number：NUMERIC(14,2) 过 JS number 会丢精度 */
  amount: string | null;
  currency: string;
  baseCurrency: string;
  baseAmount: string | null;
  exchangeRate: string | null;
  exchangeRateDate: string | null;
  exchangeRateSource: string | null;
  deptId: string | null;
  deptName: string | null;
  orderIndex: number;
  notes: string;
  /** 该科目下已批准支出的合计 */
  spent: string;
  createdAt: string;
  legacyCategoryId: string | null;
};

export type ExpenseCategory = {
  id: string; productionId: string; name: string; description: string;
  sortOrder: number; budgetItemCount: number; createdAt: string;
};

const newExpenseCategoryId = () => `ec_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const newBudgetItemId = () => `bi_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;


// ─── 预算科目 ─────────────────────────────────────────────────────────────────

type CategoryRow = {
  id: string; production_id: string; category_id: string; name: string; amount: string | null; currency: string;
  base_currency: string; base_amount: string | null; exchange_rate: string | null;
  exchange_rate_date: string | null; exchange_rate_source: string | null;
  dept_id: string | null; dept_name: string | null; order_index: number; notes: string;
  spent: string; created_at: Date; legacy_category_id: string | null;
};

function rowToCategory(r: CategoryRow): BudgetCategory {
  const currency = isCurrencyCode(r.currency) ? r.currency : "CNY";
  const baseCurrency = isCurrencyCode(r.base_currency) ? r.base_currency : "CNY";
  return {
    id: r.id, productionId: r.production_id, categoryId: r.category_id, name: r.name,
    amount: r.amount === null ? null : normalizeMoneyAmount(r.amount, currency), currency: r.currency,
    baseCurrency: r.base_currency,
    baseAmount: r.base_amount === null ? null : normalizeMoneyAmount(r.base_amount, baseCurrency),
    exchangeRate: r.exchange_rate, exchangeRateDate: r.exchange_rate_date,
    exchangeRateSource: r.exchange_rate_source,
    deptId: r.dept_id, deptName: r.dept_name,
    orderIndex: r.order_index, notes: r.notes,
    spent: normalizeMoneyAmount(r.spent, baseCurrency), createdAt: r.created_at.toISOString(), legacyCategoryId: r.legacy_category_id,
  };
}

const CATEGORY_QUERY = `
  SELECT bi.id, bi.production_id, bi.category_id, c.name, bi.amount::text AS amount, bi.currency,
         bi.base_currency, bi.base_amount::text AS base_amount,
         bi.exchange_rate::text AS exchange_rate, bi.exchange_rate_date::text AS exchange_rate_date,
         bi.exchange_rate_source,
         bi.dept_id, d.name AS dept_name, bi.sort_order AS order_index, bi.notes, bi.created_at,
         bi.legacy_category_id,
         COALESCE((SELECT SUM(e.base_amount) FROM production_expense e
                    WHERE e.budget_item_id = bi.id AND e.status = 'approved'), 0)::text AS spent
    FROM production_budget_item bi
    JOIN production_expense_category c ON c.id = bi.category_id
    LEFT JOIN production_dept d ON d.id = bi.dept_id`;

export async function listBudgetCategories(productionId: string): Promise<BudgetCategory[]> {
  const res = await getPool().query<CategoryRow>(
    `${CATEGORY_QUERY} WHERE bi.production_id = $1 ORDER BY d.display_order NULLS FIRST, bi.sort_order, c.name`,
    [productionId],
  );
  return res.rows.map(rowToCategory);
}

/**
 * 科目表的**只读窄面**：只有名字与归属部门，没有额度、没有已用。
 *
 * 为什么单独一支而不是给 listBudgetCategories 加个开关：这两面的**门不一样**
 * （categories@view vs budget@view）。用开关的话，一旦哪个调用方忘了传，
 * 泄露的是全项目预算额度——而且不会报错。类型上就分开，忘不了。
 *
 * 科目名不敏感：它是项目的成本结构分类，报销时必须看得见才能选。敏感的是额度
 * ——「有的剧组连设计人员都能看到预算」，「有的」说明那是剧组的选择。
 */
export type BudgetCategoryOption = { id: string; name: string; deptName: string | null };

export async function listBudgetCategoryOptions(productionId: string): Promise<BudgetCategoryOption[]> {
  const res = await getPool().query<{ id: string; name: string; dept_name: string | null }>(
    `SELECT bi.id, c.name, d.name AS dept_name
       FROM production_budget_item bi
       JOIN production_expense_category c ON c.id = bi.category_id
       LEFT JOIN production_dept d ON d.id = bi.dept_id
      WHERE bi.production_id = $1
      ORDER BY d.display_order NULLS FIRST, bi.sort_order, c.name`,
    [productionId],
  );
  return res.rows.map(r => ({ id: r.id, name: r.name, deptName: r.dept_name }));
}

export async function getBudgetCategory(id: string, productionId: string): Promise<BudgetCategory | null> {
  const res = await getPool().query<CategoryRow>(
    `${CATEGORY_QUERY} WHERE bi.id = $1 AND bi.production_id = $2`,
    [id, productionId],
  );
  return res.rows[0] ? rowToCategory(res.rows[0]) : null;
}

type ExpenseCategoryRow = {
  id: string; production_id: string; name: string; description: string;
  sort_order: number; budget_item_count: string; created_at: Date;
};

function rowToExpenseCategory(row: ExpenseCategoryRow): ExpenseCategory {
  return {
    id: row.id, productionId: row.production_id, name: row.name,
    description: row.description, sortOrder: row.sort_order,
    budgetItemCount: Number(row.budget_item_count), createdAt: row.created_at.toISOString(),
  };
}

export async function listExpenseCategories(productionId: string): Promise<ExpenseCategory[]> {
  const result = await getPool().query<ExpenseCategoryRow>(
    `SELECT c.*, COUNT(bi.id)::text AS budget_item_count
       FROM production_expense_category c
       LEFT JOIN production_budget_item bi ON bi.category_id = c.id
      WHERE c.production_id = $1
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
    [productionId],
  );
  return result.rows.map(rowToExpenseCategory);
}

export async function createExpenseCategory(params: {
  productionId: string; name: string; description?: string; sortOrder?: number; createdBy: string;
}): Promise<ExpenseCategory> {
  try {
    const result = await getPool().query<ExpenseCategoryRow>(
      `INSERT INTO production_expense_category
         (id, production_id, name, description, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *, '0'::text AS budget_item_count`,
      [newExpenseCategoryId(), params.productionId, params.name.trim(), params.description ?? "", params.sortOrder ?? 0, params.createdBy],
    );
    return rowToExpenseCategory(result.rows[0]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("production_expense_category_production_id_name_key"))
      throw new FinanceError("duplicate_name", "同名费用科目已存在");
    throw error;
  }
}

export async function updateExpenseCategory(
  id: string, productionId: string,
  fields: { name?: string; description?: string; sortOrder?: number },
): Promise<ExpenseCategory | null> {
  const sets = ["updated_at = now()"];
  const values: unknown[] = [id, productionId];
  if (fields.name !== undefined) sets.push(`name = $${values.push(fields.name.trim())}`);
  if (fields.description !== undefined) sets.push(`description = $${values.push(fields.description)}`);
  if (fields.sortOrder !== undefined) sets.push(`sort_order = $${values.push(fields.sortOrder)}`);
  try {
    const result = await getPool().query<ExpenseCategoryRow>(
      `UPDATE production_expense_category SET ${sets.join(", ")}
        WHERE id = $1 AND production_id = $2
        RETURNING *, (SELECT COUNT(*)::text FROM production_budget_item WHERE category_id = $1) AS budget_item_count`,
      values,
    );
    return result.rows[0] ? rowToExpenseCategory(result.rows[0]) : null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("production_expense_category_production_id_name_key"))
      throw new FinanceError("duplicate_name", "同名费用科目已存在");
    throw error;
  }
}

export async function deleteExpenseCategory(id: string, productionId: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM production_expense_category c
      WHERE c.id = $1 AND c.production_id = $2
        AND NOT EXISTS (SELECT 1 FROM production_budget_item bi WHERE bi.category_id = c.id)`,
    [id, productionId],
  );
  if ((result.rowCount ?? 0) > 0) return true;
  const exists = await getPool().query("SELECT 1 FROM production_expense_category WHERE id = $1 AND production_id = $2", [id, productionId]);
  if (exists.rowCount) throw new FinanceError("conflict", "该科目仍被预算项使用，不能删除");
  return false;
}

/**
 * 科目的归属部门同步进 resource_dept_manage，这样该部门 POC 自动成为本科目支出的
 * 审批人之一——路由那边什么都不用改。
 *
 * 副作用要认：被挂上的部门从此受解散守卫保护（`dept 被 resource_dept_manage 引用时
 * 禁止删除`）。这是对的——预算科目还挂着，部门不该凭空消失。
 */
async function syncCategoryDeptManage(
  client: PoolClient, productionId: string, categoryId: string,
  deptId: string | null, establishedBy: string,
): Promise<void> {
  await client.query(
    `DELETE FROM resource_dept_manage
      WHERE production_id = $1 AND resource_type = 'finance' AND resource_id = $2`,
    [productionId, categoryId],
  );
  if (!deptId) return;
  await client.query(
    `INSERT INTO resource_dept_manage
       (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
     VALUES ($1, $2, 'finance', $3, 'expenses', $4)
     ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING`,
    [productionId, deptId, categoryId, establishedBy],
  );
}

export async function createBudgetItem(params: {
  productionId: string; categoryId: string; amount?: string | null; currency?: string;
  exchangeRate?: string | null; exchangeRateDate?: string | null; exchangeRateSource?: string | null;
  deptId?: string | null; orderIndex?: number; notes?: string; createdBy: string;
}): Promise<BudgetCategory> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const id = newBudgetItemId();
    const labels = await client.query<{ category_name: string; dept_name: string | null }>(
      `SELECT c.name AS category_name, d.name AS dept_name
         FROM production_expense_category c
         LEFT JOIN production_dept d ON d.id = $3 AND d.production_id = $2
        WHERE c.id = $1 AND c.production_id = $2`,
      [params.categoryId, params.productionId, params.deptId ?? null],
    );
    if (!labels.rows[0] || (params.deptId && !labels.rows[0].dept_name))
      throw new FinanceError("conflict", "费用科目或部门不存在");
    const requestedCurrency = params.currency ?? "CNY";
    const snapshot = params.amount == null
      ? null
      : await buildCurrencySnapshot(client, params.productionId, params.amount, {
          currency: requestedCurrency,
          exchangeRate: params.exchangeRate,
          exchangeRateDate: params.exchangeRateDate,
          exchangeRateSource: params.exchangeRateSource,
        });
    const draftCurrency = snapshot ?? await validateDraftCurrency(
      client, params.productionId, null, requestedCurrency,
    );
    const legacy = await client.query<{ id: string }>(
      `INSERT INTO production_budget_category
         (production_id, name, amount, currency, dept_id, order_index, notes, created_by)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8) RETURNING id`,
      [
        params.productionId,
        `${labels.rows[0].category_name} · ${labels.rows[0].dept_name ?? "项目公共"} · ${id.slice(-6)}`,
        params.amount ?? "0", draftCurrency.currency,
        params.deptId ?? null, params.orderIndex ?? 0, params.notes ?? "", params.createdBy,
      ],
    );
    await client.query(
      `INSERT INTO production_budget_item
         (id, production_id, category_id, dept_id, amount, currency, base_currency, base_amount,
          exchange_rate, exchange_rate_date, exchange_rate_source,
          notes, sort_order, legacy_category_id, created_by)
       VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8::numeric,$9::numeric,$10::date,$11,$12,$13,$14,$15)`,
      [id, params.productionId, params.categoryId, params.deptId ?? null, params.amount ?? null,
       draftCurrency.currency, draftCurrency.baseCurrency, snapshot?.baseAmount ?? null,
       snapshot?.exchangeRate ?? null, snapshot?.exchangeRateDate ?? null,
       snapshot?.exchangeRateSource ?? null, params.notes ?? "", params.orderIndex ?? 0,
       legacy.rows[0].id, params.createdBy],
    );
    await syncCategoryDeptManage(
      client, params.productionId, id, params.deptId ?? null, params.createdBy,
    );
    await client.query("COMMIT");
    const created = await getBudgetCategory(id, params.productionId);
    if (!created) throw new Error(`budget item not found after create: ${id}`);
    return created;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && (e.message.includes("production_budget_item_dept_unique_idx") || e.message.includes("production_budget_item_public_unique_idx")))
      throw new FinanceError("duplicate_name", "该部门已配置这个费用科目");
    throw e;
  } finally {
    client.release();
  }
}

/** 兼容既有调用：同时建立费用科目和它的第一个预算项。 */
export async function createBudgetCategory(params: {
  productionId: string; name: string; amount: string | null; currency?: string;
  exchangeRate?: string | null; exchangeRateDate?: string | null; exchangeRateSource?: string | null;
  deptId?: string | null; orderIndex?: number; notes?: string; createdBy: string;
}): Promise<BudgetCategory> {
  const category = await createExpenseCategory({
    productionId: params.productionId, name: params.name,
    sortOrder: params.orderIndex, createdBy: params.createdBy,
  });
  try {
    return await createBudgetItem({ ...params, categoryId: category.id });
  } catch (error) {
    await deleteExpenseCategory(category.id, params.productionId).catch(() => {});
    throw error;
  }
}

export async function updateBudgetCategory(
  id: string, productionId: string, actorId: string,
  fields: {
    name?: string; amount?: string | null; currency?: string;
    exchangeRate?: string | null; exchangeRateDate?: string | null; exchangeRateSource?: string | null;
    deptId?: string | null; orderIndex?: number; notes?: string;
  },
): Promise<BudgetCategory | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      amount: string | null; currency: string; exchange_rate: string | null;
      exchange_rate_date: string | null; exchange_rate_source: string | null;
      legacy_category_id: string; category_id: string; dept_id: string | null;
    }>(
      `SELECT amount::text, currency, exchange_rate::text, exchange_rate_date::text,
              exchange_rate_source, legacy_category_id, category_id, dept_id
         FROM production_budget_item
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [id, productionId],
    );
    const row = current.rows[0];
    if (!row) { await client.query("ROLLBACK"); return null; }
    const sets: string[] = ["updated_at = now()"];
    const vals: unknown[] = [id, productionId];
    const moneyChanged = fields.amount !== undefined || fields.currency !== undefined
      || fields.exchangeRate !== undefined || fields.exchangeRateDate !== undefined
      || fields.exchangeRateSource !== undefined;
    if (moneyChanged) {
      const amount = fields.amount !== undefined ? fields.amount : row.amount;
      const currency = fields.currency ?? row.currency;
      const snapshot = amount === null ? null : await buildCurrencySnapshot(client, productionId, amount, {
        currency,
        exchangeRate: fields.exchangeRate !== undefined ? fields.exchangeRate : row.exchange_rate,
        exchangeRateDate: fields.exchangeRateDate !== undefined ? fields.exchangeRateDate : row.exchange_rate_date,
        exchangeRateSource: fields.exchangeRateSource !== undefined ? fields.exchangeRateSource : row.exchange_rate_source,
      });
      const draftCurrency = snapshot ?? await validateDraftCurrency(client, productionId, null, currency);
      sets.push(`amount = $${vals.push(amount)}::numeric`);
      sets.push(`currency = $${vals.push(draftCurrency.currency)}`);
      sets.push(`base_currency = $${vals.push(draftCurrency.baseCurrency)}`);
      sets.push(`base_amount = $${vals.push(snapshot?.baseAmount ?? null)}::numeric`);
      sets.push(`exchange_rate = $${vals.push(snapshot?.exchangeRate ?? null)}::numeric`);
      sets.push(`exchange_rate_date = $${vals.push(snapshot?.exchangeRateDate ?? null)}::date`);
      sets.push(`exchange_rate_source = $${vals.push(snapshot?.exchangeRateSource ?? null)}`);
    }
    if (fields.deptId     !== undefined) sets.push(`dept_id     = $${vals.push(fields.deptId)}`);
    if (fields.orderIndex !== undefined) sets.push(`sort_order = $${vals.push(fields.orderIndex)}`);
    if (fields.notes      !== undefined) sets.push(`notes       = $${vals.push(fields.notes)}`);

    const res = await client.query<{ id: string; legacy_category_id: string; category_id: string; dept_id: string | null; amount: string | null; currency: string }>(
      `UPDATE production_budget_item SET ${sets.join(", ")}
        WHERE id = $1 AND production_id = $2
        RETURNING id, legacy_category_id, category_id, dept_id, amount::text, currency`,
      vals,
    );
    if (!res.rows[0]) { await client.query("ROLLBACK"); return null; }
    if (fields.name !== undefined) {
      await client.query(
        "UPDATE production_expense_category SET name = $3, updated_at = now() WHERE id = $1 AND production_id = $2",
        [res.rows[0].category_id, productionId, fields.name.trim()],
      );
    }
    const legacySets = ["updated_at = now()"];
    const legacyValues: unknown[] = [res.rows[0].legacy_category_id];
    if (moneyChanged) {
      legacySets.push(`amount = $${legacyValues.push(res.rows[0].amount ?? "0")}::numeric`);
      legacySets.push(`currency = $${legacyValues.push(res.rows[0].currency)}`);
    }
    if (fields.deptId !== undefined) legacySets.push(`dept_id = $${legacyValues.push(fields.deptId)}`);
    if (fields.orderIndex !== undefined) legacySets.push(`order_index = $${legacyValues.push(fields.orderIndex)}`);
    if (fields.notes !== undefined) legacySets.push(`notes = $${legacyValues.push(fields.notes)}`);
    await client.query(
      `UPDATE production_budget_category SET ${legacySets.join(", ")} WHERE id = $1`,
      legacyValues,
    );
    if (fields.deptId !== undefined) {
      await syncCategoryDeptManage(client, productionId, id, fields.deptId, actorId);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && (e.message.includes("production_budget_item_dept_unique_idx") || e.message.includes("production_budget_item_public_unique_idx")))
      throw new FinanceError("duplicate_name", "该部门已配置这个费用科目");
    throw e;
  } finally {
    client.release();
  }
  return getBudgetCategory(id, productionId);
}

/** 删除预算项；历史报销保留并变为未归类，待审批报销先从未归类路径重新路由。 */
export async function deleteBudgetCategory(
  id: string,
  productionId: string,
  actorId: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 与审批人主动归类共用“目标预算项 → expense”的锁序，阻止删除和归类交错。
    const item = await client.query<{ legacy_category_id: string | null }>(
      "SELECT legacy_category_id FROM production_budget_item WHERE id = $1 AND production_id = $2 FOR UPDATE",
      [id, productionId],
    );
    if (!item.rows[0]) { await client.query("ROLLBACK"); return; }
    await reclassifyPendingExpensesForBudgetItemDeletion(client, {
      productionId, budgetItemId: id, actorId,
    });
    await client.query(
      `DELETE FROM resource_dept_manage
        WHERE production_id = $1 AND resource_type = 'finance' AND resource_id = $2`,
      [productionId, id],
    );
    await client.query("UPDATE production_expense SET budget_item_id = NULL, category_id = NULL WHERE budget_item_id = $1", [id]);
    await client.query("DELETE FROM production_budget_item WHERE id = $1 AND production_id = $2", [id, productionId]);
    if (item.rows[0].legacy_category_id)
      await client.query("DELETE FROM production_budget_category WHERE id = $1 AND production_id = $2", [item.rows[0].legacy_category_id, productionId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
