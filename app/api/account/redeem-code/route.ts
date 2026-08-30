import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { redeemPlanCode, redeemRateLimited, REDEEM_ERROR_MESSAGES, USER_TIERS, type UserTier } from "@/lib/plan";

// 用户等级兑换码（#280）：管理员手工 INSERT 的 plan_code（kind=user_upgrade）在这里
// 消费。兑换只升不降；结果实时落库（等级不进 session payload，下次判定即生效）。
export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof code !== "string" || !code.trim()) {
    return Response.json({ error: "请输入兑换码" }, { status: 400 });
  }
  if (redeemRateLimited(session.userId)) {
    return Response.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  try {
    const result = await redeemPlanCode({ code: code.trim(), userId: session.userId });
    if (!result.ok) {
      // no_effect 是「码有效但无提升」的正常结局，用 409 与非法输入区分。
      const status = result.reason === "not_found" ? 404 : result.reason === "no_effect" ? 409 : 400;
      return Response.json(
        { error: REDEEM_ERROR_MESSAGES[result.reason], reason: result.reason },
        { status },
      );
    }
    if (result.kind === "credits") {
      return Response.json({ ok: true, kind: "credits", credits: result.credits });
    }
    const label = USER_TIERS[result.tier as UserTier]?.label ?? result.tier;
    return Response.json({ ok: true, kind: "tier", tier: result.tier, tierLabel: label });
  } catch (err) {
    console.error("[redeem-code] user redeem error:", err);
    return Response.json({ error: "兑换失败，请稍后重试" }, { status: 500 });
  }
}
