import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import {
  AMOUNT_RE,
  createExpenseDraft, FinanceError, getBudgetCategory, listExpenses, submitExpense,
  type ExpenseDocumentKind,
} from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

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
 * POST — 新建草稿，或兼容填单页的一次性创建并提交。
 *
 * 审批人由 lib/approval/approval-routing 的阶梯算出（与权限申请同一个函数），这里不自己挑人。
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

  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const amount = typeof body.amount === "string" && body.amount ? body.amount : null;
  const intent = body.intent === "draft" ? "draft" : "submit";
  if (intent === "submit" && !title)
    return Response.json({ error: "事由不能为空" }, { status: 400 });
  if (amount && !AMOUNT_RE.test(amount))
    return Response.json({ error: "金额必须是最多两位小数的非负数" }, { status: 400 });
  if (intent === "submit" && !amount)
    return Response.json({ error: "金额不能为空" }, { status: 400 });

  const categoryId = typeof body.categoryId === "string" && body.categoryId ? body.categoryId : null;
  if (categoryId && !(await getBudgetCategory(categoryId, productionId)))
    return Response.json({ error: "预算科目不存在" }, { status: 400 });

  const invoiceRequirement = body.invoiceRequirement;
  if (intent === "submit" && invoiceRequirement !== "required" && invoiceRequirement !== "waived")
    return Response.json({ error: "请选择是否需要发票" }, { status: 400 });
  const invoiceWaiverReason = typeof body.invoiceWaiverReason === "string"
    ? body.invoiceWaiverReason.trim() : "";
  if (intent === "submit" && invoiceRequirement === "waived" && !invoiceWaiverReason)
    return Response.json({ error: "请填写无发票原因" }, { status: 400 });

  if (!Array.isArray(body.documents))
    return Response.json({ error: "凭证列表格式不正确" }, { status: 400 });
  const documents: { assetFileId: string; kind: ExpenseDocumentKind }[] = [];
  for (const value of body.documents) {
    if (!value || typeof value !== "object")
      return Response.json({ error: "凭证列表格式不正确" }, { status: 400 });
    const document = value as Record<string, unknown>;
    const kind = document.kind;
    if (typeof document.assetFileId !== "string"
        || (kind !== "invoice" && kind !== "receipt" && kind !== "other"))
      return Response.json({ error: "凭证类型或文件无效" }, { status: 400 });
    documents.push({ assetFileId: document.assetFileId, kind });
  }

  try {
    const parsedInvoiceRequirement: "required" | "waived" | null =
      invoiceRequirement === "required" || invoiceRequirement === "waived" ? invoiceRequirement : null;
    const common = {
      productionId, categoryId, title, amount,
      currency: typeof body.currency === "string" ? body.currency : "CNY",
      note: typeof body.note === "string" ? body.note : "",
      submittedBy: session.userId,
      invoiceRequirement: parsedInvoiceRequirement,
      invoiceWaiverReason,
      documents,
    };
    const expense = intent === "draft"
      ? await createExpenseDraft(common)
      : await submitExpense({ ...common, amount: amount!, invoiceRequirement: common.invoiceRequirement! });
    return Response.json({ expense }, { status: 201 });
  } catch (e) {
    if (e instanceof FinanceError)
      return Response.json({ error: e.message }, { status: e.reason === "invalid_document" ? 400 : 409 });
    throw e;
  }
}
