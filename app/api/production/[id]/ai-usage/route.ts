/**
 * 项目 AI 用量（#383 第 5 点：限流到点不能变成突然断服）。
 *
 * 两个门，两枚键：
 *   node:ai/<prod>/usage@view          花了多少、还剩多少（默认只有 owner 旁路命中）
 *   node:ai/<prod>/usage/members@view  谁花的（?members=1）
 * 都不是 SENSITIVE——它不是密钥也不是人事裁决，是「这个项目花了多少钱」。
 * 两枚正交：只有总览键的人拿不到 members 分解，请求了也只是没有这一段。
 */
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { hasGrant } from "@/lib/grant-check";
import { getProductionAiUsage, getProductionMemberUsage } from "@/lib/ai-quota";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny, session, access } = await requireGrantGate(req, id, [["ai", "usage", "view"]]);
  if (deny) return deny;

  const { rows } = await getPool().query<{ owner_id: string }>("SELECT owner_id FROM production WHERE id = $1", [id]);
  const ownerId = rows[0]?.owner_id;
  if (!ownerId) return Response.json({ error: "项目不存在" }, { status: 404 });

  const usage = await getProductionAiUsage(id, ownerId);
  const isOwner = access?.permCtx.isOwner ?? false;

  // 额度余额是 owner 的钱包：有 usage@view 的人看得到「本项目还能不能用」，
  // 但额外额度余额只对 owner 本人显示——那是他跨项目的钱包，不属于本项目的账。
  const body: Record<string, unknown> = {
    today: usage.today,
    week: usage.week,
    quota: {
      tierLabel: usage.quota.tierLabel,
      exempt: usage.quota.exempt,
      daily: usage.quota.daily,
      weekly: usage.quota.weekly,
      allowed: usage.quota.allowed,
      blockedBy: usage.quota.blockedBy,
      ...(isOwner ? { extraRemaining: usage.quota.extraRemaining } : {}),
    },
  };

  if (req.nextUrl.searchParams.get("members") === "1" && session) {
    const canMembers = isOwner || session.isAdmin
      || (await hasGrant(session.userId, id, "ai", "*", "usage/members", "view"));
    if (canMembers) body.members = await getProductionMemberUsage(id);
  }

  return Response.json(body);
}
