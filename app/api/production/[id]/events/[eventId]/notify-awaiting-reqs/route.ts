/**
 * POST /api/production/[id]/events/[eventId]/notify-awaiting-reqs
 *
 * Urges POCs to confirm their unconfirmed (awaiting) tech reqs for this event.
 * Sends one inbox notification per awaiting req so each can be individually acted.
 * Also sends a Feishu group card per dept as a summary (secondary, chatId-gated).
 * Permission: event:create (same as publishing).
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, listEventTechReqs, getEventDepartment } from "@/lib/event-db";
import { buildUrgeReqCard } from "@/lib/platform/feishu/feishu-bot";
import { SERVER_URL as BASE_PATH } from "@/lib/server-url";
import { feishuPlatform } from "@/lib/platform/feishu";
import { notifyUsers } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!hasPermission("event:create", permCtx))
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
    if (!dept?.pocUserIds.length) continue;

    // One inbox notification per awaiting req so each can be individually acted.
    for (const techReq of reqs) {
      const reqPath = `${BASE_PATH}/production/${productionId}/tasks/${techReq.id}`;
      await notifyUsers({
        userIds: dept.pocUserIds,
        kind: "tech_req_poc",
        productionId,
        entityType: "tech_req",
        entityId: techReq.id,
        title: `需求确认催办 — ${dept.name}`,
        body: `${techReq.title || dept.name}（${event.title}）`,
        viewHref: reqPath,
        category: "action",
        actionRequired: true,
        buildExternalMessage: async (_userId, target) => {
          const dmActionUrl = target.adapter.buildActionUrl(reqPath);
          return {
            text: `需求确认催办：${techReq.title || dept.name}（${event.title}），查看：${dmActionUrl}`,
          };
        },
      }).catch(e => console.error("[notify-awaiting] inbox/dm failed:", e));
    }

    // Feishu group card — secondary summary, only if dept has a chatId.
    if (dept.chatId) {
      const listPath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reqs`;
      const userIdToOpenId = await batchGetFeishuOpenIds(dept.pocUserIds);
      const pocOpenIds = dept.pocUserIds.map(id => userIdToOpenId.get(id)).filter((v): v is string => !!v);
      const groupActionUrl = feishuPlatform.buildActionUrl(listPath);
      const card = buildUrgeReqCard(event.title, dept.name, reqs.map(r => r.title), pocOpenIds, groupActionUrl);
      await feishuPlatform.sendGroupMessage(dept.chatId, {
        text: `需求确认催办 — ${dept.name}，${reqs.length} 个需求待处理`,
        richContent: card,
      }).catch(e => console.error(`[notify-awaiting] group chat ${deptId} failed:`, e));
    }

    notified++;
  }

  return Response.json({ notified, total: byDept.size });
}
