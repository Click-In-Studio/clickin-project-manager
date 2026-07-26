import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, upsertAwaitingTechReqs, getEventDepartment } from "@/lib/event-db";
import { buildAwaitingReqCard } from "@/lib/feishu-bot";
import { getOptedInUsers } from "@/lib/notification-prefs";
import { BASE_PATH } from "@/lib/base-path";
import { getPool } from "@/lib/pg";
import { feishuPlatform } from "@/lib/platform/feishu";
import { batchResolveNotificationTargets } from "@/lib/platform/notification-router";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:schedule_edit", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as { departmentIds?: string[]; scheduleItemId?: string };
  const departmentIds = body.departmentIds ?? [];
  if (!departmentIds.length) return Response.json({ techReqs: [] });

  const existingRes = await getPool().query<{ department_id: string }>(
    `SELECT department_id FROM event_tech_req WHERE event_id = $1 AND department_id = ANY($2) AND status = 'awaiting'`,
    [eventId, departmentIds],
  );
  const alreadyExisting = new Set(existingRes.rows.map(r => r.department_id));

  const techReqs = await upsertAwaitingTechReqs(eventId, departmentIds, body.scheduleItemId);

  for (const req of techReqs) {
    if (!req.departmentId || alreadyExisting.has(req.departmentId)) continue;
    const dept = await getEventDepartment(req.departmentId, productionId);
    if (!dept?.chatId || !dept.pocUserIds.length) continue;

    const reqPath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reqs/${req.id}`;
    // Feishu open_ids still needed for @mention syntax inside the card body
    const userIdToOpenId = await batchGetFeishuOpenIds(dept.pocUserIds);
    const pocOpenIds = dept.pocUserIds.map(id => userIdToOpenId.get(id)).filter((v): v is string => !!v);
    const groupActionUrl = feishuPlatform.buildActionUrl(reqPath);
    const card = buildAwaitingReqCard(req.title || dept.name, event.title, dept.name, pocOpenIds, groupActionUrl);

    // Group notification via adapter
    feishuPlatform.sendGroupMessage(dept.chatId, {
      text: `新需求待确认：${req.title || dept.name}（${event.title}）`,
      richContent: card,
    }).catch(e => console.error("[awaiting-req] group notify failed:", e));

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
      const dmCard = buildAwaitingReqCard(req.title || dept.name, event.title, dept.name, pocOpenIds, dmActionUrl);
      target.adapter.sendDirectMessage(target.platformUserId, {
        text: `新需求待确认：${req.title || dept.name}（${event.title}），查看：${dmActionUrl}`,
        richContent: dmCard,
      }).catch(e => console.error("[awaiting-req] personal dm failed:", e));
    }
  }

  return Response.json({ techReqs });
}
