/**
 * 项目模版 · 审批流程 slot（见 `lib/production-template.ts` 文件头）。
 *
 * 只有一行 TTL，但它是「非资源类子系统也能进模版」的样例：宽松剧组建项目就该是 48h，
 * 而不是建完再去设置页改。合法区间与 DB CHECK 同源（1..720）。
 */
import type { SeedContext, TemplateSeeder } from "../production-template";

export type ApprovalPayload = {
  /** 授权申请自动通过前的等待小时数。 */
  ttlHours: number;
};

export const approvalSeeder: TemplateSeeder<ApprovalPayload> = {
  slot: "approval",
  label: "审批 TTL",

  validate({ ttlHours }) {
    if (!Number.isInteger(ttlHours) || ttlHours <= 0 || ttlHours > 720) {
      return [`ttlHours 必须是 1..720 的整数（与 production_approval_config 的 CHECK 同源），当前 ${ttlHours}`];
    }
    return [];
  },

  async seed({ ttlHours }: ApprovalPayload, ctx: SeedContext) {
    await ctx.db.query(
      `INSERT INTO production_approval_config (production_id, ttl_hours)
       VALUES ($1, $2) ON CONFLICT (production_id) DO NOTHING`,
      [ctx.productionId, ttlHours],
    );
  },
};
