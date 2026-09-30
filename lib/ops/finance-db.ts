/**
 * 财务：预算科目 + 支出审批。
 *
 * ## 审批复用路由，不复用表
 *
 * 「谁来批这笔支出」走 lib/approval/approval-routing.ts 的 {@link buildApprovalLadder}——与权限
 * 申请**同一个函数**，因为流程本来就一致：
 *
 *   直属上级链 → 资源持有者 → 共管部门 POC → 父部门 POC → 制作人 → owner
 *
 * 支出的 target 表达成 `finance/<科目id>/expenses`，于是「共管部门 POC」那一级自动
 * 变成「这个预算科目归哪个部门管」——建科目时往 resource_dept_manage 写一行即可，
 * 不用教路由认识预算科目。财务岗同理：把财务部门挂到 `finance/*` 上就成为一级。
 *
 * 但**状态存自己的表**：approval_request 的批准动作会去发权限行（expandLevelRows），
 * 支出批准绝不能发。共用表就得在批准路径上分叉，那比分表更容易出事。
 *
 * ## 收件箱是渲染层的合并，不是数据层的合并
 *
 * {@link listPendingExpenses} 单独返回支出待办，调用方（收件箱）自己把它和权限申请
 * 并起来显示，每条带 `kind` 判别标签。将来 UX 要拆成两个列表，前端加个 filter 就行，
 * 后端零改动——反过来（把支出硬塞进 ApprovalRequest 的形状）拆的时候要动数据层。
 */

import { getPool } from "../pg";
import type { PoolClient } from "pg";
import { uid } from "../asset/db";
import {
  buildApprovalCandidateLadder, buildApprovalLadder, DEFAULT_APPROVAL_TTL_HOURS, nextStage,
  type ApprovalStage, type StagePosition,
} from "../approval/approval-routing";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BudgetCategory = {
  id: string;
  productionId: string;
  name: string;
  /** 字符串而非 number：NUMERIC(14,2) 过 JS number 会丢精度 */
  amount: string;
  currency: string;
  deptId: string | null;
  deptName: string | null;
  orderIndex: number;
  notes: string;
  /** 该科目下已批准支出的合计 */
  spent: string;
  createdAt: string;
};

export type ExpenseStatus = "pending" | "approved" | "rejected" | "cancelled";
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
};

export type Expense = {
  id: string;
  productionId: string;
  categoryId: string | null;
  categoryName: string | null;
  title: string;
  amount: string;
  currency: string;
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
  createdAt: string;
};

/**
 * 金额的线格式：最多 12 位整数 + 最多两位小数，非负。
 *
 * 放在这里而不是各路由各写一份——三个入口（建科目 / 改科目 / 建支出）本来就抄了三遍，
 * 抄本之间一旦漂移，就会出现「这个口能存、那个口存不进」的怪事，而两边都不报错。
 * 与 NUMERIC(14,2) 对齐：12 位整数 + 2 位小数 = 14。
 */
export const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

export class FinanceError extends Error {
  constructor(
    readonly reason: "duplicate_name" | "no_approver" | "conflict" | "not_pending" | "forward_only" | "invalid_document",
    message: string,
  ) { super(message); }
}

// ─── 预算科目 ─────────────────────────────────────────────────────────────────

type CategoryRow = {
  id: string; production_id: string; name: string; amount: string; currency: string;
  dept_id: string | null; dept_name: string | null; order_index: number; notes: string;
  spent: string; created_at: Date;
};

function rowToCategory(r: CategoryRow): BudgetCategory {
  return {
    id: r.id, productionId: r.production_id, name: r.name,
    amount: r.amount, currency: r.currency,
    deptId: r.dept_id, deptName: r.dept_name,
    orderIndex: r.order_index, notes: r.notes,
    spent: r.spent, createdAt: r.created_at.toISOString(),
  };
}

const CATEGORY_QUERY = `
  SELECT c.id, c.production_id, c.name, c.amount::text AS amount, c.currency,
         c.dept_id, d.name AS dept_name, c.order_index, c.notes, c.created_at,
         COALESCE((SELECT SUM(e.amount) FROM production_expense e
                    WHERE e.category_id = c.id AND e.status = 'approved'), 0)::text AS spent
    FROM production_budget_category c
    LEFT JOIN production_dept d ON d.id = c.dept_id`;

export async function listBudgetCategories(productionId: string): Promise<BudgetCategory[]> {
  const res = await getPool().query<CategoryRow>(
    `${CATEGORY_QUERY} WHERE c.production_id = $1 ORDER BY c.order_index, c.name`,
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
    `SELECT c.id, c.name, d.name AS dept_name
       FROM production_budget_category c
       LEFT JOIN production_dept d ON d.id = c.dept_id
      WHERE c.production_id = $1
      ORDER BY c.order_index, c.name`,
    [productionId],
  );
  return res.rows.map(r => ({ id: r.id, name: r.name, deptName: r.dept_name }));
}

export async function getBudgetCategory(id: string, productionId: string): Promise<BudgetCategory | null> {
  const res = await getPool().query<CategoryRow>(
    `${CATEGORY_QUERY} WHERE c.id = $1 AND c.production_id = $2`,
    [id, productionId],
  );
  return res.rows[0] ? rowToCategory(res.rows[0]) : null;
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

export async function createBudgetCategory(params: {
  productionId: string; name: string; amount: string; currency?: string;
  deptId?: string | null; orderIndex?: number; notes?: string; createdBy: string;
}): Promise<BudgetCategory> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ id: string }>(
      `INSERT INTO production_budget_category
         (production_id, name, amount, currency, dept_id, order_index, notes, created_by)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8) RETURNING id`,
      [
        params.productionId, params.name.trim(), params.amount, params.currency ?? "CNY",
        params.deptId ?? null, params.orderIndex ?? 0, params.notes ?? "", params.createdBy,
      ],
    );
    await syncCategoryDeptManage(
      client, params.productionId, res.rows[0].id, params.deptId ?? null, params.createdBy,
    );
    await client.query("COMMIT");
    const created = await getBudgetCategory(res.rows[0].id, params.productionId);
    if (!created) throw new Error(`budget category not found after create: ${res.rows[0].id}`);
    return created;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && e.message.includes("pbc_name_idx"))
      throw new FinanceError("duplicate_name", "同名预算科目已存在");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateBudgetCategory(
  id: string, productionId: string, actorId: string,
  fields: { name?: string; amount?: string; deptId?: string | null; orderIndex?: number; notes?: string },
): Promise<BudgetCategory | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const sets: string[] = ["updated_at = now()"];
    const vals: unknown[] = [id, productionId];
    if (fields.name       !== undefined) sets.push(`name        = $${vals.push(fields.name.trim())}`);
    if (fields.amount     !== undefined) sets.push(`amount      = $${vals.push(fields.amount)}::numeric`);
    if (fields.deptId     !== undefined) sets.push(`dept_id     = $${vals.push(fields.deptId)}`);
    if (fields.orderIndex !== undefined) sets.push(`order_index = $${vals.push(fields.orderIndex)}`);
    if (fields.notes      !== undefined) sets.push(`notes       = $${vals.push(fields.notes)}`);

    const res = await client.query<{ id: string }>(
      `UPDATE production_budget_category SET ${sets.join(", ")}
        WHERE id = $1 AND production_id = $2 RETURNING id`,
      vals,
    );
    if (!res.rows[0]) { await client.query("ROLLBACK"); return null; }
    if (fields.deptId !== undefined) {
      await syncCategoryDeptManage(client, productionId, id, fields.deptId, actorId);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && e.message.includes("pbc_name_idx"))
      throw new FinanceError("duplicate_name", "同名预算科目已存在");
    throw e;
  } finally {
    client.release();
  }
  return getBudgetCategory(id, productionId);
}

/** 删科目。挂在它上面的支出 category_id 置空（ON DELETE SET NULL），不连坐删。 */
export async function deleteBudgetCategory(id: string, productionId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM resource_dept_manage
        WHERE production_id = $1 AND resource_type = 'finance' AND resource_id = $2`,
      [productionId, id],
    );
    await client.query(
      "DELETE FROM production_budget_category WHERE id = $1 AND production_id = $2",
      [id, productionId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── 支出 ─────────────────────────────────────────────────────────────────────

type ExpenseRow = {
  id: string; production_id: string; category_id: string | null; category_name: string | null;
  title: string; amount: string; currency: string; note: string;
  invoice_requirement: InvoiceRequirement | null; invoice_waiver_reason: string;
  documents: ExpenseDocument[];
  submitted_by: string; submitter_name: string | null; status: ExpenseStatus;
  current_stage: string | null; current_stage_depth: number; current_approver_ids: string[];
  escalation_chain: { canFinalize?: boolean }[];
  resolved_at: Date | null; resolved_by: string | null; created_at: Date;
};

function rowToExpense(r: ExpenseRow): Expense {
  const last = r.escalation_chain[r.escalation_chain.length - 1];
  const invoiceState = r.invoice_requirement === null
    ? "legacy"
    : r.invoice_requirement === "waived"
      ? "waived"
      : r.documents.some(document => document.kind === "invoice") ? "provided" : "pending";
  return {
    id: r.id, productionId: r.production_id,
    categoryId: r.category_id, categoryName: r.category_name,
    title: r.title, amount: r.amount, currency: r.currency, note: r.note,
    invoiceRequirement: r.invoice_requirement,
    invoiceWaiverReason: r.invoice_waiver_reason,
    invoiceState,
    documents: r.documents,
    submittedBy: r.submitted_by, submitterName: r.submitter_name,
    status: r.status,
    currentStage: r.current_stage,
    currentApproverIds: r.current_approver_ids,
    canFinalize: last?.canFinalize ?? true,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolvedBy: r.resolved_by,
    createdAt: r.created_at.toISOString(),
  };
}

const EXPENSE_QUERY = `
  SELECT e.id, e.production_id, e.category_id, c.name AS category_name,
         e.title, e.amount::text AS amount, e.currency, e.note,
         e.invoice_requirement, e.invoice_waiver_reason,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id', d.id,
             'assetId', a.id,
             'assetFileId', af.id,
             'kind', d.document_kind,
             'fileName', a.file_name,
             'mimeType', a.mime_type,
             'createdAt', d.created_at
           ) ORDER BY d.created_at)
             FROM production_expense_document d
             JOIN asset_file af ON af.id = d.asset_file_id
             JOIN asset a ON a.id = af.asset_id
            WHERE d.expense_id = e.id
         ), '[]'::jsonb) AS documents,
         e.submitted_by,
         COALESCE(NULLIF(up.display_name, ''), up.name) AS submitter_name,
         e.status, e.current_stage, e.current_stage_depth, e.current_approver_ids,
         e.escalation_chain, e.resolved_at, e.resolved_by, e.created_at
    FROM production_expense e
    LEFT JOIN production_budget_category c ON c.id = e.category_id
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

/** 支出的审批 target：把它表达成 finance 域的一个节点，路由就认得。 */
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

async function lockOwnedExpenseDocumentFiles(
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

export async function submitExpense(params: {
  productionId: string; categoryId: string | null; title: string;
  amount: string; currency?: string; note?: string; submittedBy: string;
  invoiceRequirement?: InvoiceRequirement;
  invoiceWaiverReason?: string;
  documents?: { assetFileId: string; kind: ExpenseDocumentKind }[];
}): Promise<Expense> {
  const candidateLadder = await buildApprovalCandidateLadder(
    expenseTarget(params.productionId, params.submittedBy, params.categoryId),
  );
  const selfApproved = isSoleCandidate(candidateLadder, params.submittedBy);
  const ladder = withoutSubject(candidateLadder, params.submittedBy);
  const first = ladder[0];
  if (!first && !selfApproved)
    throw new FinanceError("no_approver", "找不到这笔支出的审批人，请联系制作人");

  const actedAt = new Date().toISOString();
  const status: ExpenseStatus = selfApproved ? "approved" : "pending";
  const chain = selfApproved
    ? [selfApprovalEntry(params.submittedBy, actedAt)]
    : [chainEntry(first!)];

  const invoiceRequirement = params.invoiceRequirement ?? "required";
  const waiverReason = invoiceRequirement === "waived" ? params.invoiceWaiverReason?.trim() ?? "" : "";
  if (invoiceRequirement === "waived" && !waiverReason)
    throw new FinanceError("invalid_document", "请选择无发票原因");

  const documents = params.documents ?? [];
  const uniqueFileIds = [...new Set(documents.map(document => document.assetFileId))];
  if (uniqueFileIds.length !== documents.length)
    throw new FinanceError("invalid_document", "同一份凭证不能重复添加");

  const client = await getPool().connect();
  let expenseId: string | null = null;
  try {
    await client.query("BEGIN");
    await lockOwnedExpenseDocumentFiles(
      client, params.productionId, params.submittedBy, uniqueFileIds,
    );

    const res = await client.query<{ id: string }>(
      `INSERT INTO production_expense
         (production_id, category_id, title, amount, currency, note,
          invoice_requirement, invoice_waiver_reason, submitted_by,
          status, current_stage, current_stage_depth, current_approver_ids, escalation_chain,
          resolved_at, resolved_by)
       VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid[],$14::jsonb,$15,$16)
       RETURNING id`,
      [
        params.productionId, params.categoryId, params.title.trim(), params.amount,
        params.currency ?? "CNY", params.note ?? "", invoiceRequirement, waiverReason,
        params.submittedBy, status, first?.stage ?? null, first?.depth ?? 0,
        first?.approverIds ?? [], JSON.stringify(chain),
        selfApproved ? actedAt : null, selfApproved ? params.submittedBy : null,
      ],
    );
    expenseId = res.rows[0].id;
    for (const document of documents) {
      await client.query(
        `INSERT INTO production_expense_document
           (id, expense_id, asset_file_id, document_kind, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [uid("edoc"), expenseId, document.assetFileId, document.kind, params.submittedBy],
      );
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
}): Promise<Expense> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const expense = await client.query<{ status: ExpenseStatus; submitted_by: string }>(
      `SELECT status, submitted_by FROM production_expense
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [params.expenseId, params.productionId],
    );
    const row = expense.rows[0];
    if (!row || row.submitted_by !== params.submittedBy)
      throw new FinanceError("invalid_document", "只能为自己提交的报销补充凭证");
    if (row.status !== "pending" && row.status !== "approved")
      throw new FinanceError("not_pending", "已驳回或撤回的报销不能补充凭证");

    await lockOwnedExpenseDocumentFiles(
      client, params.productionId, params.submittedBy, [params.assetFileId],
    );
    await client.query(
      `INSERT INTO production_expense_document
         (id, expense_id, asset_file_id, document_kind, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [uid("edoc"), params.expenseId, params.assetFileId, params.kind, params.submittedBy],
    );
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
): Promise<{ ok: true; forwarded: boolean } | { ok: false; reason: "conflict" | "not_pending" }> {
  const pool = getPool();
  const row = await pool.query<{
    status: ExpenseStatus; current_stage: string | null; current_stage_depth: number;
    submitted_by: string; category_id: string | null; escalation_chain: { canFinalize?: boolean }[];
  }>(
    `SELECT status, current_stage, current_stage_depth, submitted_by, category_id, escalation_chain
       FROM production_expense WHERE id = $1 AND production_id = $2`,
    [expenseId, productionId],
  );
  const e = row.rows[0];
  if (!e) return { ok: false, reason: "not_pending" };
  if (e.status !== "pending") return { ok: false, reason: "not_pending" };

  const last = e.escalation_chain[e.escalation_chain.length - 1];
  const canFinalize = last?.canFinalize ?? true;

  if (canFinalize) {
    const upd = await pool.query<{ id: string }>(
      `UPDATE production_expense
         SET status = 'approved', resolved_at = now(), resolved_by = $3,
             current_stage = NULL, current_approver_ids = '{}', updated_at = now()
       WHERE id = $1 AND production_id = $2 AND status = 'pending'
         AND current_stage IS NOT DISTINCT FROM $4
         AND current_stage_depth = $5
         AND current_approver_ids @> ARRAY[$3]::uuid[]
       RETURNING id`,
      [expenseId, productionId, actorId, e.current_stage, e.current_stage_depth],
    );
    if (!upd.rows[0]) return { ok: false, reason: "conflict" };
    return { ok: true, forwarded: false };
  }

  // 转发：重算阶梯（期间的人事变动立刻生效，同权限申请的做法）
  const ladder = await buildApprovalLadder(
    expenseTarget(productionId, e.submitted_by, e.category_id),
  );
  const next = nextStage(ladder, positionOf({ currentStage: e.current_stage }, e.current_stage_depth));
  if (!next) {
    // 没有下一级可转 —— 当前级只能自己终局，否则这笔支出会永远挂着
    const upd = await pool.query<{ id: string }>(
      `UPDATE production_expense
         SET status = 'approved', resolved_at = now(), resolved_by = $3,
             current_stage = NULL, current_approver_ids = '{}', updated_at = now()
       WHERE id = $1 AND production_id = $2 AND status = 'pending'
         AND current_stage IS NOT DISTINCT FROM $4
         AND current_stage_depth = $5
         AND current_approver_ids @> ARRAY[$3]::uuid[]
       RETURNING id`,
      [expenseId, productionId, actorId, e.current_stage, e.current_stage_depth],
    );
    return upd.rows[0] ? { ok: true, forwarded: false } : { ok: false, reason: "conflict" };
  }

  const upd = await pool.query<{ id: string }>(
    `UPDATE production_expense
       SET current_stage = $3, current_stage_depth = $4,
           current_approver_ids = $5::uuid[],
           escalation_chain =
             CASE WHEN jsonb_array_length(escalation_chain) > 0
                  THEN jsonb_set(
                         escalation_chain,
                         ARRAY[(jsonb_array_length(escalation_chain) - 1)::text],
                         (escalation_chain -> -1) || $9::jsonb)
                  ELSE escalation_chain
             END || $6::jsonb,
           updated_at = now()
     WHERE id = $1 AND production_id = $2 AND status = 'pending'
       AND current_stage IS NOT DISTINCT FROM $7
       AND current_stage_depth = $8
       AND current_approver_ids @> ARRAY[$10]::uuid[]
     RETURNING id`,
    [
      expenseId, productionId, next.stage, next.depth, next.approverIds,
      JSON.stringify([chainEntry(next)]), e.current_stage, e.current_stage_depth,
      JSON.stringify({
        action: "escalated",
        actorId,
        actedAt: new Date().toISOString(),
        escalationReason: "forwarded",
      }),
      actorId,
    ],
  );
  if (!upd.rows[0]) return { ok: false, reason: "conflict" };
  return { ok: true, forwarded: true };
}

export async function rejectExpense(
  expenseId: string, productionId: string, actorId: string,
): Promise<{ ok: boolean }> {
  const res = await getPool().query<{ id: string }>(
    `UPDATE production_expense
       SET status = 'rejected', resolved_at = now(), resolved_by = $3,
           current_stage = NULL, current_approver_ids = '{}', updated_at = now()
     WHERE id = $1 AND production_id = $2 AND status = 'pending'
       AND current_approver_ids @> ARRAY[$3]::uuid[]
     RETURNING id`,
    [expenseId, productionId, actorId],
  );
  return { ok: !!res.rows[0] };
}

/** 撤回：只有提交人自己，且还在 pending。 */
export async function cancelExpense(
  expenseId: string, productionId: string, actorId: string,
): Promise<{ ok: boolean }> {
  const res = await getPool().query<{ id: string }>(
    `UPDATE production_expense
       SET status = 'cancelled', resolved_at = now(),
           current_stage = NULL, current_approver_ids = '{}', updated_at = now()
     WHERE id = $1 AND production_id = $2 AND submitted_by = $3 AND status = 'pending'
     RETURNING id`,
    [expenseId, productionId, actorId],
  );
  return { ok: !!res.rows[0] };
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
    `SELECT e.id, e.production_id, e.submitted_by, e.category_id,
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
      // resolved_by 记唯一审批人；真正的触发方由链条的 bySystem 区分，不能因超时触发
      // 就把同一种「提交人自批」终局写成无人批准。
      await pool.query(
        `UPDATE production_expense
            SET status = 'approved', resolved_at = now(), resolved_by = $4,
                current_stage = NULL, current_approver_ids = '{}',
                escalation_chain = escalation_chain || $2::jsonb, updated_at = now()
          WHERE id = $1 AND status = 'pending'
            AND current_stage IS NOT DISTINCT FROM $3`,
        [
          row.id, JSON.stringify([selfApprovalEntry(row.submitted_by, actedAt, true)]),
          row.current_stage, row.submitted_by,
        ],
      );
      continue;
    }

    const moved = await pool.query<{ id: string }>(
      `UPDATE production_expense
         SET current_stage = $2, current_stage_depth = $3,
             current_approver_ids = $4::uuid[],
             escalation_chain = escalation_chain || $5::jsonb,
             updated_at = now()
       WHERE id = $1 AND status = 'pending'
         AND current_stage IS NOT DISTINCT FROM $6
       RETURNING id`,
      [
        row.id, next.stage, next.depth, next.approverIds,
        JSON.stringify([{ ...chainEntry(next), escalationReason: "timeout" }]),
        row.current_stage,
      ],
    );
    if (moved.rows[0]) escalated++;
  }
  return { escalated };
}
