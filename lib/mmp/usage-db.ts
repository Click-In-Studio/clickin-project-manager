// MMP 任务记账写点（#618；DB I/O 按规约进 *-db.ts）：与 chat / embedding 同一张 ai_usage、同一套 credit（成本折算），
// 日 / 周闸、hard cap、owner 归属全部照旧，不另立账本。
//
// - model = `mmp:<type>@<tier>`，kind = 'mmp_compute'，**tokens 列存的是可计费推理毫秒**
//   （这张表的 tokens 是「计量数」不是「token 数」，embedding 行也是同一用法的延伸）；
// - cpu 档记 0 credit 但照记行（豁免 ≠ 不记账；将来要看分诊量）；cached / 失败不记；
// - paid_from 现查：工具在 run 中途调用，拿不到 run 开始时定死的支付源，多一次查询
//   换「豁免项目不会被记成 quota」。

import { getPool } from "@/lib/pg";
import { creditsFromMmpCompute } from "@/lib/account/plan";
import { chargeExtraCredits, getQuotaStatus, paidFromOf, quotaOwnerOf } from "@/lib/agent/ai-quota";

export async function recordMmpUsage(args: {
  userId: string;
  productionId: string | null;
  type: string;
  tier: string;
  computeMs: number;
}): Promise<number> {
  const credits = creditsFromMmpCompute(args.tier, args.computeMs);
  const paid = paidFromOf(await getQuotaStatus({ userId: args.userId, productionId: args.productionId }));
  await getPool().query(
    `INSERT INTO ai_usage (user_id, production_id, kind, model, tokens, billed_credits, paid_from)
     VALUES ($1, $2, 'mmp_compute', $3, $4, $5, $6)`,
    [args.userId, args.productionId, `mmp:${args.type}@${args.tier}`, Math.max(0, Math.round(args.computeMs)), credits, paid],
  );
  if (paid === "extra" && credits > 0) {
    await chargeExtraCredits(await quotaOwnerOf(args.userId, args.productionId), credits).catch((e) =>
      console.error("[mmp] 额外额度扣款失败（用量已记）:", e),
    );
  }
  return credits;
}
