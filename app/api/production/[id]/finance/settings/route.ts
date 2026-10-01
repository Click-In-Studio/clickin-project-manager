import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import {
  FinanceError, getProductionBaseCurrency, updateProductionBaseCurrency,
} from "@/lib/ops/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", "*", "budget", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ baseCurrency: await getProductionBaseCurrency(id) });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), id, "finance", "*", "budget", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  try {
    const baseCurrency = await updateProductionBaseCurrency(
      id, typeof parsed.value.baseCurrency === "string" ? parsed.value.baseCurrency : "",
    );
    return Response.json({ baseCurrency });
  } catch (error) {
    if (error instanceof FinanceError)
      return Response.json({ error: error.message }, { status: error.reason === "conflict" ? 409 : 400 });
    throw error;
  }
}
