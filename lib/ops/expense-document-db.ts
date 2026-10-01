/** 报销凭证归属校验与提交后的追加、草稿移除。 */

import type { PoolClient } from "pg";
import { uid } from "../asset/db";
import { getPool } from "../pg";
import {
  FinanceError, appendExpenseEvent, getExpense,
  type Expense, type ExpenseDocumentKind, type ExpenseStatus, type InvoiceRequirement,
} from "./expense-read-db";

export async function lockOwnedExpenseDocumentFiles(
  client: PoolClient,
  productionId: string,
  uploaderUserId: string,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const files = await client.query<{ id: string }>(
    `SELECT af.id
       FROM asset_file af
       JOIN asset a ON a.id = af.asset_id
      WHERE af.id = ANY($1::text[])
        AND a.production_id = $2
        AND a.uploader_user_id = $3
        AND a.asset_type = 'financial_document'
        AND a.file_version_policy = 'single'
        AND a.storage_type = 'r2'
      FOR UPDATE OF af, a`,
    [fileIds, productionId, uploaderUserId],
  );
  if (files.rows.length !== fileIds.length)
    throw new FinanceError("invalid_document", "凭证不存在、已失效或不属于当前提交人");
}

/**
 * 待补票只允许追加不可变证据，不允许覆盖或移除审批时已经存在的文件。
 * pending 与 approved 都可补：后者覆盖“先批后补票”，不改动原审批结论。
 */
export async function addExpenseDocument(params: {
  expenseId: string;
  productionId: string;
  submittedBy: string;
  assetFileId: string;
  kind: ExpenseDocumentKind;
  expectedMutationSeq: number;
}): Promise<Expense> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const expense = await client.query<{
      status: ExpenseStatus; submitted_by: string; mutation_seq: string;
      invoice_requirement: InvoiceRequirement | null; has_invoice: boolean;
    }>(
      `SELECT e.status, e.submitted_by, e.mutation_seq, e.invoice_requirement,
              EXISTS (
                SELECT 1 FROM production_expense_document d
                 WHERE d.expense_id = e.id AND d.document_kind = 'invoice'
              ) AS has_invoice
         FROM production_expense e
        WHERE e.id = $1 AND e.production_id = $2 FOR UPDATE`,
      [params.expenseId, params.productionId],
    );
    const row = expense.rows[0];
    if (!row || row.submitted_by !== params.submittedBy)
      throw new FinanceError("invalid_document", "只能为自己提交的报销补充凭证");
    if (Number(row.mutation_seq) !== params.expectedMutationSeq)
      throw new FinanceError("stale", "报销内容已变化，请刷新后重试");
    if (row.status !== "draft") {
      if (row.status !== "pending" && row.status !== "approved")
        throw new FinanceError("invalid_state", "请先进入编辑状态再补充凭证");
      if (row.invoice_requirement !== "required" || row.has_invoice || params.kind !== "invoice")
        throw new FinanceError("invalid_state", "审批开始后只能为待补发票的报销追加缺失发票");
    }

    await lockOwnedExpenseDocumentFiles(
      client, params.productionId, params.submittedBy, [params.assetFileId],
    );
    await client.query(
      `INSERT INTO production_expense_document
         (id, expense_id, asset_file_id, document_kind, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,clock_timestamp())`,
      [uid("edoc"), params.expenseId, params.assetFileId, params.kind, params.submittedBy],
    );
    const mutationSeq = params.expectedMutationSeq + 1;
    await client.query(
      `UPDATE production_expense
          SET mutation_seq = $3, updated_at = now()
        WHERE id = $1 AND production_id = $2`,
      [params.expenseId, params.productionId, mutationSeq],
    );
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: row.status === "approved" ? "post_approval_document_added" : "document_added",
      actorId: params.submittedBy,
      mutationSeq,
      details: {
        assetFileId: params.assetFileId,
        kind: params.kind,
        approvalBasis: row.status === "approved" ? "after_approval" : "current",
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof Error && error.message.includes("production_expense_document_expense_id_asset_file_id_key"))
      throw new FinanceError("invalid_document", "这份凭证已经添加过了");
    throw error;
  } finally {
    client.release();
  }
  const updated = await getExpense(params.expenseId, params.productionId);
  if (!updated) throw new Error(`expense not found after adding document: ${params.expenseId}`);
  return updated;
}

export async function removeExpenseDocument(params: {
  expenseId: string;
  productionId: string;
  submittedBy: string;
  assetFileId: string;
  expectedMutationSeq: number;
}): Promise<{ expense: Expense; assetId: string }> {
  const client = await getPool().connect();
  let assetId = "";
  try {
    await client.query("BEGIN");
    const expense = await client.query<{ status: ExpenseStatus; submitted_by: string; mutation_seq: string }>(
      `SELECT status, submitted_by, mutation_seq FROM production_expense
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [params.expenseId, params.productionId],
    );
    const row = expense.rows[0];
    if (!row || row.submitted_by !== params.submittedBy)
      throw new FinanceError("invalid_document", "只能修改自己的报销草稿");
    if (row.status !== "draft")
      throw new FinanceError("invalid_state", "提交后不能移除、替换或重新分类凭证");
    if (Number(row.mutation_seq) !== params.expectedMutationSeq)
      throw new FinanceError("stale", "草稿已在其他页面更新，请刷新后重试");
    const removed = await client.query<{ asset_id: string }>(
      `DELETE FROM production_expense_document d
        USING asset_file af
        WHERE d.expense_id = $1 AND d.asset_file_id = $2 AND af.id = d.asset_file_id
        RETURNING af.asset_id`,
      [params.expenseId, params.assetFileId],
    );
    if (!removed.rows[0]) throw new FinanceError("invalid_document", "凭证不存在");
    assetId = removed.rows[0].asset_id;
    const mutationSeq = params.expectedMutationSeq + 1;
    await client.query(
      "UPDATE production_expense SET mutation_seq = $2, updated_at = now() WHERE id = $1",
      [params.expenseId, mutationSeq],
    );
    await appendExpenseEvent(client, {
      expenseId: params.expenseId,
      type: "document_removed",
      actorId: params.submittedBy,
      mutationSeq,
      details: { assetFileId: params.assetFileId },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const expense = await getExpense(params.expenseId, params.productionId);
  if (!expense || !assetId) throw new Error(`expense not found after document removal: ${params.expenseId}`);
  return { expense, assetId };
}
