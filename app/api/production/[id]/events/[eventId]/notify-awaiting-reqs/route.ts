/**
 * POST /api/production/[id]/events/[eventId]/notify-awaiting-reqs
 *
 * Sends an urge card to each dept group chat that has unconfirmed (awaiting)
 * tech reqs for this event. One card per dept, listing all its pending reqs.
 * Permission: event:create (same as publishing).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventTechReqs, getEventDepartment } from "@/lib/event-db";
import { sendChatCard, sendCard, buildUrgeReqCard } from "@/lib/feishu-bot";
import { getOptedInUsers } from "@/lib/notification-prefs";
import { BASE_PATH } from "@/lib/base-path";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  if (!hasPermission("event:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const allReqs = await listEventTechReqs(eventId);
  const awaitingReqs = allReqs.filter(r => r.status === "awaiting" && r.departmentId);

  // Group by department
  const byDept = new Map<string, typeof awaitingReqs>();
  for (const r of awaitingReqs) {
    const key = r.departmentId!;
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key)!.push(r);
  }

  const appId = process.env.FEISHU_APP_ID ?? "";
  let notified = 0;

  for (const [deptId, reqs] of byDept) {
    const dept = await getEventDepartment(deptId, productionId);
    if (!dept?.chatId || !dept.pocOpenIds.length) continue;

    // Link to the event's reqs tab
    const reqPath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reqs`;
    const url = `https://applink.feishu.cn/client/web_app/open?appId=${appId}&path=${encodeURIComponent(reqPath)}`;
    const card = buildUrgeReqCard(
      event.title, dept.name,
      reqs.map(r => r.title),
      dept.pocOpenIds,
      url,
    );
    await sendChatCard(dept.chatId, card).catch(e =>
      console.error(`[notify-awaiting] dept ${deptId} failed:`, e)
    );
    // Extra personal DM for POCs who opted in to tech_req_poc
    getOptedInUsers("tech_req_poc").then((optedIn) => {
      for (const pocId of dept.pocOpenIds) {
        if (optedIn.has(pocId)) sendCard(pocId, card).catch(e => console.error("[notify-awaiting] personal dm failed:", e));
      }
    }).catch(() => {});
    notified++;
  }

  return Response.json({ notified, total: byDept.size });
}
