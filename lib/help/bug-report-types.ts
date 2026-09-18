// 「报告问题」的常量与类型（#538）。**零 node 依赖**——BugReportModal（客户端）直接 import；
// 带 pg 的读写在 bug-report-db.ts。客户端 import 到 @/lib/pg 会让 Turbopack 整站 500。

export const BUG_REPORT_KINDS = ["bug", "manual", "suggestion"] as const;
export type BugReportKind = (typeof BUG_REPORT_KINDS)[number];
export const BUG_REPORT_KIND_LABELS: Record<BugReportKind, string> = {
  bug: "功能有问题",
  manual: "手册写得不对",
  suggestion: "建议",
};

/** 反馈邮箱：报告落库后同时发一封到这里（路由到全体开发者，由邮箱侧配置）；未登录的手册访客直接写信。 */
export const BUG_REPORT_INBOX = "dev@clickinmusical.com";

/** 正文长度上限；再长就该发邮件了。 */
export const BUG_REPORT_BODY_MAX = 4000;
/** 限频：每人每小时 N 条（同一账号连点 / 脚本刷）。 */
export const BUG_REPORT_HOURLY_LIMIT = 10;

export function isBugReportKind(v: unknown): v is BugReportKind {
  return typeof v === "string" && (BUG_REPORT_KINDS as readonly string[]).includes(v);
}
