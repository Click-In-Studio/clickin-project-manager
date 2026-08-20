import { type NextRequest } from "next/server";
import { freezeExpiredEventGroups } from "@/lib/event-group-freeze";

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

/**
 * 到期未冻的 event 批量冻结用户组快照。
 *
 * 为什么必须是 cron 而不是读取时懒惰物化：冻结要冻的是 **deadline 那一刻**的名单。
 * 懒惰计算的话，deadline 到首次读取之间的部门人员变动会污染快照——一年没人打开的
 * event 反而冻出一年后的名单，正好是这个机制要消除的东西。
 *
 * 幂等，可重跑：已有生效快照的组会跳过。
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await freezeExpiredEventGroups());
}
