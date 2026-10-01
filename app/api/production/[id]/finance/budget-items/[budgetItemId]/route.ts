import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { deleteBudgetCategory, FinanceError, getBudgetCategory, updateBudgetCategory } from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; budgetItemId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, budgetItemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", budgetItemId, "budget", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const amount = parsed.value.amount === null || parsed.value.amount === "" ? null
    : parsed.value.amount !== undefined ? String(parsed.value.amount) : undefined;
  try {
    const item = await updateBudgetCategory(budgetItemId, id, session.userId, {
      amount,
      currency: typeof parsed.value.currency === "string" ? parsed.value.currency : undefined,
      exchangeRate: typeof parsed.value.exchangeRate === "string" ? parsed.value.exchangeRate : parsed.value.exchangeRate === null ? null : undefined,
      exchangeRateDate: typeof parsed.value.exchangeRateDate === "string" ? parsed.value.exchangeRateDate : parsed.value.exchangeRateDate === null ? null : undefined,
      exchangeRateSource: typeof parsed.value.exchangeRateSource === "string" ? parsed.value.exchangeRateSource : parsed.value.exchangeRateSource === null ? null : undefined,
      deptId: parsed.value.deptId === null || typeof parsed.value.deptId === "string" ? (parsed.value.deptId || null) as string | null : undefined,
      notes: typeof parsed.value.notes === "string" ? parsed.value.notes : undefined,
      orderIndex: typeof parsed.value.orderIndex === "number" ? parsed.value.orderIndex : undefined,
    });
    return item ? Response.json({ item }) : Response.json({ error: "预算项不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: error.reason === "duplicate_name" ? 409 : 400 });
    throw error;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, budgetItemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", budgetItemId, "budget", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (!await getBudgetCategory(budgetItemId, id)) return Response.json({ error: "预算项不存在" }, { status: 404 });
  try {
    await deleteBudgetCategory(budgetItemId, id, session.userId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
