import { type NextRequest } from "next/server";
import { escalateExpiredApprovals } from "@/lib/db";
import { escalateExpiredExpenses } from "@/lib/finance-db";

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

/**
 * 权限申请与支出审批共用同一个节拍——两者的超时升级语义一致，没必要各起一条 cron。
 * 分开返回计数，好在日志里看出是哪一边在动。
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [approvals, expenses] = await Promise.all([
    escalateExpiredApprovals(),
    escalateExpiredExpenses(),
  ]);
  return Response.json({ ...approvals, expensesEscalated: expenses.escalated });
}
