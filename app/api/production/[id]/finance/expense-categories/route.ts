import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canAccessNode } from "@/lib/perm/grant-template";
import { createExpenseCategory, FinanceError, listExpenseCategories } from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const entry = await canAccessNode(toActor(session, access.permCtx), id, "finance", "*", "categories", "edit");
  if (!entry.allowed && entry.reason !== "needs_self_confirm")
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ categories: await listExpenseCategories(id) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", "*", "categories", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const name = typeof parsed.value.name === "string" ? parsed.value.name.trim() : "";
  if (!name) return Response.json({ error: "科目名不能为空" }, { status: 400 });
  try {
    const category = await createExpenseCategory({
      productionId: id, name,
      description: typeof parsed.value.description === "string" ? parsed.value.description : "",
      createdBy: session.userId,
    });
    return Response.json({ category }, { status: 201 });
  } catch (error) {
    if (error instanceof FinanceError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
