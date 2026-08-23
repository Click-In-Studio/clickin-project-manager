import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  approveExpense, cancelExpense, getExpense, isExpenseApprover, rejectExpense,
} from "@/lib/finance-db";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; expenseId: string }> };

/**
 * POST — 对一笔支出动作：approve / reject / cancel。
 *
 * **审批资格不看权限键，看当前级的审批人名单**——那一列在提交/转发时由
 * lib/approval-routing 的阶梯算好写死（同权限申请的口径，#140：路由只算一次，
 * 收件箱与鉴权都只读它，不各自重算）。
 *
 * 当前级不能终局时，approve 会**转发到下一级**而不是直接通过——你的上级如果本身
 * 没有财务权，他只能往上递。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, expenseId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const expense = await getExpense(expenseId, productionId);
  if (!expense) return Response.json({ error: "支出不存在" }, { status: 404 });

  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "cancel")
    return Response.json({ error: "action 必须是 approve / reject / cancel" }, { status: 400 });

  if (action === "cancel") {
    // 撤回是提交人自己的动作，与审批资格无关
    const res = await cancelExpense(expenseId, productionId, session.userId);
    if (!res.ok) return Response.json({ error: "只能撤回自己仍在审批中的支出" }, { status: 403 });
    return Response.json({ expense: await getExpense(expenseId, productionId) });
  }

  if (!await isExpenseApprover(expenseId, productionId, session.userId))
    return Response.json({ error: "你不是这笔支出当前级的审批人" }, { status: 403 });

  if (action === "reject") {
    const res = await rejectExpense(expenseId, productionId, session.userId);
    if (!res.ok) return Response.json({ error: "这笔支出已被处理" }, { status: 409 });
    return Response.json({ expense: await getExpense(expenseId, productionId) });
  }

  const res = await approveExpense(expenseId, productionId, session.userId);
  if (!res.ok) {
    return Response.json(
      { error: res.reason === "conflict" ? "这笔支出刚被别人处理了，请刷新" : "这笔支出已被处理" },
      { status: 409 },
    );
  }
  return Response.json({
    expense: await getExpense(expenseId, productionId),
    forwarded: res.forwarded,
  });
}
