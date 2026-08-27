/**
 * 权限申请的时效档位 —— 前后端唯一定义。
 *
 * #256 的成因是两个申请入口各自硬编码档位：AccessRequestModal 发
 * `"30 minutes"`/`"1 hour"`/…，AccessRequestsClient 的 RequestForm 干脆不发
 * ttlDuration，服务端又照单全收 —— `grant_type='ttl'` 配 `ttl_duration IS NULL`
 * 静默通过，批准时 `expires_at` 落 NULL，而 NULL 在每一处权限检查里都等于永久。
 * 所以档位表只能有一份，且服务端必须按这份表白名单校验，不接受任意 INTERVAL 串。
 */

export type TtlOptionValue = "1w" | "30d" | "180d" | "permanent" | "custom";

export type TtlOption = {
  value: TtlOptionValue;
  label: string;
  /** Postgres INTERVAL 字面量；permanent 为 null（不写 ttl_duration）。 */
  interval: string | null;
};

/** 申请侧统一档位。自定义项通过 requestedExpiresAt 传绝对时间，不写 interval。 */
export const TTL_OPTIONS: readonly TtlOption[] = [
  { value: "1w",        label: "1 周", interval: "7 days" },
  { value: "30d",       label: "30 天", interval: "30 days" },
  { value: "180d",      label: "180 天", interval: "180 days" },
  { value: "permanent", label: "长期", interval: null },
  { value: "custom",    label: "自定义", interval: null },
];

/** 服务端白名单：只认这三个字面量，其余一律 400。 */
export const TTL_INTERVALS: readonly string[] = TTL_OPTIONS
  .map((o) => o.interval)
  .filter((i): i is string => i !== null);

export function isValidTtlInterval(v: unknown): v is string {
  return typeof v === "string" && TTL_INTERVALS.includes(v);
}

/** 自定义到期时间使用 ISO 绝对时间，并且提交时必须仍在未来。 */
export function isValidCustomExpiry(v: unknown, now = Date.now()): v is string {
  if (typeof v !== "string" || v.trim() === "") return false;
  const timestamp = Date.parse(v);
  return Number.isFinite(timestamp) && timestamp > now;
}

/**
 * 把浏览器 date 输入解释为用户本地时区当天结束，返回服务端可校验的 ISO 时间。
 *
 * **只能在浏览器里调**（连同下面的 ttlPayloadForSelection / localTodayDateInputValue）。
 * 不带时区的 `new Date("YYYY-MM-DDT23:59:59.999")` 按**执行环境**的时区解析——
 * 在服务端跑就成了服务器时区的当天结束，会把申请人选的日子静默平移几个小时。
 * 这三个函数当前只有 AccessRequestModal / AccessRequestsClient 两个 "use client"
 * 组件在用；服务端要的是已经定好的绝对时间（isValidCustomExpiry 那一侧）。
 */
export function customExpiryDateToIso(dateValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const endOfDay = new Date(`${dateValue}T23:59:59.999`);
  return Number.isNaN(endOfDay.getTime()) ? null : endOfDay.toISOString();
}

export function localTodayDateInputValue(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function ttlPayloadForSelection(value: TtlOptionValue, customDate: string): {
  grantType: "permanent" | "ttl";
  ttlDuration: string | null;
  requestedExpiresAt: string | null;
} {
  if (value === "permanent") {
    return { grantType: "permanent", ttlDuration: null, requestedExpiresAt: null };
  }
  if (value === "custom") {
    return {
      grantType: "ttl",
      ttlDuration: null,
      requestedExpiresAt: customExpiryDateToIso(customDate),
    };
  }
  return {
    grantType: "ttl",
    ttlDuration: TTL_OPTIONS.find((option) => option.value === value)?.interval ?? null,
    requestedExpiresAt: null,
  };
}

/**
 * 把 formatPgInterval 的输出（"7天"、"180天"）回显成档位口径。
 * 存量或手工写入的非档位时长原样返回。
 */
const FORMATTED_TO_LABEL: Record<string, string> = {
  "7天":   "1 周",
  "30天":  "30 天",
  "180天": "180 天",
  // 已退役的旧档位（2026-08-17 前提交的申请、以及 seed 演示数据）仍在库里，
  // 回显口径不能跟着档位表一起删——删掉这两条，那些行就从「1 月」变回 pg 的
  // 原样「1个月」。这张表的职责是「pg 输出 → 人话」，不是「当前档位表」。
  "1天":   "1 天",
  "1个月": "1 月",
};

export function displayTtlLabel(formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  return FORMATTED_TO_LABEL[formatted] ?? formatted;
}
