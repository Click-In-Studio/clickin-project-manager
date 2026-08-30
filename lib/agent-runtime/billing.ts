// 一次 run 的成本折算（#383）。单价表在 config.ts 的 Model.cost，档位额度在
// lib/plan.ts；这里只做 usage → 美元 → credit 这一段。
//
// 为什么不直接信 provider 的 usage.cost：填了 Model.cost 之后它确实会算，但
// 「记 0 credit」是静默失效——限流会看起来在跑、实际谁都拦不住。所以取
// provider 值优先、自算兜底，两条路都指向同一张单价表。

import { creditsFromUsd } from "@/lib/plan";
import type { Model, Usage } from "../../vendor/openclaw/packages/llm-core/src/types";

export type TokenUsage = { input: number; output: number; cacheRead: number };

/** 按模型单价自算美元（provider 没给成本时的兜底，也是 compaction 的唯一路径）。 */
export function usdOfTokens(u: TokenUsage, model: Model): number {
  const c = model.cost;
  return (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead) / 1_000_000;
}

/** provider 报了成本就用它（provider-billed 是权威），否则按单价自算。 */
export function usdOfUsage(usage: Usage, model: Model): number {
  const reported = usage.cost?.total;
  if (typeof reported === "number" && reported > 0) return reported;
  return usdOfTokens({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead }, model);
}

export function creditsOfUsage(usage: Usage, model: Model): number {
  return creditsFromUsd(usdOfUsage(usage, model));
}
