import type { ProductionEvent } from "@/lib/ops/event-db";
import { isoToDatetimeLocal, isoToDateInput, isoToTimeInput } from "@/lib/tz";

export function toLocalInput(iso: string | null)     { return isoToDatetimeLocal(iso); }
export function toLocalDate(iso: string | null)       { return isoToDateInput(iso); }
export function toLocalTimeInput(iso: string | null)  { return isoToTimeInput(iso); }
export function isSingleDayEvent(event: ProductionEvent): boolean {
  if (!event.startTime || !event.endTime) return false;
  const s = isoToDatetimeLocal(event.startTime);
  const e = isoToDatetimeLocal(event.endTime);
  return s.slice(0, 10) === e.slice(0, 10) && s.slice(11) === "00:00" && e.slice(11) === "23:59";
}

// ─── InfoTab ──────────────────────────────────────────────────────────────────
