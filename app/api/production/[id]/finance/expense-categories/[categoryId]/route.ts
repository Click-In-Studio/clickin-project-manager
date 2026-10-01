import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { deleteExpenseCategory, FinanceError, updateExpenseCategory } from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; categoryId: string }> };

async function access(req: NextRequest, productionId: string, action: "edit" | "delete") {
  const session = getSession(req.cookies);
  if (!session) return { response: Response.json({ error: "未登录" }, { status: 401 }) };
  const context = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!context) return { response: Response.json({ error: "无权访问" }, { status: 403 }) };
  if (context.isArchived) return { response: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  if (!await hasEffectiveGrant(toActor(session, context.permCtx), productionId, "finance", "*", "categories", action))
    return { response: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, categoryId } = await ctx.params;
  const gate = await access(req, id, "edit");
  if ("response" in gate) return gate.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const name = typeof parsed.value.name === "string" ? parsed.value.name.trim() : "";
  if (!name) return Response.json({ error: "科目名不能为空" }, { status: 400 });
  try {
    const category = await updateExpenseCategory(categoryId, id, {
      name, description: typeof parsed.value.description === "string" ? parsed.value.description : undefined,
      sortOrder: typeof parsed.value.sortOrder === "number" ? parsed.value.sortOrder : undefined,
    });
    return category ? Response.json({ category }) : Response.json({ error: "科目不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, categoryId } = await ctx.params;
  const gate = await access(req, id, "delete");
  if ("response" in gate) return gate.response;
  try {
    return await deleteExpenseCategory(categoryId, id)
      ? Response.json({ ok: true }) : Response.json({ error: "科目不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
