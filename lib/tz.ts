/**
 * Timezone utilities — all display and input conversion uses UTC+8 (CST) explicitly.
 * Never depends on the host system timezone or browser locale timezone.
 * Safe to import in both server components and client components.
 */

const TZ = 8 * 3_600_000; // UTC+8 offset in ms

function cst(iso: string): Date {
  return new Date(new Date(iso).getTime() + TZ);
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── ISO ↔ input value converters ────────────────────────────────────────────

/** UTC ISO → "YYYY-MM-DDTHH:mm"  (for <input type="datetime-local">, displayed as UTC+8) */
export function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  return cst(iso).toISOString().slice(0, 16);
}

/** UTC ISO → "YYYY-MM-DD"  (for <input type="date">, in UTC+8) */
export function isoToDateInput(iso: string | null | undefined): string {
  return isoToDatetimeLocal(iso).slice(0, 10);
}

/** UTC ISO → "HH:mm"  (for <input type="time">, in UTC+8) */
export function isoToTimeInput(iso: string | null | undefined): string {
  return isoToDatetimeLocal(iso).slice(11);
}

/**
 * "YYYY-MM-DDTHH:mm" datetime-local value → UTC ISO string.
 * Treats the value as UTC+8, regardless of the browser's local timezone.
 */
export function datetimeLocalToIso(local: string): string {
  return new Date(local + "+08:00").toISOString();
}

/**
 * "YYYY-MM-DD" date input + "HH:mm" time input (both UTC+8) → UTC ISO string.
 * Used when a date and time input are combined (e.g. single-day call times).
 */
export function dateTimeToIso(date: string, time: string): string {
  return new Date(`${date}T${time}+08:00`).toISOString();
}

// ─── Display formatters (all UTC+8) ──────────────────────────────────────────

/** "M月D日 HH:mm (UTC+8)" */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = cst(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC+8)`;
}

/** "M月D日" */
export function fmtDate(iso: string): string {
  const d = cst(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** "YYYY年M月D日" */
export function fmtDateLong(iso: string): string {
  const d = cst(iso);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** "HH:mm (UTC+8)" */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = cst(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC+8)`;
}

/**
 * Smart relative label: 今天/明天/周X/M月D日  +  HH:mm.
 * "Today/tomorrow" are determined in UTC+8, not the browser's local date.
 */
export function fmtCallAt(iso: string): string {
  const nowCST = cst(new Date().toISOString());
  // Midnight UTC+8 today → subtract 8h to get UTC
  const todayUTC = new Date(
    Date.UTC(nowCST.getUTCFullYear(), nowCST.getUTCMonth(), nowCST.getUTCDate()) - TZ,
  );
  const tomorrowUTC = new Date(todayUTC.getTime() + 86_400_000);
  const dayAfterUTC = new Date(tomorrowUTC.getTime() + 86_400_000);
  const weekEndUTC  = new Date(todayUTC.getTime() + 7 * 86_400_000);

  const d = new Date(iso);
  const hm = fmtTime(iso);
  if (d >= todayUTC    && d < tomorrowUTC) return `今天 ${hm}`;
  if (d >= tomorrowUTC && d < dayAfterUTC) return `明天 ${hm}`;
  if (d < weekEndUTC) return `周${"日一二三四五六"[cst(iso).getUTCDay()]} ${hm}`;
  return `${fmtDate(iso)} ${hm}`;
}

/** CST date string "YYYY-MM-DD" for the current moment. */
export function todayCSTStr(): string {
  const d = cst(new Date().toISOString());
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** CST date string "YYYY-MM-DD" for an ISO timestamp. */
export function isoCSTDateStr(iso: string): string {
  const d = cst(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
