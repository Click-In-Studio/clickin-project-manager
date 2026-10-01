import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { addProductionMember } from "@/lib/perm/member-db";
import { getPool } from "@/lib/pg";
import { PATCH as patchFinanceSettings } from "@/app/api/production/[id]/finance/settings/route";
import {
  createBudgetCategory, createExpenseDraft, FinanceError, listBudgetCategories,
  submitExpense, submitExpenseDraft, updateProductionBaseCurrency,
} from "@/lib/ops/finance-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let productionId: string;
let ownerId: string;
let viewerId: string;
let outsiderId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `外币owner${shortId()}`, null, false)).userId;
  viewerId = (await upsertFeishuUser(`test-open-${shortId()}`, `本位币只读${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `本位币外部${shortId()}`, null, false)).userId;
  ({ prodId: productionId } = await makeProduction(ownerId));
  await addProductionMember(productionId, viewerId);
  await getPool().query(
    `INSERT INTO production_member_permission (production_id, user_id, permission, granted)
     VALUES ($1,$2,'node:finance/*/budget@view',true)`,
    [productionId, viewerId],
  );
  await updateProductionBaseCurrency(productionId, "USD");
});

afterAll(async () => {
  await cleanupProduction(productionId).catch(() => {});
});

describe("财务汇率快照", () => {
  function settingsRequest(userId: string | null) {
    const request = new NextRequest("http://localhost/api/x", {
      method: "PATCH", body: JSON.stringify({ baseCurrency: "EUR" }),
      headers: { "content-type": "application/json" },
    });
    if (userId) request.cookies.set(SESSION_COOKIE, createSession({
      userId, name: "测试", avatarUrl: null, isAdmin: false,
    }));
    return request;
  }

  it("本位币写路由要求登录、项目成员和 budget@edit", async () => {
    const ctx = { params: Promise.resolve({ id: productionId }) };
    expect((await patchFinanceSettings(settingsRequest(null), ctx)).status).toBe(401);
    expect((await patchFinanceSettings(settingsRequest(outsiderId), ctx)).status).toBe(403);
    expect((await patchFinanceSettings(settingsRequest(viewerId), ctx)).status).toBe(403);
  });

  it("N-1 同本位币写入由数据库补齐快照", async () => {
    const { prodId } = await makeProduction(ownerId);
    try {
      const categoryId = `ec_${shortId()}`;
      const budgetItemId = `bi_${shortId()}`;
      const legacy = await getPool().query<{ id: string }>(
        `INSERT INTO production_budget_category (production_id, name, amount, currency, created_by)
         VALUES ($1,'旧版预算',12.34,'CNY',$2) RETURNING id`,
        [prodId, ownerId],
      );
      await getPool().query(
        `INSERT INTO production_expense_category (id, production_id, name, created_by)
         VALUES ($1,$2,'旧版科目',$3)`,
        [categoryId, prodId, ownerId],
      );
      await getPool().query(
        `INSERT INTO production_budget_item
           (id, production_id, category_id, amount, currency, legacy_category_id, created_by)
         VALUES ($1,$2,$3,12.34,'CNY',$4,$5)`,
        [budgetItemId, prodId, categoryId, legacy.rows[0].id, ownerId],
      );
      const expense = await getPool().query<{ id: string }>(
        `INSERT INTO production_expense
           (production_id, budget_item_id, category_id, title, amount, currency,
            submitted_by, status, submitted_at)
         VALUES ($1,$2,$3,'旧版报销',8.90,'CNY',$4,'pending',now()) RETURNING id`,
        [prodId, budgetItemId, legacy.rows[0].id, ownerId],
      );
      await getPool().query("UPDATE production_expense SET amount = 9.10 WHERE id = $1", [expense.rows[0].id]);

      const snapshots = await getPool().query<{ amount: string; base_currency: string; base_amount: string }>(
        `SELECT amount::text, base_currency, base_amount::text
           FROM production_expense WHERE id = $1`,
        [expense.rows[0].id],
      );
      expect(snapshots.rows[0]).toEqual({ amount: "9.100", base_currency: "CNY", base_amount: "9.100" });
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });

  it("预算项保存人工汇率快照，汇总只使用本位币金额", async () => {
    const item = await createBudgetCategory({
      productionId, name: `海外交通${shortId()}`, amount: "1000", currency: "JPY",
      exchangeRate: "0.0067", exchangeRateDate: "2026-10-01", exchangeRateSource: "信用卡账单",
      createdBy: ownerId,
    });
    expect(item).toMatchObject({
      amount: "1000", currency: "JPY", baseCurrency: "USD", baseAmount: "6.70",
      exchangeRateDate: "2026-10-01", exchangeRateSource: "信用卡账单",
    });

    const expense = await submitExpense({
      productionId, categoryId: item.id, title: "海外交通", amount: "1.234", currency: "KWD",
      exchangeRate: "3.25", exchangeRateDate: "2026-10-01", exchangeRateSource: "换汇结算单",
      submittedBy: ownerId, invoiceRequirement: "waived", invoiceWaiverReason: "境外交通无票",
    });
    expect(expense).toMatchObject({
      status: "approved", currency: "KWD", baseCurrency: "USD", baseAmount: "4.01",
      exchangeRate: "3.250000000000", exchangeRateSource: "换汇结算单",
    });
    expect((await listBudgetCategories(productionId)).find(row => row.id === item.id)?.spent).toBe("4.01");
  });

  it("外币草稿允许暂缺汇率，但提交时必须补齐", async () => {
    const draft = await createExpenseDraft({
      productionId, categoryId: null, title: "待确认外币", amount: "10.00", currency: "EUR",
      submittedBy: ownerId, invoiceRequirement: "waived", invoiceWaiverReason: "测试",
    });
    await expect(submitExpenseDraft(draft.id, productionId, ownerId, draft.mutationSeq))
      .rejects.toMatchObject({ reason: "invalid_state" } satisfies Partial<FinanceError>);
  });

  it("出现预算额度或已提交报销后不能修改本位币", async () => {
    await expect(updateProductionBaseCurrency(productionId, "CNY"))
      .rejects.toMatchObject({ reason: "conflict" } satisfies Partial<FinanceError>);
  });
});
