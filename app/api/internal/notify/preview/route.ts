/**
 * Local preview endpoint — no auth required in dev, blocked in prod.
 *
 * Usage:
 *   GET /api/internal/notify/preview?type=weekly
 *   GET /api/internal/notify/preview?type=daily&eventId=xxx
 *   GET /api/internal/notify/preview?type=report&reportId=xxx&eventId=xxx&productionId=xxx
 *
 * Returns { dryMessages: [{ platformUserId, platformId, message }] }.
 * For feishu, message.richContent is the card JSON — paste into
 * https://open.feishu.cn/tool/cardbuilder to preview the layout.
 */
import { type NextRequest } from "next/server";
import { dispatchWeeklyCall, dispatchDailyCallForEvent, dispatchReportNotification } from "@/lib/notify";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "not available in production" }, { status: 403 });
  }

  const p = req.nextUrl.searchParams;
  const type = p.get("type");

  if (type === "weekly") {
    const result = await dispatchWeeklyCall(true);
    return Response.json(result);
  }

  if (type === "daily") {
    const eventId = p.get("eventId");
    if (!eventId) return Response.json({ error: "eventId required" }, { status: 400 });
    const result = await dispatchDailyCallForEvent(eventId, true);
    return Response.json(result);
  }

  if (type === "report") {
    const reportId = p.get("reportId");
    const eventId = p.get("eventId");
    const productionId = p.get("productionId");
    if (!reportId || !eventId || !productionId)
      return Response.json({ error: "reportId, eventId, productionId required" }, { status: 400 });
    const result = await dispatchReportNotification(reportId, eventId, productionId, true);
    return Response.json(result);
  }

  return Response.json({ error: "type must be weekly | daily | report" }, { status: 400 });
}
