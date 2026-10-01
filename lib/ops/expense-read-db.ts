/** 报销列表、详情、参与者可见性与永久事件读取。 */

import { getPool } from "../pg";
import type { PoolClient } from "pg";
import { uid } from "../asset/db";
import { expenseRecognitionVersions } from "./expense-document-recognition";
import type { ExpenseDocumentRecognition } from "./expense-recognition-types";

export type ExpenseStatus = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export type InvoiceRequirement = "required" | "waived";
export type ExpenseDocumentKind = "invoice" | "receipt" | "other";

export type ExpenseDocument = {
  id: string;
  assetId: string;
  assetFileId: string;
  kind: ExpenseDocumentKind;
  fileName: string;
  mimeType: string | null;
  createdAt: string;
  recognition: ExpenseDocumentRecognition | null;
};

export type Expense = {
  id: string;
  productionId: string;
  categoryId: string | null;
  categoryName: string | null;
  title: string;
  amount: string | null;
  currency: string;
  merchant: string;
  occurredOn: string | null;
  note: string;
  invoiceRequirement: InvoiceRequirement | null;
  invoiceWaiverReason: string;
  invoiceState: "provided" | "pending" | "waived" | "legacy";
  documents: ExpenseDocument[];
  submittedBy: string;
  submitterName: string | null;
  status: ExpenseStatus;
  currentStage: string | null;
  currentApproverIds: string[];
  /** 当前级能否终局。false = 前端该显示「转发」而非「批准」（同权限申请的口径）。 */
  canFinalize: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  mutationSeq: number;
  submittedAt: string | null;
  createdAt: string;
};

export type ExpenseEventType =
  | "draft_created" | "draft_saved" | "submitted" | "forwarded"
  | "approved" | "rejected" | "withdrawn" | "reopened"
  | "document_added" | "document_removed" | "post_approval_document_added";

export type ExpenseEvent = {
  id: string;
  type: ExpenseEventType;
  actorId: string | null;
  actorName: string | null;
  comment: string | null;
  mutationSeq: number;
  details: Record<string, unknown>;
  createdAt: string;
};

export type ExpenseDetail = Expense & { events: ExpenseEvent[] };

/**
 * 金额的线格式：最多 12 位整数 + 最多两位小数，非负。
 *
 * 放在这里而不是各路由各写一份——三个入口（建科目 / 改科目 / 建支出）本来就抄了三遍，
 * 抄本之间一旦漂移，就会出现「这个口能存、那个口存不进」的怪事，而两边都不报错。
 * 与 NUMERIC(14,2) 对齐：12 位整数 + 2 位小数 = 14。
 */
export const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

export function isExpenseDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export class FinanceError extends Error {
  constructor(
    readonly reason: "duplicate_name" | "no_approver" | "conflict" | "not_pending" | "forward_only"
      | "invalid_document" | "invalid_state" | "stale",
    message: string,
  ) { super(message); }
}

// ─── 支出 ─────────────────────────────────────────────────────────────────────

type ExpenseRow = {
  id: string; production_id: string; category_id: string | null; category_name: string | null;
  title: string; amount: string | null; currency: string; merchant: string; occurred_on: string | null; note: string;
  invoice_requirement: InvoiceRequirement | null; invoice_waiver_reason: string;
  documents: ExpenseDocument[];
  submitted_by: string; submitter_name: string | null; status: ExpenseStatus;
  current_stage: string | null; current_stage_depth: number; current_approver_ids: string[];
  escalation_chain: { canFinalize?: boolean }[];
  resolved_at: Date | null; resolved_by: string | null; mutation_seq: string;
  submitted_at: Date | null; created_at: Date;
};

function rowToExpense(r: ExpenseRow): Expense {
  const versions = expenseRecognitionVersions();
  const documents = r.documents.map(document => ({
    ...document,
    recognition: document.recognition ? {
      ...document.recognition,
      outdated: document.recognition.parserVersion !== versions.parserVersion
        || document.recognition.modelVersion !== versions.modelVersion,
    } : null,
  }));
  const last = r.escalation_chain[r.escalation_chain.length - 1];
  const invoiceState = r.invoice_requirement === null
    ? "legacy"
    : r.invoice_requirement === "waived"
      ? "waived"
      : documents.some(document => document.kind === "invoice") ? "provided" : "pending";
  return {
    id: r.id, productionId: r.production_id,
    categoryId: r.category_id, categoryName: r.category_name,
    title: r.title, amount: r.amount, currency: r.currency,
    merchant: r.merchant, occurredOn: r.occurred_on, note: r.note,
    invoiceRequirement: r.invoice_requirement,
    invoiceWaiverReason: r.invoice_waiver_reason,
    invoiceState,
    documents,
    submittedBy: r.submitted_by, submitterName: r.submitter_name,
    status: r.status,
    currentStage: r.current_stage,
    currentApproverIds: r.current_approver_ids,
    canFinalize: last?.canFinalize ?? true,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolvedBy: r.resolved_by,
    mutationSeq: Number(r.mutation_seq),
    submittedAt: r.submitted_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

const EXPENSE_QUERY = `
  SELECT e.id, e.production_id, e.budget_item_id AS category_id, c.name AS category_name,
         e.title, e.amount::text AS amount, e.currency, e.merchant,
         e.occurred_on::text AS occurred_on, e.note,
         e.invoice_requirement, e.invoice_waiver_reason,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', d.id,
             'assetId', a.id,
             'assetFileId', af.id,
             'kind', d.document_kind,
             'fileName', a.file_name,
             'mimeType', a.mime_type,
             'createdAt', d.created_at,
             'recognition', CASE WHEN r.asset_file_id IS NULL THEN NULL ELSE jsonb_build_object(
               'status', r.status,
               'sourceKind', r.source_kind,
               'result', r.result,
               'parserVersion', r.parser_version,
               'modelVersion', r.model_version,
               'outdated', false,
               'lastError', r.last_error,
               'attempts', r.attempts,
               'updatedAt', r.updated_at
             ) END
           ) ORDER BY d.created_at)
             FROM production_expense_document d
             JOIN asset_file af ON af.id = d.asset_file_id
             JOIN asset a ON a.id = af.asset_id
             LEFT JOIN expense_document_recognition r ON r.asset_file_id = af.id
            WHERE d.expense_id = e.id
         ), '[]'::jsonb) AS documents,
         e.submitted_by,
         COALESCE(NULLIF(up.display_name, ''), up.name) AS submitter_name,
         e.status, e.current_stage, e.current_stage_depth, e.current_approver_ids,
         e.escalation_chain, e.resolved_at, e.resolved_by, e.mutation_seq,
         e.submitted_at, e.created_at
    FROM production_expense e
    LEFT JOIN production_budget_item bi ON bi.id = e.budget_item_id
    LEFT JOIN production_expense_category c ON c.id = bi.category_id
    LEFT JOIN user_profile up ON up.user_id = e.submitted_by`;

/**
 * 支出列表。不给 filter = 全项目（需要 expenses@view）。
 *
 * 两个筛法对应**上下文可见性**，不需要任何权限键：
 *   - submittedBy：自己交的单子自己永远看得见。否则「谁都可以填报销单」会变成
 *     「填完就消失」，除非把全剧组每一笔花在哪儿都摊开给他。
 *   - pendingFor：待我审批的。POC 被 buildApprovalLadder 算进阶梯，就得有地方看见
 *     要他批的东西——这条与他有没有 expenses@view 无关。
 *
 * 两个筛法同时给 = 并集（我交的 ∪ 待我批的），这正是普通成员在财务页看到的东西。
 */
export async function listExpenses(
  productionId: string,
  filter?: { submittedBy?: string; pendingFor?: string },
): Promise<Expense[]> {
  const params: unknown[] = [productionId];
  const ors: string[] = [];
  if (filter?.submittedBy) ors.push(`e.submitted_by = $${params.push(filter.submittedBy)}`);
  if (filter?.pendingFor)
    ors.push(`(e.status = 'pending' AND e.current_approver_ids @> ARRAY[$${params.push(filter.pendingFor)}]::uuid[])`);
  const where = ors.length ? ` AND (${ors.join(" OR ")})` : "";
  const res = await getPool().query<ExpenseRow>(
    `${EXPENSE_QUERY} WHERE e.production_id = $1${where} ORDER BY e.created_at DESC`,
    params,
  );
  return res.rows.map(rowToExpense);
}

export async function getExpense(id: string, productionId: string): Promise<Expense | null> {
  const res = await getPool().query<ExpenseRow>(
    `${EXPENSE_QUERY} WHERE e.id = $1 AND e.production_id = $2`,
    [id, productionId],
  );
  return res.rows[0] ? rowToExpense(res.rows[0]) : null;
}

export async function appendExpenseEvent(
  client: PoolClient,
  params: {
    expenseId: string;
    type: ExpenseEventType;
    actorId?: string | null;
    comment?: string | null;
    mutationSeq: number;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO production_expense_event
       (id, expense_id, event_type, actor_id, comment, mutation_seq, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,clock_timestamp())`,
    [
      uid("eevt"), params.expenseId, params.type, params.actorId ?? null,
      params.comment ?? null, params.mutationSeq, JSON.stringify(params.details ?? {}),
    ],
  );
}

export async function getExpenseDetail(id: string, productionId: string): Promise<ExpenseDetail | null> {
  const expense = await getExpense(id, productionId);
  if (!expense) return null;
  const { rows } = await getPool().query<{
    id: string; event_type: ExpenseEventType; actor_id: string | null; actor_name: string | null;
    comment: string | null; mutation_seq: string; details: Record<string, unknown>; created_at: Date;
  }>(
    `SELECT ev.id, ev.event_type, ev.actor_id,
            COALESCE(NULLIF(up.display_name, ''), up.name) AS actor_name,
            ev.comment, ev.mutation_seq, ev.details, ev.created_at
       FROM production_expense_event ev
       LEFT JOIN user_profile up ON up.user_id = ev.actor_id
      WHERE ev.expense_id = $1
      ORDER BY ev.created_at, ev.id`,
    [id],
  );
  return {
    ...expense,
    events: rows.map(row => ({
      id: row.id,
      type: row.event_type,
      actorId: row.actor_id,
      actorName: row.actor_name,
      comment: row.comment,
      mutationSeq: Number(row.mutation_seq),
      details: row.details,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function hasExpenseParticipation(
  expenseId: string,
  productionId: string,
  actorId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM production_expense e
        WHERE e.id = $1 AND e.production_id = $2
          AND (
            e.submitted_by = $3
            OR e.current_approver_ids @> ARRAY[$3]::uuid[]
            OR EXISTS (
              SELECT 1 FROM production_expense_event ev
               WHERE ev.expense_id = e.id AND ev.actor_id = $3
            )
          )
     ) AS allowed`,
    [expenseId, productionId, actorId],
  );
  return rows[0].allowed;
}

/**
 * 我的支出待办。
 *
 * 只读 `current_approver_ids`——那一列在提交/升级时由路由算好写死，收件箱不重算
 * （与 listPendingApprovals 同口径，#140 的教训：路由写三遍会漂）。
 */
/**
 * 跨项目的「待我审批」。单项目的同一问题用 listExpenses(pid, { pendingFor })——
 * 两处走同一个判据（current_approver_ids 含我），只是这支不限项目，供将来的全局
 * 收件箱用。判据写两遍会漂移，故这里只多一个 WHERE，其余共用 EXPENSE_QUERY。
 *
 * 尚无消费者：审批收件箱目前只渲染权限申请（components/approval/AccessRequestsClient.tsx），
 * 支出待办要不要并进同一个列表是 UX 决定。在那之前，POC 在财务页看得到要他批的东西。
 */
export async function listPendingExpenses(actorId: string, productionId?: string): Promise<Expense[]> {
  const params: unknown[] = [actorId];
  const prodClause = productionId ? `AND e.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<ExpenseRow>(
    `${EXPENSE_QUERY}
      WHERE e.status = 'pending'
        AND e.current_approver_ids @> ARRAY[$1]::uuid[]
        ${prodClause}
      ORDER BY e.created_at ASC`,
    params,
  );
  return res.rows.map(rowToExpense);
}
