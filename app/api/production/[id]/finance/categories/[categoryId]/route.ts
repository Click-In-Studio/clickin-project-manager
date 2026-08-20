import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getEventDepartment } from "@/lib/event-db";
import {
  AMOUNT_RE,
  deleteBudgetCategory, FinanceError, getBudgetCategory, updateBudgetCategory,
} from "@/lib/finance-db";

type Ctx = { params: Promise<{ id: string; categoryId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, categoryId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await getBudgetCategory(categoryId, productionId))
    return Response.json({ error: "预算科目不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", categoryId, "budget", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    name?: unknown; amount?: unknown; deptId?: unknown; orderIndex?: unknown; notes?: unknown;
  };
  // 给了 name 就必须是非空的。db 层只 trim 不拒，DDL 只有 NOT NULL——
  // 少了这道，PATCH {name:"   "} 会静静落成一个空名科目，而 POST 明明是拦的
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim()))
    return Response.json({ error: "科目名不能为空" }, { status: 400 });
  if (body.amount !== undefined && !AMOUNT_RE.test(String(body.amount)))
    return Response.json({ error: "金额必须是最多两位小数的非负数" }, { status: 400 });
  if (typeof body.deptId === "string" && body.deptId && !(await getEventDepartment(body.deptId, productionId)))
    return Response.json({ error: "部门不存在" }, { status: 400 });

  try {
    const category = await updateBudgetCategory(categoryId, productionId, session.userId, {
      name: typeof body.name === "string" ? body.name : undefined,
      amount: body.amount !== undefined ? String(body.amount) : undefined,
      deptId: body.deptId === null || typeof body.deptId === "string"
        ? (body.deptId || null) as string | null : undefined,
      orderIndex: typeof body.orderIndex === "number" ? body.orderIndex : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return Response.json({ category });
  } catch (e) {
    if (e instanceof FinanceError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, categoryId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await getBudgetCategory(categoryId, productionId))
    return Response.json({ error: "预算科目不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", categoryId, "budget", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  // 挂在它上面的支出 category_id 置空（ON DELETE SET NULL），不连坐删——
  // 已发生的钱不该因为科目表被整理而消失
  await deleteBudgetCategory(categoryId, productionId);
  return Response.json({ ok: true });
}
