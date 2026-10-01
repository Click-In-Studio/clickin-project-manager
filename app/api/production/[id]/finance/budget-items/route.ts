import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canAccessNode } from "@/lib/perm/grant-template";
import { AMOUNT_RE, createBudgetItem, FinanceError, listBudgetCategories } from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const entry = await canAccessNode(toActor(session, access.permCtx), id, "finance", "*", "budget", "edit");
  if (!entry.allowed && entry.reason !== "needs_self_confirm")
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ items: await listBudgetCategories(id) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", "*", "budget", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const amount = body.amount === null || body.amount === "" ? null : String(body.amount ?? "");
  if (!categoryId) return Response.json({ error: "请选择费用科目" }, { status: 400 });
  if (amount !== null && !AMOUNT_RE.test(amount)) return Response.json({ error: "预算金额格式不正确" }, { status: 400 });
  try {
    const item = await createBudgetItem({
      productionId: id, categoryId, amount,
      deptId: typeof body.deptId === "string" && body.deptId ? body.deptId : null,
      notes: typeof body.notes === "string" ? body.notes : "", createdBy: session.userId,
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
