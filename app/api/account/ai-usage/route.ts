/**
 * 个人 AI 额度（#383）。口径与限流判定同源：个人会话 + 他**当前** own 的全部
 * 项目——所以这里的数字就是他下一次发消息会不会被拦的依据。
 */
import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getQuotaStatus } from "@/lib/ai-quota";

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const q = await getQuotaStatus({ userId: session.userId });
  return Response.json({
    tier: q.tier,
    tierLabel: q.tierLabel,
    exempt: q.exempt,
    daily: q.daily,
    weekly: q.weekly,
    extraRemaining: q.extraRemaining,
    allowed: q.allowed,
    blockedBy: q.blockedBy,
  });
}
