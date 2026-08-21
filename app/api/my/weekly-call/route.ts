import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { listWeeklyCallSchedule } from "@/lib/event-db";

type CalendarView = "week" | "month" | "agenda";

const CST_OFFSET = 8 * 3_600_000;
const DAY = 24 * 3_600_000;

function cstNow() {
  return new Date(Date.now() + CST_OFFSET);
}

function cstDateString(date: Date): string {
  const shifted = new Date(date.getTime() + CST_OFFSET);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function parseCstDate(value: string | null): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - CST_OFFSET);
  return Number.isNaN(date.getTime()) ? null : date;
}

function currentWeekRange(): { rangeStart: Date; rangeEnd: Date } {
  const now = cstNow();
  const dow = now.getUTCDay();
  const afterSundayNoon =
    dow === 0 && (now.getUTCHours() > 12 || (now.getUTCHours() === 12 && now.getUTCMinutes() >= 0));
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const weekOffset = afterSundayNoon ? 7 : 0;
  const mondayCSTDate = now.getUTCDate() - daysFromMonday + weekOffset;
  const rangeStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), mondayCSTDate) - CST_OFFSET,
  );
  return { rangeStart, rangeEnd: new Date(rangeStart.getTime() + 7 * DAY) };
}

function rangeFor(view: CalendarView, anchor: Date | null) {
  if (view === "week" && !anchor) return currentWeekRange();

  const base = anchor ?? new Date(Date.now());
  const shifted = new Date(base.getTime() + CST_OFFSET);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();

  if (view === "month") {
    const first = new Date(Date.UTC(year, month, 1) - CST_OFFSET);
    const firstDow = new Date(first.getTime() + CST_OFFSET).getUTCDay();
    const daysFromMonday = firstDow === 0 ? 6 : firstDow - 1;
    const rangeStart = new Date(first.getTime() - daysFromMonday * DAY);
    return { rangeStart, rangeEnd: new Date(rangeStart.getTime() + 42 * DAY) };
  }

  if (view === "agenda") {
    const rangeStart = new Date(Date.UTC(year, month, day) - CST_OFFSET);
    return { rangeStart, rangeEnd: new Date(rangeStart.getTime() + 30 * DAY) };
  }

  const baseDow = shifted.getUTCDay();
  const daysFromMonday = baseDow === 0 ? 6 : baseDow - 1;
  const rangeStart = new Date(Date.UTC(year, month, day - daysFromMonday) - CST_OFFSET);
  return { rangeStart, rangeEnd: new Date(rangeStart.getTime() + 7 * DAY) };
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  let userId: string;
  if (session) {
    userId = session.userId;
  } else {
    const t = req.nextUrl.searchParams.get("t");
    const tokenData = t ? verifyCardToken(t, "weekly-call") : null;
    if (!tokenData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    userId = tokenData.userId;
  }

  const requestedView = req.nextUrl.searchParams.get("view");
  const view: CalendarView = requestedView === "month" || requestedView === "agenda" ? requestedView : "week";
  const requestedAnchor = parseCstDate(req.nextUrl.searchParams.get("anchor"));
  const { rangeStart, rangeEnd } = rangeFor(view, requestedAnchor);
  const events = await listWeeklyCallSchedule(userId, rangeStart, rangeEnd);

  return NextResponse.json({
    events,
    view,
    anchor: requestedAnchor ? cstDateString(requestedAnchor) : cstDateString(new Date()),
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    // Keep the old response fields for existing clients and shared links.
    weekStart: rangeStart.toISOString(),
    weekEnd: rangeEnd.toISOString(),
  });
}
