/**
 * POST /api/production/[id]/events/[eventId]/notify-awaiting-reqs
 *
 * Sends an urge card to each dept group chat that has unconfirmed (awaiting)
 * tech reqs for this event. One card per dept, listing all its pending reqs.
 * Permission: event:create (same as publishing).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventTechReqs, getEventDepartment } from "@/lib/event-db";
import { buildUrgeReqCard } from "@/lib/feishu-bot";
import { getOptedInUsers } from "@/lib/notification-prefs";
import { BASE_PATH } from "@/lib/base-path";
import { feishuPlatform } from "@/lib/platform/feishu";
import { batchResolveNotificationTargets } from "@/lib/platform/notification-router";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:create", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const allReqs = await listEventTechReqs(eventId);
  const awaitingReqs = allReqs.filter(r => r.status === "awaiting" && r.departmentId);

  const byDept = new Map<string, typeof awaitingReqs>();
  for (const r of awaitingReqs) {
    const key = r.departmentId!;
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key)!.push(r);
  }

  let notified = 0;

  for (const [deptId, reqs] of byDept) {
    const dept = await getEventDepartment(deptId, productionId);
    if (!dept?.chatId || !dept.pocUserIds.length) continue;

    // Feishu open_ids still needed for @mention syntax inside the card body
    const userIdToOpenId = await batchGetFeishuOpenIds(dept.pocUserIds);
    const pocOpenIds = dept.pocUserIds.map(id => userIdToOpenId.get(id)).filter((v): v is string => !!v);

    const reqPath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reqs`;
    const groupActionUrl = feishuPlatform.buildActionUrl(reqPath);
    const card = buildUrgeReqCard(event.title, dept.name, reqs.map(r => r.title), pocOpenIds, groupActionUrl);

    await feishuPlatform.sendGroupMessage(dept.chatId, {
      text: `需求确认催办 — ${dept.name}，${reqs.length} 个需求待处理`,
      richContent: card,
    }).catch(e => console.error(`[notify-awaiting] dept ${deptId} failed:`, e));

    // Personal DM copies for opted-in POCs — routed through platform adapter
    const [optedIn, targets] = await Promise.all([
      getOptedInUsers("tech_req_poc"),
      batchResolveNotificationTargets(dept.pocUserIds, productionId),
    ]);
    for (const userId of dept.pocUserIds) {
      if (!optedIn.has(userId)) continue;
      const target = targets.get(userId);
      if (!target) continue;
      const dmActionUrl = target.adapter.buildActionUrl(reqPath);
      const dmCard = buildUrgeReqCard(event.title, dept.name, reqs.map(r => r.title), pocOpenIds, dmActionUrl);
      target.adapter.sendDirectMessage(target.platformUserId, {
        text: `需求确认催办 — ${dept.name}，${reqs.length} 个需求待处理，查看：${dmActionUrl}`,
        richContent: dmCard,
      }).catch(e => console.error("[notify-awaiting] personal dm failed:", e));
    }
    notified++;
  }

  return Response.json({ notified, total: byDept.size });
}
