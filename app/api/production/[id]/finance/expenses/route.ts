import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import {
  AMOUNT_RE,
  FinanceError, getBudgetCategory, listExpenses, submitExpense,
} from "@/lib/finance-db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — 支出列表。
 *
 * 两档，不是一道门：
 *   - 持 expenses@view：全项目每一笔。与 budget@view 分开——看总盘子和看每一笔
 *     花在哪儿是两档信任。
 *   - 不持：**我交的 ∪ 待我批的**。这两块靠上下文放行，不需要任何权限键——
 *     自己交的单子自己看不见是荒唐的；被阶梯算成审批人却看不见要批什么也是。
 *
 * 所以这个端点不再 403。返回集合的宽窄由身份决定，调用方不必先问自己有没有权限。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const all = await hasEffectiveGrant(
    toActor(session, access.permCtx), productionId, "finance", "*", "expenses", "view");
  const expenses = all
    ? await listExpenses(productionId)
    : await listExpenses(productionId, { submittedBy: session.userId, pendingFor: session.userId });
  return Response.json({ expenses, scope: all ? "all" : "own" });
}

/**
 * POST — 提一笔支出，立刻进审批。
 *
 * 审批人由 lib/approval-routing 的阶梯算出（与权限申请同一个函数），这里不自己挑人。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", "*", "expenses", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    categoryId?: unknown; title?: unknown; amount?: unknown; currency?: unknown; note?: unknown;
  };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return Response.json({ error: "事由不能为空" }, { status: 400 });
  const amount = typeof body.amount === "string" ? body.amount : String(body.amount ?? "");
  if (!AMOUNT_RE.test(amount))
    return Response.json({ error: "金额必须是最多两位小数的非负数" }, { status: 400 });

  const categoryId = typeof body.categoryId === "string" && body.categoryId ? body.categoryId : null;
  if (categoryId && !(await getBudgetCategory(categoryId, productionId)))
    return Response.json({ error: "预算科目不存在" }, { status: 400 });

  try {
    const expense = await submitExpense({
      productionId, categoryId, title, amount,
      currency: typeof body.currency === "string" ? body.currency : "CNY",
      note: typeof body.note === "string" ? body.note : "",
      submittedBy: session.userId,
    });
    return Response.json({ expense }, { status: 201 });
  } catch (e) {
    if (e instanceof FinanceError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
