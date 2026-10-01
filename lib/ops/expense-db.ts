/** 报销草稿、凭证、审批和超时升级状态机。 */

import { getPool } from "../pg";
import { uid } from "../asset/db";
import {
  buildApprovalCandidateLadder, buildApprovalLadder, DEFAULT_APPROVAL_TTL_HOURS, nextStage,
  type ApprovalStage, type StagePosition,
} from "../approval/approval-routing";
import {
  isApprovalCommentTooLong, normalizeApprovalComment,
} from "../approval/approval-stages";
import {
  FinanceError, appendExpenseEvent, getExpense,
  type Expense, type ExpenseDocumentKind, type ExpenseStatus, type InvoiceRequirement,
} from "./expense-read-db";
import { buildCurrencySnapshot, validateDraftCurrency } from "./finance-currency-db";
import { lockOwnedExpenseDocumentFiles } from "./expense-document-db";
export { addExpenseDocument, removeExpenseDocument } from "./expense-document-db";

function expenseTarget(productionId: string, submitterId: string, categoryId: string | null) {
  return {
    productionId,
    subjectId: submitterId,
    resourceType: "finance",
    resourceId: categoryId ?? "*",
    resourceSub: "expenses",
    permissionLevel: "edit",
  };
}

function chainEntry(stage: ApprovalStage) {
  return {
    phase: stage.stage, depth: stage.depth,
    approverIds: stage.approverIds, canFinalize: stage.canFinalize,
    notifiedAt: new Date().toISOString(),
  };
}

function selfApprovalEntry(submitterId: string, actedAt: string, bySystem = false) {
  return {
    phase: "self_approval", depth: 0,
    approverIds: [submitterId], canFinalize: true,
    notifiedAt: actedAt,
    action: "approved", ...(bySystem ? { bySystem: true } : { actorId: submitterId }), actedAt,
    approvalReason: "sole_approver",
  };
}

function isSoleCandidate(ladder: ApprovalStage[], subjectId: string): boolean {
  const ids = new Set(ladder.flatMap(stage => stage.approverIds));
  return ids.size === 1 && ids.has(subjectId);
}

function withoutSubject(ladder: ApprovalStage[], subjectId: string): ApprovalStage[] {
  return ladder
    .map(stage => ({ ...stage, approverIds: stage.approverIds.filter(id => id !== subjectId) }))
    .filter(stage => stage.approverIds.length > 0);
}

export async function buildExpenseSubmissionPlan(
  productionId: string,
  submittedBy: string,
  categoryId: string | null,
) {
  const candidateLadder = await buildApprovalCandidateLadder(
    expenseTarget(productionId, submittedBy, categoryId),
  );
  const selfApproved = isSoleCandidate(candidateLadder, submittedBy);
  const ladder = withoutSubject(candidateLadder, submittedBy);
  const first = ladder[0];
  if (!first && !selfApproved)
    throw new FinanceError("no_approver", "找不到这笔支出的审批人，请联系制作人");
  const actedAt = new Date().toISOString();
  return {
    selfApproved,
    first,
    status: (selfApproved ? "approved" : "pending") as ExpenseStatus,
    chain: selfApproved
      ? [selfApprovalEntry(submittedBy, actedAt)]
      : [chainEntry(first!)],
    actedAt,
  };
}

function validateSubmittedExpense(params: {
  title: string;
  amount: string | null;
  invoiceRequirement: InvoiceRequirement | null;
  invoiceWaiverReason: string;
}): void {
  if (!params.title.trim()) throw new FinanceError("invalid_state", "事由不能为空");
  if (!params.amount) throw new FinanceError("invalid_state", "请填写金额");
  if (params.invoiceRequirement !== "required" && params.invoiceRequirement !== "waived")
    throw new FinanceError("invalid_state", "请选择是否需要发票");
  if (params.invoiceRequirement === "waived" && !params.invoiceWaiverReason.trim())
    throw new FinanceError("invalid_state", "请填写无发票原因");
}

export async function createExpenseDraft(params: {
  productionId: string;
  categoryId: string | null;
  title?: string;
  amount?: string | null;
  currency?: string;
  exchangeRate?: string | null;
  exchangeRateDate?: string | null;
  exchangeRateSource?: string | null;
  merchant?: string;
  occurredOn?: string | null;
  note?: string;
  submittedBy: string;
  invoiceRequirement?: InvoiceRequirement | null;
  invoiceWaiverReason?: string;
  documents?: { assetFileId: string; kind: ExpenseDocumentKind }[];
}): Promise<Expense> {
  const documents = params.documents ?? [];
  const uniqueFileIds = [...new Set(documents.map(document => document.assetFileId))];
  if (uniqueFileIds.length !== documents.length)
    throw new FinanceError("invalid_document", "同一份凭证不能重复添加");
  const client = await getPool().connect();
  let expenseId: string | null = null;
  try {
    await client.query("BEGIN");
    const draftCurrency = await validateDraftCurrency(
      client, params.productionId, params.amount ?? null, params.currency ?? "CNY", params,
    );
    await lockOwnedExpenseDocumentFiles(client, params.productionId, params.submittedBy, uniqueFileIds);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO production_expense
         (production_id, budget_item_id, category_id, title, amount, currency, base_currency,
          exchange_rate, exchange_rate_date, exchange_rate_source, merchant, occurred_on, note,
          invoice_requirement, invoice_waiver_reason, submitted_by, status)
       VALUES ($1,$2,(SELECT legacy_category_id FROM production_budget_item WHERE id = $2),$3,$4::numeric,$5,$6,
              $7::numeric,$8::date,$9,$10,$11::date,$12,$13,$14,$15,'draft')
       RETURNING id`,
      [
        params.productionId, params.categoryId, params.title?.trim() ?? "", params.amount ?? null,
        draftCurrency.currency, draftCurrency.baseCurrency, draftCurrency.exchangeRate,
        draftCurrency.exchangeRateDate, draftCurrency.exchangeRateSource,
        params.merchant?.trim() ?? "", params.occurredOn ?? null, params.note ?? "",
        params.invoiceRequirement ?? null,
        params.invoiceRequirement === "waived" ? params.invoiceWaiverReason?.trim() ?? "" : "",
        params.submittedBy,
      ],
    );
    expenseId = rows[0].id;
    for (const document of documents) {
      await client.query(
        `INSERT INTO production_expense_document
           (id, expense_id, asset_file_id, document_kind, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,clock_timestamp())`,
        [uid("edoc"), expenseId, document.assetFileId, document.kind, params.submittedBy],
      );
    }
    await appendExpenseEvent(client, {
      expenseId,
      type: "draft_created",
      actorId: params.submittedBy,
      mutationSeq: 0,
      details: { evidenceAssetFileIds: uniqueFileIds },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!expenseId) throw new Error("expense draft insert returned no id");
  const created = await getExpense(expenseId, params.productionId);
  if (!created) throw new Error(`expense not found after draft create: ${expenseId}`);
  return created;
}

export async function submitExpense(params: {
  productionId: string; categoryId: string | null; title: string;
  amount: string; currency?: string; note?: string; submittedBy: string;
  exchangeRate?: string | null; exchangeRateDate?: string | null; exchangeRateSource?: string | null;
  merchant?: string; occurredOn?: string | null;
  invoiceRequirement?: InvoiceRequirement;
  invoiceWaiverReason?: string;
  documents?: { assetFileId: string; kind: ExpenseDocumentKind }[];
}): Promise<Expense> {
  const invoiceRequirement = params.invoiceRequirement ?? "required";
  const waiverReason = invoiceRequirement === "waived" ? params.invoiceWaiverReason?.trim() ?? "" : "";
  validateSubmittedExpense({
    title: params.title,
    amount: params.amount,
    invoiceRequirement,
    invoiceWaiverReason: waiverReason,
  });
  const plan = await buildExpenseSubmissionPlan(
    params.productionId, params.submittedBy, params.categoryId,
  );

  const documents = params.documents ?? [];
  const uniqueFileIds = [...new Set(documents.map(document => document.assetFileId))];
  if (uniqueFileIds.length !== documents.length)
    throw new FinanceError("invalid_document", "同一份凭证不能重复添加");

  const client = await getPool().connect();
  let expenseId: string | null = null;
  try {
    await client.query("BEGIN");
    const snapshot = await buildCurrencySnapshot(client, params.productionId, params.amount, {
      currency: params.currency ?? "CNY",
      exchangeRate: params.exchangeRate,
      exchangeRateDate: params.exchangeRateDate,
      exchangeRateSource: params.exchangeRateSource,
    });
    await lockOwnedExpenseDocumentFiles(
      client, params.productionId, params.submittedBy, uniqueFileIds,
    );

    const res = await client.query<{ id: string }>(
      `INSERT INTO production_expense
         (production_id, budget_item_id, category_id, title, amount, currency, base_currency, base_amount,
          exchange_rate, exchange_rate_date, exchange_rate_source, merchant, occurred_on, note,
          invoice_requirement, invoice_waiver_reason, submitted_by,
          status, current_stage, current_stage_depth, current_approver_ids, escalation_chain,
          resolved_at, resolved_by, submitted_at)
       VALUES ($1,$2,(SELECT legacy_category_id FROM production_budget_item WHERE id = $2),$3,$4::numeric,$5,$6,$7::numeric,
              $8::numeric,$9::date,$10,$11,$12::date,$13,$14,$15,$16,$17,$18,$19,$20::uuid[],$21::jsonb,$22,$23,now())
       RETURNING id`,
      [
        params.productionId, params.categoryId, params.title.trim(), params.amount,
        snapshot.currency, snapshot.baseCurrency, snapshot.baseAmount, snapshot.exchangeRate,
        snapshot.exchangeRateDate, snapshot.exchangeRateSource,
        params.merchant?.trim() ?? "", params.occurredOn ?? null, params.note ?? "",
        invoiceRequirement, waiverReason, params.submittedBy, plan.status,
        plan.first?.stage ?? null, plan.first?.depth ?? 0,
        plan.first?.approverIds ?? [], JSON.stringify(plan.chain),
        plan.selfApproved ? plan.actedAt : null, plan.selfApproved ? params.submittedBy : null,
      ],
    );
    expenseId = res.rows[0].id;
    for (const document of documents) {
      await client.query(
        `INSERT INTO production_expense_document
           (id, expense_id, asset_file_id, document_kind, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,clock_timestamp())`,
        [uid("edoc"), expenseId, document.assetFileId, document.kind, params.submittedBy],
      );
    }
    await appendExpenseEvent(client, {
      expenseId,
      type: "submitted",
      actorId: params.submittedBy,
      mutationSeq: 0,
      details: {
        title: params.title.trim(), amount: params.amount, currency: snapshot.currency,
        baseCurrency: snapshot.baseCurrency, baseAmount: snapshot.baseAmount,
        exchangeRate: snapshot.exchangeRate, exchangeRateDate: snapshot.exchangeRateDate,
        exchangeRateSource: snapshot.exchangeRateSource,
        merchant: params.merchant?.trim() ?? "", occurredOn: params.occurredOn ?? null,
        categoryId: params.categoryId, evidenceAssetFileIds: uniqueFileIds,
      },
    });
    if (plan.selfApproved) {
      await appendExpenseEvent(client, {
        expenseId,
        type: "approved",
        actorId: params.submittedBy,
        mutationSeq: 0,
        details: { reason: "sole_approver", evidenceAssetFileIds: uniqueFileIds },
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!expenseId) throw new Error("expense insert returned no id");
  const created = await getExpense(expenseId, params.productionId);
  if (!created) throw new Error(`expense not found after create: ${expenseId}`);
  return created;
}

export async function updateExpenseDraft(params: {
  expenseId: string;
  productionId: string;
  actorId: string;
  expectedMutationSeq: number;
  categoryId: string | null;
  title: string;
  amount: string | null;
  currency?: string;
  exchangeRate?: string | null;
  exchangeRateDate?: string | null;
  exchangeRateSource?: string | null;
  merchant?: string;
  occurredOn?: string | null;
  note: string;
  invoiceRequirement: InvoiceRequirement | null;
  invoiceWaiverReason: string;
}): Promise<Expense> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const draftCurrency = await validateDraftCurrency(
      client, params.productionId, params.amount, params.currency ?? "CNY", params,
    );
    const updated = await client.query<{ mutation_seq: string }>(
      `UPDATE production_expense
          SET budget_item_id = $5,
              category_id = (SELECT legacy_category_id FROM production_budget_item WHERE id = $5),
              title = $6, amount = $7::numeric, currency = $8, base_currency = $9,
              base_amount = NULL, exchange_rate = $10::numeric,
              exchange_rate_date = $11::date, exchange_rate_source = $12,
              merchant = $13, occurred_on = $14::date, note = $15,
              invoice_requirement = $16, invoice_waiver_reason = $17,
              mutation_seq = mutation_seq + 1, updated_at = now()
        WHERE id = $1 AND production_id = $2 AND submitted_by = $3
          AND status = 'draft' AND mutation_seq = $4
        RETURNING mutation_seq`,
      [
        params.expenseId, params.productionId, params.actorId, params.expectedMutationSeq,
        params.categoryId, params.title.trim(), params.amount, draftCurrency.currency,
        draftCurrency.baseCurrency, draftCurrency.exchangeRate,
        draftCurrency.exchangeRateDate, draftCurrency.exchangeRateSource,
        params.merchant?.trim() ?? "", params.occurredOn ?? null, params.note,
        params.invoiceRequirement,
        params.invoiceRequirement === "waived" ? params.invoiceWaiverReason.trim() : "",
      ],
    );
    if (!updated.rows[0]) {
      const { rows } = await client.query<{ status: ExpenseStatus; mutation_seq: string }>(
        "SELECT status, mutation_seq FROM production_expense WHERE id = $1 AND production_id = $2 AND submitted_by = $3",
        [params.expenseId, params.productionId, params.actorId],
      );
      throw new FinanceError(
        rows[0]?.status === "draft" ? "stale" : "invalid_state",
        rows[0]?.status === "draft" ? "草稿已在其他页面更新，请刷新后重试" : "只有草稿可以编辑",
      );
    }
    const mutationSeq = Number(updated.rows[0].mutation_seq);
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: "draft_saved",
      actorId: params.actorId,
      mutationSeq,
      details: { fields: ["title", "amount", "currency", "exchangeRate", "merchant", "occurredOn", "categoryId", "note", "invoiceRequirement"] },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const expense = await getExpense(params.expenseId, params.productionId);
  if (!expense) throw new Error(`expense not found after draft update: ${params.expenseId}`);
  return expense;
}

export async function reopenExpense(
  expenseId: string,
  productionId: string,
  actorId: string,
  expectedMutationSeq: number,
): Promise<Expense> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ mutation_seq: string }>(
      `UPDATE production_expense
          SET status = 'draft', current_stage = NULL, current_stage_depth = 0,
              current_approver_ids = '{}', escalation_chain = '[]'::jsonb,
              resolved_at = NULL, resolved_by = NULL,
              base_amount = NULL,
              mutation_seq = mutation_seq + 1, updated_at = now()
        WHERE id = $1 AND production_id = $2 AND submitted_by = $3
          AND status IN ('rejected', 'withdrawn') AND mutation_seq = $4
        RETURNING mutation_seq`,
      [expenseId, productionId, actorId, expectedMutationSeq],
    );
    if (!rows[0]) throw new FinanceError("conflict", "报销状态已变化，请刷新后重试");
    await appendExpenseEvent(client, {
      expenseId,
      type: "reopened",
      actorId,
      mutationSeq: Number(rows[0].mutation_seq),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const expense = await getExpense(expenseId, productionId);
  if (!expense) throw new Error(`expense not found after reopen: ${expenseId}`);
  return expense;
}

export async function submitExpenseDraft(
  expenseId: string,
  productionId: string,
  actorId: string,
  expectedMutationSeq: number,
): Promise<Expense> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      status: ExpenseStatus; submitted_by: string; category_id: string | null; title: string;
      amount: string | null; currency: string; merchant: string; occurred_on: string | null;
      exchange_rate: string | null; exchange_rate_date: string | null; exchange_rate_source: string | null;
      invoice_requirement: InvoiceRequirement | null;
      invoice_waiver_reason: string; mutation_seq: string;
    }>(
      `SELECT status, submitted_by, budget_item_id AS category_id, title, amount::text AS amount, currency,
              exchange_rate::text, exchange_rate_date::text, exchange_rate_source,
              merchant, occurred_on::text AS occurred_on,
              invoice_requirement, invoice_waiver_reason, mutation_seq
         FROM production_expense
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [expenseId, productionId],
    );
    const row = locked.rows[0];
    if (!row || row.submitted_by !== actorId)
      throw new FinanceError("invalid_state", "只能提交自己的报销草稿");
    if (row.status !== "draft") throw new FinanceError("conflict", "这笔报销已不再是草稿");
    if (Number(row.mutation_seq) !== expectedMutationSeq)
      throw new FinanceError("stale", "草稿已在其他页面更新，请刷新后重试");
    validateSubmittedExpense({
      title: row.title,
      amount: row.amount,
      invoiceRequirement: row.invoice_requirement,
      invoiceWaiverReason: row.invoice_waiver_reason,
    });
    const snapshot = await buildCurrencySnapshot(client, productionId, row.amount!, {
      currency: row.currency,
      exchangeRate: row.exchange_rate,
      exchangeRateDate: row.exchange_rate_date,
      exchangeRateSource: row.exchange_rate_source,
    }, { fromStorage: true });
    const plan = await buildExpenseSubmissionPlan(productionId, actorId, row.category_id);
    const evidence = await client.query<{ asset_file_id: string }>(
      `SELECT asset_file_id FROM production_expense_document
        WHERE expense_id = $1 ORDER BY created_at, id`,
      [expenseId],
    );
    await client.query(
      `UPDATE production_expense
          SET status = $5, current_stage = $6, current_stage_depth = $7,
              current_approver_ids = $8::uuid[], escalation_chain = $9::jsonb,
              resolved_at = $10, resolved_by = $11,
              base_currency = $12, base_amount = $13::numeric, exchange_rate = $14::numeric,
              exchange_rate_date = $15::date, exchange_rate_source = $16,
              submitted_at = now(), updated_at = now()
        WHERE id = $1 AND production_id = $2 AND submitted_by = $3
          AND status = 'draft' AND mutation_seq = $4`,
      [
        expenseId, productionId, actorId, expectedMutationSeq, plan.status,
        plan.first?.stage ?? null, plan.first?.depth ?? 0, plan.first?.approverIds ?? [],
        JSON.stringify(plan.chain), plan.selfApproved ? plan.actedAt : null,
        plan.selfApproved ? actorId : null, snapshot.baseCurrency, snapshot.baseAmount,
        snapshot.exchangeRate, snapshot.exchangeRateDate, snapshot.exchangeRateSource,
      ],
    );
    const evidenceAssetFileIds = evidence.rows.map(item => item.asset_file_id);
    await appendExpenseEvent(client, {
      expenseId,
      type: "submitted",
      actorId,
      mutationSeq: expectedMutationSeq,
      details: {
        title: row.title, amount: row.amount, currency: row.currency,
        baseCurrency: snapshot.baseCurrency, baseAmount: snapshot.baseAmount,
        exchangeRate: snapshot.exchangeRate, exchangeRateDate: snapshot.exchangeRateDate,
        exchangeRateSource: snapshot.exchangeRateSource,
        merchant: row.merchant, occurredOn: row.occurred_on,
        categoryId: row.category_id, evidenceAssetFileIds,
      },
    });
    if (plan.selfApproved) {
      await appendExpenseEvent(client, {
        expenseId,
        type: "approved",
        actorId,
        mutationSeq: expectedMutationSeq,
        details: { reason: "sole_approver", evidenceAssetFileIds },
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const expense = await getExpense(expenseId, productionId);
  if (!expense) throw new Error(`expense not found after submit: ${expenseId}`);
  return expense;
}

function positionOf(e: { currentStage: string | null; }, depth: number): StagePosition | null {
  return e.currentStage ? { stage: e.currentStage as StagePosition["stage"], depth } : null;
}

/**
 * 批准。当前级不能终局时**转发到下一级**而不是直接通过——与权限申请同一口径
 * （上级没有对应权限时只能转发）。
 *
 * first-action-wins：状态与所在级都要没被别人动过，否则回 conflict。
 */
export async function approveExpense(
  expenseId: string, productionId: string, actorId: string,
  options?: { expectedMutationSeq?: number; comment?: string },
): Promise<{ ok: true; forwarded: boolean } | { ok: false; reason: "conflict" | "not_pending" }> {
  const comment = normalizeApprovalComment(options?.comment);
  if (isApprovalCommentTooLong(comment))
    throw new FinanceError("invalid_state", "审批意见不能超过 500 字");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      status: ExpenseStatus; current_stage: string | null; current_stage_depth: number;
      current_approver_ids: string[]; submitted_by: string; category_id: string | null;
      escalation_chain: { canFinalize?: boolean }[]; mutation_seq: string;
    }>(
      `SELECT status, current_stage, current_stage_depth, current_approver_ids,
              submitted_by, budget_item_id AS category_id, escalation_chain, mutation_seq
         FROM production_expense
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [expenseId, productionId],
    );
    const expense = rows[0];
    if (!expense || expense.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_pending" };
    }
    if (!expense.current_approver_ids.includes(actorId)
        || (options?.expectedMutationSeq !== undefined
          && Number(expense.mutation_seq) !== options.expectedMutationSeq)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "conflict" };
    }
    const last = expense.escalation_chain[expense.escalation_chain.length - 1];
    const canFinalize = last?.canFinalize ?? true;
    const ladder = canFinalize ? [] : await buildApprovalLadder(
      expenseTarget(productionId, expense.submitted_by, expense.category_id),
    );
    const next = canFinalize ? null : nextStage(
      ladder,
      positionOf({ currentStage: expense.current_stage }, expense.current_stage_depth),
    );
    const actedAt = new Date().toISOString();
    const actionDetails = {
      action: next ? "escalated" : "approved",
      actorId,
      actedAt,
      ...(next ? { escalationReason: "forwarded" } : {}),
      ...(comment ? { comment } : {}),
    };
    if (next) {
      await client.query(
        `UPDATE production_expense
            SET current_stage = $3, current_stage_depth = $4,
                current_approver_ids = $5::uuid[],
                escalation_chain = jsonb_set(
                  escalation_chain,
                  ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                  (escalation_chain -> -1) || $6::jsonb
                ) || $7::jsonb,
                updated_at = now()
          WHERE id = $1 AND production_id = $2`,
        [
          expenseId, productionId, next.stage, next.depth, next.approverIds,
          JSON.stringify(actionDetails), JSON.stringify([chainEntry(next)]),
        ],
      );
      await appendExpenseEvent(client, {
        expenseId, type: "forwarded", actorId, comment,
        mutationSeq: Number(expense.mutation_seq),
        details: { fromStage: expense.current_stage, toStage: next.stage, toDepth: next.depth },
      });
      await client.query("COMMIT");
      return { ok: true, forwarded: true };
    }
    const evidence = await client.query<{ asset_file_id: string }>(
      `SELECT asset_file_id FROM production_expense_document
        WHERE expense_id = $1 ORDER BY created_at, id`,
      [expenseId],
    );
    await client.query(
      `UPDATE production_expense
          SET status = 'approved', resolved_at = now(), resolved_by = $3,
              current_stage = NULL, current_approver_ids = '{}',
              escalation_chain = jsonb_set(
                escalation_chain,
                ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                (escalation_chain -> -1) || $4::jsonb
              ), updated_at = now()
        WHERE id = $1 AND production_id = $2`,
      [expenseId, productionId, actorId, JSON.stringify(actionDetails)],
    );
    await appendExpenseEvent(client, {
      expenseId, type: "approved", actorId, comment,
      mutationSeq: Number(expense.mutation_seq),
      details: { evidenceAssetFileIds: evidence.rows.map(item => item.asset_file_id) },
    });
    await client.query("COMMIT");
    return { ok: true, forwarded: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectExpense(
  expenseId: string, productionId: string, actorId: string,
  options: { expectedMutationSeq?: number; comment: string },
): Promise<{ ok: boolean }> {
  const comment = normalizeApprovalComment(options.comment);
  if (!comment) throw new FinanceError("invalid_state", "请填写驳回理由");
  if (isApprovalCommentTooLong(comment))
    throw new FinanceError("invalid_state", "驳回理由不能超过 500 字");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      status: ExpenseStatus; current_approver_ids: string[]; mutation_seq: string;
    }>(
      `SELECT status, current_approver_ids, mutation_seq FROM production_expense
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [expenseId, productionId],
    );
    const expense = rows[0];
    if (!expense || expense.status !== "pending" || !expense.current_approver_ids.includes(actorId)
        || (options.expectedMutationSeq !== undefined
          && Number(expense.mutation_seq) !== options.expectedMutationSeq)) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    const action = { action: "rejected", actorId, actedAt: new Date().toISOString(), comment };
    await client.query(
      `UPDATE production_expense
          SET status = 'rejected', resolved_at = now(), resolved_by = $3,
              current_stage = NULL, current_approver_ids = '{}',
              escalation_chain = jsonb_set(
                escalation_chain,
                ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                (escalation_chain -> -1) || $4::jsonb
              ), updated_at = now()
        WHERE id = $1 AND production_id = $2`,
      [expenseId, productionId, actorId, JSON.stringify(action)],
    );
    await appendExpenseEvent(client, {
      expenseId, type: "rejected", actorId, comment,
      mutationSeq: Number(expense.mutation_seq),
    });
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 确认线下已结清。这里只记录剧组的协作确认，不发起、验证或描述任何真实资金流。
 */
export async function confirmExpenseSettlement(params: {
  expenseId: string;
  productionId: string;
  actorId: string;
  expectedMutationSeq: number;
}): Promise<{ ok: boolean; submittedBy?: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ mutation_seq: string; submitted_by: string }>(
      `UPDATE production_expense
          SET settled_at = clock_timestamp(), settled_by = $3,
              mutation_seq = mutation_seq + 1, updated_at = now()
        WHERE id = $1 AND production_id = $2
          AND status = 'approved' AND settled_at IS NULL
          AND mutation_seq = $4
        RETURNING mutation_seq, submitted_by`,
      [params.expenseId, params.productionId, params.actorId, params.expectedMutationSeq],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: "settled",
      actorId: params.actorId,
      mutationSeq: Number(row.mutation_seq),
      details: { meaning: "offline_settlement_confirmed" },
    });
    await client.query("COMMIT");
    return { ok: true, submittedBy: row.submitted_by };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 恢复为待结清只纠正系统记录，不表示任何真实款项被撤回。 */
export async function reopenExpenseSettlement(params: {
  expenseId: string;
  productionId: string;
  actorId: string;
  expectedMutationSeq: number;
}): Promise<{ ok: boolean; submittedBy?: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ mutation_seq: string; submitted_by: string }>(
      `UPDATE production_expense
          SET settled_at = NULL, settled_by = NULL,
              mutation_seq = mutation_seq + 1, updated_at = now()
        WHERE id = $1 AND production_id = $2
          AND status = 'approved' AND settled_at IS NOT NULL
          AND mutation_seq = $3
        RETURNING mutation_seq, submitted_by`,
      [params.expenseId, params.productionId, params.expectedMutationSeq],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: "settlement_reopened",
      actorId: params.actorId,
      mutationSeq: Number(row.mutation_seq),
      details: { meaning: "record_correction_only" },
    });
    await client.query("COMMIT");
    return { ok: true, submittedBy: row.submitted_by };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 撤回：只有提交人自己，且还在 pending。 */
export async function withdrawExpense(
  expenseId: string, productionId: string, actorId: string, expectedMutationSeq?: number,
): Promise<{ ok: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ mutation_seq: string }>(
      `SELECT mutation_seq FROM production_expense
        WHERE id = $1 AND production_id = $2 AND submitted_by = $3 AND status = 'pending'
        FOR UPDATE`,
      [expenseId, productionId, actorId],
    );
    if (!rows[0] || (expectedMutationSeq !== undefined
      && Number(rows[0].mutation_seq) !== expectedMutationSeq)) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    const action = {
      action: "cancelled", actorId, actedAt: new Date().toISOString(), cancelReason: "by_subject",
    };
    await client.query(
      `UPDATE production_expense
          SET status = 'withdrawn', resolved_at = now(), resolved_by = $3,
              current_stage = NULL, current_approver_ids = '{}',
              escalation_chain = jsonb_set(
                escalation_chain,
                ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                (escalation_chain -> -1) || $4::jsonb
              ), updated_at = now()
        WHERE id = $1 AND production_id = $2`,
      [expenseId, productionId, actorId, JSON.stringify(action)],
    );
    await appendExpenseEvent(client, {
      expenseId, type: "withdrawn", actorId,
      mutationSeq: Number(rows[0].mutation_seq),
    });
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 他是不是这笔支出当前级的审批人。 */
export async function isExpenseApprover(
  expenseId: string, productionId: string, actorId: string,
): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM production_expense
        WHERE id = $1 AND production_id = $2 AND status = 'pending'
          AND current_approver_ids @> ARRAY[$3]::uuid[]
     ) AS exists`,
    [expenseId, productionId, actorId],
  );
  return res.rows[0].exists;
}

// ─── 超时升级 ─────────────────────────────────────────────────────────────────

/**
 * 当前级超时未响应即升级到阶梯下一级。由内部 cron 端点调用，与权限申请同一个节拍。
 *
 * 两处照抄 escalateExpiredApprovals 的口径，都是踩过的坑：
 *
 * 1. **计时起点是「当前级被通知的时刻」**（链末条 notifiedAt），不是提交时刻——
 *    否则多级阶梯会在同一个 TTL 里被连着跳完。
 * 2. **LEFT JOIN + COALESCE 而非 INNER JOIN**：production_approval_config 是后加的
 *    表，建表 SQL 没有回填，早于它的演出一行都没有。INNER JOIN 会让这些演出的支出
 *    **永远**匹配不上、一次也升不了级（权限申请那边就这么静默死过：线上 8 个演出
 *    全部缺行，整条升级链自 Phase 7 起是死的）。缺配置 = 按列默认值计时，
 *    不是「不升级」。
 *
 * 已在链顶且仍有他人可处理时不再升级；若人员变化后只剩提交人自己，则按提交时的
 * 同一规则自动自批，避免原待办永久挂起。
 */
export async function escalateExpiredExpenses(): Promise<{ escalated: number }> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string; production_id: string; submitted_by: string; category_id: string | null;
    current_stage: string | null; current_stage_depth: number;
  }>(
    `SELECT e.id, e.production_id, e.submitted_by, e.budget_item_id AS category_id,
            e.current_stage, e.current_stage_depth
       FROM production_expense e
       LEFT JOIN production_approval_config pac ON pac.production_id = e.production_id
      WHERE e.status = 'pending'
        AND COALESCE((e.escalation_chain -> -1 ->> 'notifiedAt')::timestamptz, e.created_at)
            < now() - (COALESCE(pac.ttl_hours, $1) || ' hours')::INTERVAL`,
    [DEFAULT_APPROVAL_TTL_HOURS],
  );

  let escalated = 0;
  for (const row of rows) {
    const candidateLadder = await buildApprovalCandidateLadder(
      expenseTarget(row.production_id, row.submitted_by, row.category_id),
    );
    const ladder = withoutSubject(candidateLadder, row.submitted_by);
    const next = nextStage(
      ladder,
      positionOf({ currentStage: row.current_stage }, row.current_stage_depth),
    );
    if (!next) {
      if (!isSoleCandidate(candidateLadder, row.submitted_by)) continue;
      const actedAt = new Date().toISOString();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ mutation_seq: string }>(
          `SELECT mutation_seq FROM production_expense
            WHERE id = $1 AND status = 'pending'
              AND current_stage IS NOT DISTINCT FROM $2 FOR UPDATE`,
          [row.id, row.current_stage],
        );
        if (!locked.rows[0]) {
          await client.query("ROLLBACK");
          continue;
        }
        const evidence = await client.query<{ asset_file_id: string }>(
          `SELECT asset_file_id FROM production_expense_document
            WHERE expense_id = $1 ORDER BY created_at, id`,
          [row.id],
        );
        // resolved_by 记唯一审批人；真正的触发方由链条与事件的 bySystem 区分。
        await client.query(
          `UPDATE production_expense
              SET status = 'approved', resolved_at = now(), resolved_by = $3,
                  current_stage = NULL, current_approver_ids = '{}',
                  escalation_chain = escalation_chain || $2::jsonb, updated_at = now()
            WHERE id = $1`,
          [row.id, JSON.stringify([selfApprovalEntry(row.submitted_by, actedAt, true)]), row.submitted_by],
        );
        await appendExpenseEvent(client, {
          expenseId: row.id,
          type: "approved",
          actorId: row.submitted_by,
          mutationSeq: Number(locked.rows[0].mutation_seq),
          details: {
            reason: "sole_approver_after_timeout",
            bySystem: true,
            evidenceAssetFileIds: evidence.rows.map(item => item.asset_file_id),
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ mutation_seq: string }>(
        `SELECT mutation_seq FROM production_expense
          WHERE id = $1 AND status = 'pending'
            AND current_stage IS NOT DISTINCT FROM $2 FOR UPDATE`,
        [row.id, row.current_stage],
      );
      if (!locked.rows[0]) {
        await client.query("ROLLBACK");
        continue;
      }
      const action = {
        action: "escalated", bySystem: true, actedAt: new Date().toISOString(),
        escalationReason: "timeout",
      };
      await client.query(
        `UPDATE production_expense
            SET current_stage = $2, current_stage_depth = $3,
                current_approver_ids = $4::uuid[],
                escalation_chain = jsonb_set(
                  escalation_chain,
                  ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                  (escalation_chain -> -1) || $5::jsonb
                ) || $6::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [row.id, next.stage, next.depth, next.approverIds, JSON.stringify(action), JSON.stringify([chainEntry(next)])],
      );
      await appendExpenseEvent(client, {
        expenseId: row.id,
        type: "forwarded",
        actorId: null,
        mutationSeq: Number(locked.rows[0].mutation_seq),
        details: {
          reason: "timeout", bySystem: true,
          fromStage: row.current_stage, toStage: next.stage, toDepth: next.depth,
        },
      });
      await client.query("COMMIT");
      escalated++;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { escalated };
}
