import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { listBudgetCategoryOptions } from "@/lib/finance-db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — 科目表的只读窄面：只有名字与归属部门，**没有额度、没有已用**。
 *
 * 独立端点而不是给 /categories 加 query 参数：两面的门不一样
 * （categories@view vs budget@view）。挤在一个 handler 里，就成了「按参数选门」——
 * 参数漏传时泄露的是全项目预算额度，而且不报错。
 *
 * 报销要选科目就得看得见科目名，但科目名不该跟额度捆在一起卖。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "finance", "*", "categories", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ categories: await listBudgetCategoryOptions(productionId) });
}
