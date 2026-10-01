import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { AMOUNT_RE, deleteBudgetCategory, FinanceError, getBudgetCategory, updateBudgetCategory } from "@/lib/ops/finance-db";
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
  const amount = parsed.value.amount === null || parsed.value.amount === "" ? null : String(parsed.value.amount ?? "");
  if (amount !== null && !AMOUNT_RE.test(amount)) return Response.json({ error: "预算金额格式不正确" }, { status: 400 });
  const item = await updateBudgetCategory(budgetItemId, id, session.userId, {
    amount, deptId: parsed.value.deptId === null || typeof parsed.value.deptId === "string" ? (parsed.value.deptId || null) as string | null : undefined,
    notes: typeof parsed.value.notes === "string" ? parsed.value.notes : undefined,
    orderIndex: typeof parsed.value.orderIndex === "number" ? parsed.value.orderIndex : undefined,
  });
  return item ? Response.json({ item }) : Response.json({ error: "预算项不存在" }, { status: 404 });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, budgetItemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await getBudgetCategory(budgetItemId, id)) return Response.json({ error: "预算项不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", budgetItemId, "budget", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  try {
    await deleteBudgetCategory(budgetItemId, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
