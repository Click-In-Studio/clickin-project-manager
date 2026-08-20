/**
 * 金额：字符串 ↔ 整数分。
 *
 * 后端刻意把 NUMERIC(14,2) 一路当字符串传（见 lib/finance-db.ts 的 Expense.amount），
 * 到了展示层要合计就得有个地方落地。落地不能用 Number：14 位有效数字已经贴着
 * IEEE754 双精度的 15~16 位安全区，而 0.1+0.2 这类经典误差在「总预算 - 已使用」
 * 这种减法上会直接显示成 ¥370,000.00000000001。
 *
 * 所以统一转成 bigint 的「分」再算，只在最后一步格式化成人看的串。
 */

/** "1234.5" / "1234" / "1234.56" → 123450n / 123400n / 123456n */
// tsconfig 的 target 低于 ES2020，`0n` 这种字面量过不了类型检查（TS2737），
// 故一律用 BigInt() 构造。运行时没有差别。
const ZERO = BigInt(0), HUNDRED = BigInt(100);

export function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return ZERO;   // 入口有 AMOUNT_RE 把关，这里只是别让脏数据炸掉整页
  const [, sign, int, frac = ""] = m;
  const cents = BigInt(int) * HUNDRED + BigInt((frac + "00").slice(0, 2));
  return sign === "-" ? -cents : cents;
}

export function sumCents(amounts: string[]): bigint {
  return amounts.reduce((acc, a) => acc + toCents(a), ZERO);
}

/**
 * 123456n → "¥1,234.56"；整数金额省掉小数位（¥750,000 而不是 ¥750,000.00），
 * 与设计稿里的写法一致。差额可能为负（超支），故单独处理符号。
 */
export function fmtCny(cents: bigint): string {
  const neg = cents < ZERO;
  const abs = neg ? -cents : cents;
  const yuan = (abs / HUNDRED).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = abs % HUNDRED;
  return `${neg ? "-" : ""}¥${yuan}${frac === ZERO ? "" : `.${frac.toString().padStart(2, "0")}`}`;
}

/** 已用 / 预算 的百分比，取整。预算为 0 时返回 0 而不是 NaN/Infinity。 */
export function pctCents(spent: bigint, budget: bigint): number {
  if (budget <= ZERO) return 0;
  return Number((spent * HUNDRED) / budget);
}

export function pctUsed(spent: string, budget: string): number {
  return pctCents(toCents(spent), toCents(budget));
}
