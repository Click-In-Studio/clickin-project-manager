/**
 * 权限申请的时效档位 —— 前后端唯一定义。
 *
 * #256 的成因是两个申请入口各自硬编码档位：AccessRequestModal 发
 * `"30 minutes"`/`"1 hour"`/…，AccessRequestsClient 的 RequestForm 干脆不发
 * ttlDuration，服务端又照单全收 —— `grant_type='ttl'` 配 `ttl_duration IS NULL`
 * 静默通过，批准时 `expires_at` 落 NULL，而 NULL 在每一处权限检查里都等于永久。
 * 所以档位表只能有一份，且服务端必须按这份表白名单校验，不接受任意 INTERVAL 串。
 */

export type TtlOptionValue = "permanent" | "1d" | "1w" | "1mo";

export type TtlOption = {
  value: TtlOptionValue;
  label: string;
  /** Postgres INTERVAL 字面量；permanent 为 null（不写 ttl_duration）。 */
  interval: string | null;
};

/** 用户定谳（2026-08-17）：时效档位收敛为 长期 / 1 天 / 1 周 / 1 月。 */
export const TTL_OPTIONS: readonly TtlOption[] = [
  { value: "permanent", label: "长期", interval: null },
  { value: "1d",        label: "1 天", interval: "1 day" },
  { value: "1w",        label: "1 周", interval: "7 days" },
  { value: "1mo",       label: "1 月", interval: "1 mon" },
];

/** 服务端白名单：只认这三个字面量，其余一律 400。 */
export const TTL_INTERVALS: readonly string[] = TTL_OPTIONS
  .map((o) => o.interval)
  .filter((i): i is string => i !== null);

export function isValidTtlInterval(v: unknown): v is string {
  return typeof v === "string" && TTL_INTERVALS.includes(v);
}

/**
 * 把 formatPgInterval 的输出（"7天"、"1个月"）回显成档位口径（"1 周"、"1 月"）。
 * 存量或手工写入的非档位时长原样返回。
 */
const FORMATTED_TO_LABEL: Record<string, string> = {
  "1天":   "1 天",
  "7天":   "1 周",
  "1个月": "1 月",
};

export function displayTtlLabel(formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  return FORMATTED_TO_LABEL[formatted] ?? formatted;
}
