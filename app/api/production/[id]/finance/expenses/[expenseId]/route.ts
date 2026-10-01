import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import {
  approveExpense, confirmExpenseSettlement, FinanceError, getBudgetCategory, getExpense, getExpenseDetail,
  hasExpenseParticipation, isExpenseApprover, rejectExpense, reopenExpense,
  isExpenseDate, reclassifyExpense, reopenExpenseSettlement, submitExpenseDraft, updateExpenseDraft, withdrawExpense,
  type InvoiceRequirement,
} from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";
import { notifyUser } from "@/lib/notify/notify";

type Ctx = { params: Promise<{ id: string; expenseId: string }> };

/**
 * GET — 报销详情与完整时间线。提交人、参与过的处理人和全项目查看者可见。
 *
 * **审批资格不看权限键，看当前级的审批人名单**——那一列在提交/转发时由
 * lib/approval/approval-routing 的阶梯算好写死（同权限申请的口径，#140：路由只算一次，
 * 收件箱与鉴权都只读它，不各自重算）。
 *
 * 当前级不能终局时，approve 会**转发到下一级**而不是直接通过——你的上级如果本身
 * 没有财务权，他只能往上递。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const canViewAll = await hasEffectiveGrant(
    toActor(session, access.permCtx), productionId, "finance", "*", "expenses", "view",
  );
  if (!canViewAll && !await hasExpenseParticipation(expenseId, productionId, session.userId))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const expense = await getExpenseDetail(expenseId, productionId);
  if (!expense) return Response.json({ error: "报销不存在" }, { status: 404 });
  return Response.json({ expense });
}

function financeErrorResponse(error: FinanceError) {
  const status = error.reason === "stale" || error.reason === "conflict" ? 409
    : error.reason === "invalid_document" ? 403 : 400;
  return Response.json({ error: error.message, code: error.reason }, { status });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const current = await getExpense(expenseId, productionId);
  if (!current) return Response.json({ error: "报销不存在" }, { status: 404 });
  if (current.submittedBy !== session.userId)
    return Response.json({ error: "只能修改自己的报销草稿" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const title = typeof body.title === "string" ? body.title : "";
  const amount = typeof body.amount === "string" && body.amount ? body.amount : null;
  const occurredOn = typeof body.occurredOn === "string" && body.occurredOn ? body.occurredOn : null;
  if (occurredOn && !isExpenseDate(occurredOn))
    return Response.json({ error: "发生日期无效" }, { status: 400 });
  const categoryId = typeof body.categoryId === "string" && body.categoryId ? body.categoryId : null;
  if (categoryId && !(await getBudgetCategory(categoryId, productionId)))
    return Response.json({ error: "预算科目不存在" }, { status: 400 });
  const invoiceRequirement = body.invoiceRequirement === "required" || body.invoiceRequirement === "waived"
    ? body.invoiceRequirement as InvoiceRequirement : null;
  if (typeof body.expectedMutationSeq !== "number"
      || !Number.isSafeInteger(body.expectedMutationSeq) || body.expectedMutationSeq < 0)
    return Response.json({ error: "expectedMutationSeq 无效" }, { status: 400 });
  try {
    const expense = await updateExpenseDraft({
      expenseId, productionId, actorId: session.userId,
      expectedMutationSeq: body.expectedMutationSeq,
      categoryId, title, amount,
      currency: typeof body.currency === "string" ? body.currency : "CNY",
      exchangeRate: typeof body.exchangeRate === "string" ? body.exchangeRate : null,
      exchangeRateDate: typeof body.exchangeRateDate === "string" ? body.exchangeRateDate : null,
      exchangeRateSource: typeof body.exchangeRateSource === "string" ? body.exchangeRateSource : null,
      merchant: typeof body.merchant === "string" ? body.merchant : "",
      occurredOn,
      note: typeof body.note === "string" ? body.note : "",
      invoiceRequirement,
      invoiceWaiverReason: typeof body.invoiceWaiverReason === "string" ? body.invoiceWaiverReason : "",
    });
    return Response.json({ expense });
  } catch (error) {
    if (error instanceof FinanceError) return financeErrorResponse(error);
    throw error;
  }
}

/** POST — 状态动作；所有写动作都带调用方看见的 mutationSeq。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const expense = await getExpense(expenseId, productionId);
  if (!expense) return Response.json({ error: "支出不存在" }, { status: 404 });

  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const action = body.action;
  if (!["approve", "reject", "withdraw", "reopen", "submit", "reclassify", "settle", "reopen_settlement"].includes(String(action)))
    return Response.json({ error: "action 无效" }, { status: 400 });
  const expectedMutationSeq = body.expectedMutationSeq;
  if (typeof expectedMutationSeq !== "number"
      || !Number.isSafeInteger(expectedMutationSeq) || expectedMutationSeq < 0)
    return Response.json({ error: "expectedMutationSeq 无效" }, { status: 400 });
  const comment = typeof body.comment === "string" ? body.comment : "";

  if (action === "withdraw") {
    // 撤回是提交人自己的动作，与审批资格无关
    if (expense.submittedBy !== session.userId)
      return Response.json({ error: "只能撤回自己的报销" }, { status: 403 });
    const res = await withdrawExpense(expenseId, productionId, session.userId, expectedMutationSeq);
    if (!res.ok) return Response.json({ error: "报销已被处理或内容已变化，请刷新" }, { status: 409 });
    return Response.json({ expense: await getExpense(expenseId, productionId) });
  }
  if (action === "reopen") {
    if (expense.submittedBy !== session.userId)
      return Response.json({ error: "只能重新编辑自己的报销" }, { status: 403 });
    try {
      return Response.json({ expense: await reopenExpense(
        expenseId, productionId, session.userId, expectedMutationSeq,
      ) });
    } catch (error) {
      if (error instanceof FinanceError) return financeErrorResponse(error);
      throw error;
    }
  }
  if (action === "submit") {
    if (expense.submittedBy !== session.userId)
      return Response.json({ error: "只能提交自己的报销草稿" }, { status: 403 });
    try {
      return Response.json({ expense: await submitExpenseDraft(
        expenseId, productionId, session.userId, expectedMutationSeq,
      ) });
    } catch (error) {
      if (error instanceof FinanceError) return financeErrorResponse(error);
      throw error;
    }
  }

  if (action === "settle" || action === "reopen_settlement") {
    const canSettle = await hasEffectiveGrant(
      toActor(session, access.permCtx), productionId, "finance", "*", "settlement", "edit",
    );
    if (!canSettle)
      return Response.json({ error: "没有确认报销结清的资格" }, { status: 403 });
    const result = action === "settle"
      ? await confirmExpenseSettlement({
          expenseId, productionId, actorId: session.userId, expectedMutationSeq,
        })
      : await reopenExpenseSettlement({
          expenseId, productionId, actorId: session.userId, expectedMutationSeq,
        });
    if (!result.ok)
      return Response.json({ error: "结清状态已被处理或内容已变化，请刷新" }, { status: 409 });
    const fresh = await getExpense(expenseId, productionId);
    if (result.submittedBy && result.submittedBy !== session.userId) {
      await notifyUser({
        userId: result.submittedBy,
        kind: "expense_settlement",
        productionId,
        entityType: "expense",
        entityId: expenseId,
        title: action === "settle" ? "你的报销已确认线下结清" : "你的报销已恢复为待结清",
        body: fresh?.title ?? expense.title,
        viewHref: `/production/${productionId}/finance`,
        category: "info",
      });
    }
    return Response.json({ expense: fresh });
  }

  if (!await isExpenseApprover(expenseId, productionId, session.userId))
    return Response.json({ error: "你不是这笔支出当前级的审批人" }, { status: 403 });

  if (action === "reclassify") {
    if (typeof body.budgetItemId !== "string" || !body.budgetItemId)
      return Response.json({ error: "请选择预算项" }, { status: 400 });
    try {
      const res = await reclassifyExpense({
        expenseId,
        productionId,
        actorId: session.userId,
        budgetItemId: body.budgetItemId,
        expectedMutationSeq,
      });
      if (!res.ok)
        return Response.json({ error: "报销已被处理或内容已变化，请刷新" }, { status: 409 });
      return Response.json({
        expense: await getExpense(expenseId, productionId),
        selfApproved: res.selfApproved,
      });
    } catch (error) {
      if (error instanceof FinanceError) return financeErrorResponse(error);
      throw error;
    }
  }

  if (action === "reject") {
    try {
      const res = await rejectExpense(expenseId, productionId, session.userId, {
        expectedMutationSeq, comment,
      });
      if (!res.ok) return Response.json({ error: "报销已被处理或内容已变化，请刷新" }, { status: 409 });
      return Response.json({ expense: await getExpense(expenseId, productionId) });
    } catch (error) {
      if (error instanceof FinanceError) return financeErrorResponse(error);
      throw error;
    }
  }

  let res;
  try {
    res = await approveExpense(expenseId, productionId, session.userId, {
      expectedMutationSeq, comment,
    });
  } catch (error) {
    if (error instanceof FinanceError) return financeErrorResponse(error);
    throw error;
  }
  if (!res.ok) {
    return Response.json(
      { error: res.reason === "conflict" ? "这笔支出刚被别人处理了，请刷新" : "这笔支出已被处理" },
      { status: 409 },
    );
  }
  return Response.json({
    expense: await getExpense(expenseId, productionId),
    forwarded: res.forwarded,
  });
}
