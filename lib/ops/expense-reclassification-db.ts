/** 待审批报销的预算项归类与首级重路由。 */

import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { buildExpenseSubmissionPlan } from "./expense-db";
import {
  appendExpenseEvent, FinanceError, type ExpenseStatus,
} from "./expense-read-db";

type BudgetItemAuditSnapshot = {
  id: string;
  legacyCategoryId: string | null;
  name: string;
  deptName: string | null;
  label: string;
};

async function getBudgetItemAuditSnapshot(
  client: PoolClient,
  productionId: string,
  budgetItemId: string,
  lock = false,
): Promise<BudgetItemAuditSnapshot | null> {
  const { rows } = await client.query<{
    id: string; legacy_category_id: string | null; name: string; dept_name: string | null;
  }>(
    `SELECT bi.id, bi.legacy_category_id, c.name, d.name AS dept_name
       FROM production_budget_item bi
       JOIN production_expense_category c ON c.id = bi.category_id
       LEFT JOIN production_dept d ON d.id = bi.dept_id
      WHERE bi.id = $1 AND bi.production_id = $2
      ${lock ? "FOR KEY SHARE OF bi" : ""}`,
    [budgetItemId, productionId],
  );
  const item = rows[0];
  return item ? {
    id: item.id,
    legacyCategoryId: item.legacy_category_id,
    name: item.name,
    deptName: item.dept_name,
    label: `${item.dept_name ?? "项目公共"} · ${item.name}`,
  } : null;
}

type ReclassifyResult =
  | { ok: true; selfApproved: boolean }
  | { ok: false; reason: "conflict" | "not_pending" };

async function reclassifyPendingExpenseInTx(
  client: PoolClient,
  params: {
    expenseId: string;
    productionId: string;
    actorId: string;
    budgetItemId: string | null;
    expectedMutationSeq?: number;
    requireCurrentApprover: boolean;
    reason: "approver_reclassified" | "budget_item_deleted";
  },
): Promise<ReclassifyResult> {
  // 先锁目标预算项，避免它在本事务完成重路由后被并发删除。
  const toItem = params.budgetItemId
    ? await getBudgetItemAuditSnapshot(client, params.productionId, params.budgetItemId, true)
    : null;
  if (params.budgetItemId && !toItem)
    throw new FinanceError("invalid_state", "预算项不存在或不属于当前项目");

  const { rows } = await client.query<{
    status: ExpenseStatus;
    submitted_by: string;
    budget_item_id: string | null;
    current_approver_ids: string[];
    mutation_seq: string;
  }>(
    `SELECT status, submitted_by, budget_item_id, current_approver_ids, mutation_seq
       FROM production_expense
      WHERE id = $1 AND production_id = $2
      FOR UPDATE`,
    [params.expenseId, params.productionId],
  );
  const expense = rows[0];
  if (!expense || expense.status !== "pending") return { ok: false, reason: "not_pending" };
  if ((params.requireCurrentApprover && !expense.current_approver_ids.includes(params.actorId))
      || (params.expectedMutationSeq !== undefined
        && Number(expense.mutation_seq) !== params.expectedMutationSeq)) {
    return { ok: false, reason: "conflict" };
  }
  if (expense.budget_item_id === params.budgetItemId)
    throw new FinanceError("invalid_state", "请选择不同的预算项");

  const fromItem = expense.budget_item_id
    ? await getBudgetItemAuditSnapshot(client, params.productionId, expense.budget_item_id)
    : null;
  const plan = await buildExpenseSubmissionPlan(
    params.productionId, expense.submitted_by, params.budgetItemId,
  );
  const nextMutationSeq = Number(expense.mutation_seq) + 1;
  await client.query(
    `UPDATE production_expense
        SET budget_item_id = $3,
            category_id = $4,
            status = $5,
            current_stage = $6,
            current_stage_depth = $7,
            current_approver_ids = $8::uuid[],
            escalation_chain = escalation_chain || $9::jsonb,
            resolved_at = $10,
            resolved_by = $11,
            mutation_seq = $12,
            updated_at = now()
      WHERE id = $1 AND production_id = $2`,
    [
      params.expenseId, params.productionId, params.budgetItemId,
      toItem?.legacyCategoryId ?? null, plan.status,
      plan.first?.stage ?? null, plan.first?.depth ?? 0, plan.first?.approverIds ?? [],
      JSON.stringify(plan.chain), plan.selfApproved ? plan.actedAt : null,
      plan.selfApproved ? expense.submitted_by : null, nextMutationSeq,
    ],
  );
  await appendExpenseEvent(client, {
    expenseId: params.expenseId,
    type: "reclassified",
    actorId: params.actorId,
    mutationSeq: nextMutationSeq,
    details: {
      reason: params.reason,
      fromBudgetItem: fromItem,
      toBudgetItem: toItem,
      route: {
        status: plan.status,
        stage: plan.first?.stage ?? null,
        depth: plan.first?.depth ?? 0,
        approverIds: plan.first?.approverIds ?? [],
        selfApproved: plan.selfApproved,
      },
    },
  });
  if (plan.selfApproved) {
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: "approved",
      actorId: expense.submitted_by,
      mutationSeq: nextMutationSeq,
      details: { reason: "sole_approver", trigger: params.reason },
    });
  }
  return { ok: true, selfApproved: plan.selfApproved };
}

export async function reclassifyExpense(params: {
  expenseId: string;
  productionId: string;
  actorId: string;
  budgetItemId: string;
  expectedMutationSeq: number;
}): Promise<ReclassifyResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reclassifyPendingExpenseInTx(client, {
      ...params,
      requireCurrentApprover: true,
      reason: "approver_reclassified",
    });
    if (!result.ok) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 预算项删除前，把所有仍在审批中的引用统一改为未归类并从首级重路由。 */
export async function reclassifyPendingExpensesForBudgetItemDeletion(
  client: PoolClient,
  params: { productionId: string; budgetItemId: string; actorId: string },
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM production_expense
      WHERE production_id = $1 AND budget_item_id = $2 AND status = 'pending'
      ORDER BY id FOR UPDATE`,
    [params.productionId, params.budgetItemId],
  );
  for (const row of rows) {
    const result = await reclassifyPendingExpenseInTx(client, {
      expenseId: row.id,
      productionId: params.productionId,
      actorId: params.actorId,
      budgetItemId: null,
      requireCurrentApprover: false,
      reason: "budget_item_deleted",
    });
    if (!result.ok) throw new FinanceError("conflict", "待审批报销刚被处理，请刷新后重试");
  }
}
