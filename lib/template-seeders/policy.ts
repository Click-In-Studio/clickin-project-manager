/**
 * 项目模版 · 策略 slot（见 `lib/production-template.ts` 文件头）。
 *
 * 载荷是**覆盖项**：只写与代码默认不同的键，其余取 `lib/policy-keys.ts` 的 defaultValue。
 * 但落库仍是**全量行**（`ensureProductionPolicies` 的契约，#236）——稀疏存储会让「改一次
 * 代码默认值」静默改变所有未显式配置过该键的存量演出的行为，且不留痕迹。
 */
import type { SeedContext, TemplateSeeder } from "../production-template";
import { ensureProductionPolicies } from "../policy-db";
import { policyDef, isLegalValue } from "../policy-keys";

/** 策略键 → 值；未列出的键取代码默认。 */
export type PolicyPayload = Readonly<Record<string, string>>;

export const policySeeder: TemplateSeeder<PolicyPayload> = {
  slot: "policies",
  label: "策略档位",

  validate(overrides) {
    const errors: string[] = [];
    for (const [key, value] of Object.entries(overrides)) {
      const def = policyDef(key);
      if (!def) { errors.push(`未知策略键：${key}`); continue; }
      if (!isLegalValue(key, value)) {
        errors.push(`策略键 ${key} 不接受取值 ${value}（合法：${def.values.join(" / ")}）`);
      }
    }
    return errors;
  },

  async seed(overrides: PolicyPayload, ctx: SeedContext) {
    await ensureProductionPolicies(ctx.productionId, ctx.db, overrides);
  },
};
