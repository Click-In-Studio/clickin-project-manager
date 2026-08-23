import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { redeemPlanCode, redeemRateLimited, REDEEM_ERROR_MESSAGES, PRODUCTION_TIERS, type ProductionTier } from "@/lib/plan";

// 项目档位兑换码（#280）：kind=production_upgrade 的 plan_code 在这里消费，
// owner-only——owner 是账单责任人（未来付费），档位变更只能由其本人操作。
// 特邀项目（grants_exempt 码）同走此口，一码可同授档位 + 计费豁免。
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, id);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!access.permCtx.isOwner) {
    return Response.json({ error: "仅项目所有者可兑换项目升级码" }, { status: 403 });
  }

  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof code !== "string" || !code.trim()) {
    return Response.json({ error: "请输入兑换码" }, { status: 400 });
  }
  if (redeemRateLimited(session.userId)) {
    return Response.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  try {
    const result = await redeemPlanCode({ code: code.trim(), userId: session.userId, productionId: id });
    if (!result.ok) {
      // no_effect 是「码有效但无提升」的正常结局，用 409 与非法输入区分。
      const status = result.reason === "not_found" ? 404 : result.reason === "no_effect" ? 409 : 400;
      return Response.json(
        { error: REDEEM_ERROR_MESSAGES[result.reason], reason: result.reason },
        { status },
      );
    }
    const label = PRODUCTION_TIERS[result.tier as ProductionTier]?.label ?? result.tier;
    return Response.json({ ok: true, tier: result.tier, tierLabel: label, billingExempt: result.billingExempt });
  } catch (err) {
    console.error("[redeem-code] production redeem error:", err);
    return Response.json({ error: "兑换失败，请稍后重试" }, { status: 500 });
  }
}
