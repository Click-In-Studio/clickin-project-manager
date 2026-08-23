import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getEventDepartment } from "@/lib/event-db";
import { AMOUNT_RE, createBudgetCategory, FinanceError, listBudgetCategories } from "@/lib/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

/** 金额只接受「最多两位小数的非负数」字符串——不过 JS number，避免精度丢失。 */

/**
 * GET — 预算科目（含各科目已批准支出的合计）。
 *
 * 门是 finance 域的 budget@view 面，单独一枚：有的剧组设计人员也能看预算（好决定
 * 自己的设计放到哪个 budget level），而看支出明细是另一档——两个面刻意分开发。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", "*", "budget", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ categories: await listBudgetCategories(productionId) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", "*", "budget", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "科目名不能为空" }, { status: 400 });
  const amount = typeof body.amount === "string" ? body.amount : String(body.amount ?? "0");
  if (!AMOUNT_RE.test(amount))
    return Response.json({ error: "金额必须是最多两位小数的非负数" }, { status: 400 });

  const deptId = typeof body.deptId === "string" && body.deptId ? body.deptId : null;
  if (deptId && !(await getEventDepartment(deptId, productionId)))
    return Response.json({ error: "部门不存在" }, { status: 400 });

  try {
    const category = await createBudgetCategory({
      productionId, name, amount,
      currency: typeof body.currency === "string" ? body.currency : "CNY",
      deptId,
      orderIndex: typeof body.orderIndex === "number" ? body.orderIndex : 0,
      notes: typeof body.notes === "string" ? body.notes : "",
      createdBy: session.userId,
    });
    return Response.json({ category }, { status: 201 });
  } catch (e) {
    if (e instanceof FinanceError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
