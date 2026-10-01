/**
 * 币种与金额的客户端安全原语。
 *
 * 词表来自 ISO 4217 Maintenance Agency 的 2026-09-17 List One，排除基金、贵金属、
 * 测试码和“无币种”。金额始终以字符串或 bigint 运算，绝不经过 JS number。
 */

export const CURRENCY_MINOR_UNITS = {
  AED: 2, AFN: 2, ALL: 2, AMD: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BRL: 2,
  BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2, CAD: 2, CDF: 2, CHF: 2, CLP: 0,
  CNY: 2, COP: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2, DJF: 0, DKK: 2, DOP: 2,
  DZD: 2, EGP: 2, ERN: 2, ETB: 2, EUR: 2, FJD: 2, FKP: 2, GBP: 2, GEL: 2,
  GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2, HKD: 2, HNL: 2, HTG: 2,
  HUF: 2, IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0, JMD: 2, JOD: 3,
  JPY: 0, KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2,
  KZT: 2, LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3, MAD: 2, MDL: 2,
  MGA: 2, MKD: 2, MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2, MWK: 2,
  MXN: 2, MYR: 2, MZN: 2, NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2,
  OMR: 3, PAB: 2, PEN: 2, PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0, QAR: 2,
  RON: 2, RSD: 2, RUB: 2, RWF: 0, SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2,
  SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2, SSP: 2, STN: 2, SVC: 2, SYP: 2,
  SZL: 2, THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2,
  TZS: 2, UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2, VED: 2, VES: 2, VND: 0,
  VUV: 0, WST: 2, XAF: 0, XCD: 2, XCG: 2, XOF: 0, XPF: 0, YER: 2, ZAR: 2,
  ZMW: 2, ZWG: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_MINOR_UNITS;
export const CURRENCY_CODES = Object.keys(CURRENCY_MINOR_UNITS) as CurrencyCode[];

const CURRENCY_DISPLAY_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "currency", fallback: "code" })
  : null;

const ZERO = BigInt(0);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);

function pow10(scale: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < scale; i++) result *= TEN;
  return result;
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(CURRENCY_MINOR_UNITS, value);
}

export function currencyMinorUnits(currency: CurrencyCode): number {
  return CURRENCY_MINOR_UNITS[currency];
}

export function currencyDisplayName(currency: CurrencyCode): string {
  return CURRENCY_DISPLAY_NAMES?.of(currency) ?? currency;
}

/** 给填写人看中文名，ISO 代码保留作跨票据、银行账单核对。 */
export function formatCurrencyLabel(currency: CurrencyCode): string {
  const name = currencyDisplayName(currency);
  return name === currency ? currency : `${name}（${currency}）`;
}

/** NUMERIC(18,3) 的统一入口：最多 15 位整数，且小数位必须符合币种。 */
export function isMoneyAmount(value: string, currency: CurrencyCode): boolean {
  const digits = currencyMinorUnits(currency);
  return new RegExp(`^\\d{1,15}${digits === 0 ? "" : `(?:\\.\\d{1,${digits}})?`}$`).test(value);
}

export function normalizeMoneyAmount(value: string, currency: CurrencyCode): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const digits = currencyMinorUnits(currency);
  const fraction = match[2] ?? "";
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return value;
  return digits === 0 ? match[1] : `${match[1]}.${fraction.slice(0, digits).padEnd(digits, "0")}`;
}

export function isExchangeRate(value: string): boolean {
  return /^\d{1,12}(?:\.\d{1,12})?$/.test(value) && !/^0(?:\.0+)?$/.test(value);
}

function parseScaled(value: string, scale: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[3]?.length ?? 0) > scale) return null;
  const fraction = (match[3] ?? "").padEnd(scale, "0");
  const units = BigInt(match[2]) * pow10(scale) + BigInt(fraction || "0");
  return match[1] === "-" ? -units : units;
}

function scaledToDecimal(units: bigint, scale: number): string {
  const negative = units < ZERO;
  const absolute = negative ? -units : units;
  const divisor = pow10(scale);
  const integer = absolute / divisor;
  const fraction = scale === 0 ? "" : `.${(absolute % divisor).toString().padStart(scale, "0")}`;
  return `${negative ? "-" : ""}${integer}${fraction}`;
}

export function toMinorUnits(amount: string, currency: CurrencyCode): bigint {
  return parseScaled(amount, currencyMinorUnits(currency)) ?? ZERO;
}

export function sumMoney(amounts: string[], currency: CurrencyCode): bigint {
  return amounts.reduce((sum, amount) => sum + toMinorUnits(amount, currency), ZERO);
}

/** 精确显示，显式带 ISO 代码，避免 ¥/$ 等符号歧义。 */
export function formatMoney(amount: string, currency: CurrencyCode): string {
  const scale = currencyMinorUnits(currency);
  const units = parseScaled(amount, scale);
  if (units === null) return `${formatCurrencyLabel(currency)} ${amount}`;
  const normalized = scaledToDecimal(units, scale);
  const negative = normalized.startsWith("-");
  const [integer, fraction] = (negative ? normalized.slice(1) : normalized).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${formatCurrencyLabel(currency)} ${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function formatMinorUnits(units: bigint, currency: CurrencyCode): string {
  return formatMoney(scaledToDecimal(units, currencyMinorUnits(currency)), currency);
}

/** amount × rate，按本位币小数位四舍五入；rate 方向为 1 原币 = rate 本位币。 */
export function convertToBaseAmount(amount: string, rate: string, baseCurrency: CurrencyCode): string | null {
  const amountMatch = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  const rateMatch = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!amountMatch || !rateMatch || !isExchangeRate(rate)) return null;
  const amountFraction = amountMatch[2] ?? "";
  const rateFraction = rateMatch[2] ?? "";
  const product = BigInt(amountMatch[1] + amountFraction) * BigInt(rateMatch[1] + rateFraction);
  const productScale = amountFraction.length + rateFraction.length;
  const targetScale = currencyMinorUnits(baseCurrency);
  let rounded: bigint;
  if (productScale <= targetScale) {
    rounded = product * pow10(targetScale - productScale);
  } else {
    const divisor = pow10(productScale - targetScale);
    rounded = (product + divisor / BigInt(2)) / divisor;
  }
  return scaledToDecimal(rounded, targetScale);
}

export function pctMoney(spent: string, budget: string, currency: CurrencyCode): number {
  const budgetUnits = toMinorUnits(budget, currency);
  if (budgetUnits <= ZERO) return 0;
  return Number((toMinorUnits(spent, currency) * HUNDRED) / budgetUnits);
}

// 旧 CNY 调用面的窄兼容；新财务代码一律显式传币种。
export const toCents = (amount: string) => toMinorUnits(amount, "CNY");
export const sumCents = (amounts: string[]) => sumMoney(amounts, "CNY");
export function fmtCny(cents: bigint): string {
  const normalized = scaledToDecimal(cents, 2);
  const negative = normalized.startsWith("-");
  const [integer, fraction] = (negative ? normalized.slice(1) : normalized).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const visibleFraction = fraction === "00" ? "" : `.${fraction}`;
  return `${negative ? "-" : ""}¥${grouped}${visibleFraction}`;
}
export function pctCents(spent: bigint, budget: bigint): number {
  return budget <= ZERO ? 0 : Number((spent * HUNDRED) / budget);
}
export const pctUsed = (spent: string, budget: string) => pctMoney(spent, budget, "CNY");
