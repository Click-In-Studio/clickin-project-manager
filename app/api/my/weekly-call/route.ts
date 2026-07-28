import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { verifyCardToken } from "@/lib/card-token";
import { listWeeklyCallSchedule } from "@/lib/event-db";

function cstNow() {
  return new Date(Date.now() + 8 * 3_600_000);
}

function currentWeekRange(): { weekStart: Date; weekEnd: Date } {
  const now = cstNow();
  const dow = now.getUTCDay();
  const afterSundayNoon =
    dow === 0 && (now.getUTCHours() > 12 || (now.getUTCHours() === 12 && now.getUTCMinutes() >= 0));
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const weekOffset = afterSundayNoon ? 7 : 0;
  const mondayCSTDate = now.getUTCDate() - daysFromMonday + weekOffset;
  const weekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), mondayCSTDate) - 8 * 3_600_000,
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  return { weekStart, weekEnd };
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

  const { weekStart, weekEnd } = currentWeekRange();
  const events = await listWeeklyCallSchedule(userId, weekStart, weekEnd);

  return NextResponse.json({
    events,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
  });
}
