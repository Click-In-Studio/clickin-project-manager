/**
 * 财务预算科目数据层。报销生命周期单独位于 expense-db.ts，避免状态机与预算查询再次长成总仓。
 */

import { getPool } from "../pg";
import type { PoolClient } from "pg";
import { FinanceError } from "./expense-read-db";

export * from "./expense-read-db";
export * from "./expense-db";

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
