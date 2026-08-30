// 定时任务的时间表：解析、算下一次触发、人话描述（纯函数，无 DB）。
//
// 三种 kind（形状照抄 OpenClaw cron 工具，模型对它们已有先验）：
//   { kind: "at",    at: ISO-8601 }                一次性；跑完即 done
//   { kind: "cron",  expr: "0 23 * * *", tz? }     五段 cron，expr 是 tz 的**墙钟时间**——绝不换算成 UTC
//   { kind: "every", everyMs }                     固定间隔（从上次计划时间起算）
//
// 时区用 Intl 做墙钟 ↔ 瞬时的换算（不引依赖）：cron 的匹配按天枚举——先看这一天
// （dom/month/dow）中不中，中了再枚举小时/分钟集合——而不是逐分钟扫，最坏也只是
// 400 天 × 小时集合大小。Asia/Shanghai 没有夏令时，但换算仍按通用做法（两次偏移校正）。

import { SCHEDULE_LIMITS } from "@/lib/plan";

export type Schedule =
  | { kind: "at"; at: string }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number };

export const DEFAULT_TZ = "Asia/Shanghai";

// ── cron 解析 ─────────────────────────────────────────────────────────────────

export interface CronSpec {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  /** 标准 cron 语义：dom 与 dow 都受限时取"或" */
  domRestricted: boolean; dowRestricted: boolean;
}

const RANGES: Record<"minute" | "hour" | "dom" | "month" | "dow", [number, number]> = { minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 7] };

function parseField(field: string, name: keyof typeof RANGES): Set<number> {
  const [lo, hi] = RANGES[name];
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron 字段 ${name} 不合法：${part}`);
    let start: number = lo; let end: number = hi;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      start = a; end = b ?? a;
      // 范围里的单值（无步进）就是它自己
      if (b === undefined && m[2] === undefined) end = a;
      else if (b === undefined) end = hi; // "5/10" = 从 5 起每 10
    }
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 字段 ${name} 步进不合法：${part}`);
    if (start < lo || end > hi || start > end) throw new Error(`cron 字段 ${name} 超出范围：${part}`);
    for (let v = start; v <= end; v += step) out.add(name === "dow" && v === 7 ? 0 : v);
  }
  if (out.size === 0) throw new Error(`cron 字段 ${name} 为空`);
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 表达式必须是 5 段：分 时 日 月 周");
  const [mi, h, d, mo, w] = fields;
  return {
    minute: parseField(mi, "minute"), hour: parseField(h, "hour"), dom: parseField(d, "dom"),
    month: parseField(mo, "month"), dow: parseField(w, "dow"),
    domRestricted: d.trim() !== "*", dowRestricted: w.trim() !== "*",
  };
}

// ── 时区 ─────────────────────────────────────────────────────────────────────

interface Wall { y: number; mo: number; d: number; h: number; mi: number; dow: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>;

export function isValidTimeZone(tz: string): boolean {
  try { formatter(tz); return true; } catch { return false; }
}

/** 瞬时 → tz 的墙钟字段 */
export function wallClock(date: Date, tz: string): Wall {
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")), h: Number(get("hour")) % 24, mi: Number(get("minute")), dow: DOW[get("weekday")] ?? 0 };
}

function tzOffsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** tz 的墙钟 → 瞬时（两次偏移校正处理夏令时切换；落进不存在的墙钟（春季空洞）时向后取）。 */
export function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = new Date(guess - tzOffsetMs(new Date(guess), tz));
  const second = new Date(guess - tzOffsetMs(first, tz));
  const w = wallClock(second, tz);
  // 第二次校正没落回要求的墙钟 = 这个墙钟不存在（空洞）；first 是往后跨过空洞的那个
  return w.h === h % 24 && w.mi === mi ? second : first;
}

// ── 下一次触发 ────────────────────────────────────────────────────────────────

const MAX_DAYS = 400;

/** 严格晚于 after 的下一次 cron 触发；400 天内没有 → null（如 2 月 30 日）。 */
export function nextCronFire(spec: CronSpec, tz: string, after: Date): Date | null {
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);
  const startWall = wallClock(after, tz);
  // 从 after 所在的那一天开始逐日枚举（按 tz 的日历日）
  for (let day = 0; day < MAX_DAYS; day++) {
    const dayStart = wallToInstant(startWall.y, startWall.mo, startWall.d + day, 12, 0, tz); // 正午取日期，避开跨日偏移
    const w = wallClock(dayStart, tz);
    if (!spec.month.has(w.mo)) continue;
    const domHit = spec.dom.has(w.d);
    const dowHit = spec.dow.has(w.dow);
    const dayOk = spec.domRestricted && spec.dowRestricted ? domHit || dowHit : spec.domRestricted ? domHit : spec.dowRestricted ? dowHit : true;
    if (!dayOk) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const t = wallToInstant(w.y, w.mo, w.d, h, mi, tz);
        if (t.getTime() > after.getTime()) return t;
      }
    }
  }
  return null;
}

/** 时间表的下一次触发（严格晚于 after）。null = 不会再触发（at 已过 / cron 无解）。 */
export function nextFireAt(schedule: Schedule, after: Date): Date | null {
  switch (schedule.kind) {
    case "at": {
      const t = new Date(schedule.at);
      return Number.isNaN(t.getTime()) || t.getTime() <= after.getTime() ? null : t;
    }
    case "every":
      return new Date(after.getTime() + schedule.everyMs);
    case "cron":
      return nextCronFire(parseCron(schedule.expr), schedule.tz ?? DEFAULT_TZ, after);
  }
}

// ── 校验（创建/修改时；成本闸常量在 lib/plan.ts）────────────────────────────────

export type ScheduleValidation = { ok: true; schedule: Schedule; firesPerDay: number } | { ok: false; error: string };

/** 模型给的松散对象 → 规范化时间表；不合法 / 太勤 / 永不触发 都在这里拒。 */
export function validateSchedule(raw: unknown, now = new Date()): ScheduleValidation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "schedule 缺失" };
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (kind === "at") {
    if (typeof s.at !== "string") return { ok: false, error: "at 时间表需要 ISO-8601 的 at 字段（带时区偏移，如 2026-09-01T09:00:00+08:00）" };
    const t = new Date(s.at);
    if (Number.isNaN(t.getTime())) return { ok: false, error: `at 不是合法时间：${s.at}` };
    if (t.getTime() <= now.getTime()) return { ok: false, error: "at 必须是未来的时间" };
    if (t.getTime() - now.getTime() > SCHEDULE_LIMITS.maxAtHorizonMs) return { ok: false, error: "一次性任务最远只能定到一年内" };
    return { ok: true, schedule: { kind: "at", at: t.toISOString() }, firesPerDay: 0 };
  }
  if (kind === "every") {
    const ms = Number(s.everyMs);
    if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: "every 时间表需要正整数 everyMs" };
    if (ms < SCHEDULE_LIMITS.minIntervalMs) return { ok: false, error: `间隔不能短于 ${SCHEDULE_LIMITS.minIntervalMs / 60_000} 分钟` };
    return { ok: true, schedule: { kind: "every", everyMs: Math.round(ms) }, firesPerDay: (24 * 60 * 60_000) / ms };
  }
  if (kind === "cron") {
    if (typeof s.expr !== "string") return { ok: false, error: "cron 时间表需要 expr 字段" };
    const tz = typeof s.tz === "string" && s.tz ? s.tz : DEFAULT_TZ;
    if (!isValidTimeZone(tz)) return { ok: false, error: `时区不合法：${tz}` };
    let spec: CronSpec;
    try { spec = parseCron(s.expr); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    // 未来 7 天采样算日均频次；一次都不触发也拒（如 2 月 30 日）
    let count = 0;
    let cursor: Date | null = now;
    const horizon = now.getTime() + 7 * 24 * 60 * 60_000;
    while (cursor && count <= SCHEDULE_LIMITS.maxFiresPerDay * 7 + 1) {
      cursor = nextCronFire(spec, tz, cursor);
      if (!cursor || cursor.getTime() > horizon) break;
      count++;
    }
    const firesPerDay = count / 7;
    if (firesPerDay > SCHEDULE_LIMITS.maxFiresPerDay) return { ok: false, error: `这个 cron 每天触发约 ${Math.round(firesPerDay)} 次，超过上限 ${SCHEDULE_LIMITS.maxFiresPerDay} 次/日` };
    if (!nextCronFire(spec, tz, now)) return { ok: false, error: "这个 cron 表达式在未来一年内不会触发" };
    return { ok: true, schedule: { kind: "cron", expr: s.expr.trim(), tz }, firesPerDay };
  }
  return { ok: false, error: "schedule.kind 必须是 at / cron / every 之一" };
}

// ── 人话 ─────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

export function formatInTz(date: Date, tz = DEFAULT_TZ): string {
  const w = wallClock(date, tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
}

function listOf(set: Set<number>, lo: number, hi: number): number[] | null {
  if (set.size === hi - lo + 1) return null; // 全集 = *
  return [...set].sort((a, b) => a - b);
}

/** 时间表 → 人话（卡片/列表/通知共用）。cron 只覆盖常见形态，其余回退到表达式原文。 */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "at") return `${formatInTz(new Date(schedule.at))} 一次（${DEFAULT_TZ}）`;
  if (schedule.kind === "every") {
    const ms = schedule.everyMs;
    if (ms % (24 * 3_600_000) === 0) return `每 ${ms / (24 * 3_600_000)} 天`;
    if (ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
    return `每 ${Math.round(ms / 60_000)} 分钟`;
  }
  const tz = schedule.tz ?? DEFAULT_TZ;
  let spec: CronSpec;
  try { spec = parseCron(schedule.expr); } catch { return `cron ${schedule.expr}（${tz}）`; }
  const mins = listOf(spec.minute, 0, 59);
  const hours = listOf(spec.hour, 0, 23);
  const doms = listOf(spec.dom, 1, 31);
  const months = listOf(spec.month, 1, 12);
  const dows = listOf(spec.dow, 0, 6);
  const tzNote = tz === DEFAULT_TZ ? "" : `（${tz}）`;
  if (mins && hours && mins.length === 1 && hours.length <= 3) {
    const time = hours.map((h) => `${pad(h)}:${pad(mins[0])}`).join("、");
    if (!doms && !months && !dows) return `每天 ${time}${tzNote}`;
    if (!doms && !months && dows) return `每周${dows.map((d) => WEEKDAYS[d]).join("、")} ${time}${tzNote}`;
    if (doms && !months && !dows) return `每月 ${doms.join("、")} 日 ${time}${tzNote}`;
  }
  if (mins && mins.length === 1 && !hours && !doms && !months && !dows) return `每小时的第 ${mins[0]} 分${tzNote}`;
  return `cron ${schedule.expr}（${tz}）`;
}
