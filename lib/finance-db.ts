/**
 * 财务：预算科目 + 支出审批。
 *
 * ## 审批复用路由，不复用表
 *
 * 「谁来批这笔支出」走 lib/approval-routing.ts 的 {@link buildApprovalLadder}——与权限
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

import { getPool } from "./pg";
import type { PoolClient } from "pg";
import {
  buildApprovalLadder, DEFAULT_APPROVAL_TTL_HOURS, nextStage,
  type ApprovalStage, type StagePosition,
} from "./approval-routing";

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

export type Expense = {
  id: string;
  productionId: string;
  categoryId: string | null;
  categoryName: string | null;
  title: string;
  amount: string;
  currency: string;
  note: string;
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

export class FinanceError extends Error {
  constructor(
    readonly reason: "duplicate_name" | "no_approver" | "conflict" | "not_pending" | "forward_only",
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
  submitted_by: string; submitter_name: string | null; status: ExpenseStatus;
  current_stage: string | null; current_stage_depth: number; current_approver_ids: string[];
  escalation_chain: { canFinalize?: boolean }[];
  resolved_at: Date | null; resolved_by: string | null; created_at: Date;
};

function rowToExpense(r: ExpenseRow): Expense {
  const last = r.escalation_chain[r.escalation_chain.length - 1];
  return {
    id: r.id, productionId: r.production_id,
    categoryId: r.category_id, categoryName: r.category_name,
    title: r.title, amount: r.amount, currency: r.currency, note: r.note,
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
         e.submitted_by,
         COALESCE(NULLIF(up.display_name, ''), up.name) AS submitter_name,
         e.status, e.current_stage, e.current_stage_depth, e.current_approver_ids,
         e.escalation_chain, e.resolved_at, e.resolved_by, e.created_at
    FROM production_expense e
    LEFT JOIN production_budget_category c ON c.id = e.category_id
    LEFT JOIN user_profile up ON up.user_id = e.submitted_by`;

export async function listExpenses(productionId: string): Promise<Expense[]> {
  const res = await getPool().query<ExpenseRow>(
    `${EXPENSE_QUERY} WHERE e.production_id = $1 ORDER BY e.created_at DESC`,
    [productionId],
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

export async function submitExpense(params: {
  productionId: string; categoryId: string | null; title: string;
  amount: string; currency?: string; note?: string; submittedBy: string;
}): Promise<Expense> {
  const ladder = await buildApprovalLadder(
    expenseTarget(params.productionId, params.submittedBy, params.categoryId),
  );
  const first = ladder[0];
  if (!first) throw new FinanceError("no_approver", "找不到这笔支出的审批人，请联系制作人");

  const res = await getPool().query<{ id: string }>(
    `INSERT INTO production_expense
       (production_id, category_id, title, amount, currency, note, submitted_by,
        status, current_stage, current_stage_depth, current_approver_ids, escalation_chain)
     VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,'pending',$8,$9,$10::uuid[],$11::jsonb)
     RETURNING id`,
    [
      params.productionId, params.categoryId, params.title.trim(), params.amount,
      params.currency ?? "CNY", params.note ?? "", params.submittedBy,
      first.stage, first.depth, first.approverIds, JSON.stringify([chainEntry(first)]),
    ],
  );
  const created = await getExpense(res.rows[0].id, params.productionId);
  if (!created) throw new Error(`expense not found after create: ${res.rows[0].id}`);
  return created;
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
       RETURNING id`,
      [expenseId, productionId, actorId, e.current_stage],
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
       RETURNING id`,
      [expenseId, productionId, actorId],
    );
    return upd.rows[0] ? { ok: true, forwarded: false } : { ok: false, reason: "conflict" };
  }

  const upd = await pool.query<{ id: string }>(
    `UPDATE production_expense
       SET current_stage = $3, current_stage_depth = $4,
           current_approver_ids = $5::uuid[],
           escalation_chain = escalation_chain || $6::jsonb,
           updated_at = now()
     WHERE id = $1 AND production_id = $2 AND status = 'pending'
       AND current_stage IS NOT DISTINCT FROM $7
     RETURNING id`,
    [
      expenseId, productionId, next.stage, next.depth, next.approverIds,
      JSON.stringify([chainEntry(next)]), e.current_stage,
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
 * 已在链顶（owner）的不再升级——只等人处理。
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
    const ladder = await buildApprovalLadder(
      expenseTarget(row.production_id, row.submitted_by, row.category_id),
    );
    const next = nextStage(
      ladder,
      positionOf({ currentStage: row.current_stage }, row.current_stage_depth),
    );
    if (!next) continue;   // 已在链顶，只等人处理

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
