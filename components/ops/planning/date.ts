import { dateTimeToIso, fmtTime, isoCSTDateStr } from "@/lib/tz";

// 时间一律 CST（UTC+8），不跟浏览器时区走——全库口径见 lib/tz.ts。
// 原实现用 getFullYear/getHours 这类本地方法，非 CST 时区的用户会看到偏移过的
// 时间，而且写回去时把本地时间当成 CST 存，把数据也写歪。

/**
 * 日历格子的 Date → "YYYY-MM-DD"。
 *
 * 格子 Date 一律用 Date.UTC 构造（见 CalendarView 的 cells），所以这里读 UTC 部件
 * 就是那一天本身，**不能再 +8**——格子代表的是「CST 的某一天」这个概念，不是某个
 * 时刻。事件落到哪一格另走 isoCSTDateStr（ISO 时刻 → CST 日期），两者对齐。
 */
export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** ISO → CST 的 "HH:mm" */
export function hhmm(iso: string): string {
  return fmtTime(iso);
}

export const DAY_MS = 86_400_000;
export const CST_AXIS_OFFSET_MS = 8 * 3_600_000;

export function floorToMonday(d: Date): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  r.setUTCDate(r.getUTCDate() - ((r.getUTCDay() + 6) % 7));
  return r;
}

/**
 * 甘特轴把 Date 当作“CST 墙上日期”的无时区坐标使用，统一读取 UTC 部件。
 * ISO 时刻先平移 +8h；纯日期直接按 UTC 构造，避免浏览器所在时区改变分桶。
 */
export function cstAxisDateFromIso(iso: string): Date {
  return new Date(new Date(iso).getTime() + CST_AXIS_OFFSET_MS);
}

export function dateOnlyAxisMs(date: string, endOfDay = false): number {
  return Date.parse(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** ISO → 当天 CST 的分钟数（时间轴定位用） */
export function minutesOfIso(iso: string): number {
  const [h, m] = fmtTime(iso).split(":").map(Number);
  return h * 60 + m;
}

export function fmtMin(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 保留 ISO 的 CST 日期，换成给定的 CST "HH:mm" → UTC ISO */
export function withTime(iso: string, value: string): string {
  return dateTimeToIso(isoCSTDateStr(iso), value);
}
