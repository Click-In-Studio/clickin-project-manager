import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, upsertAwaitingTechReqs, getEventDepartment } from "@/lib/event-db";
import { buildAwaitingReqCard } from "@/lib/feishu-bot";
import { BASE_PATH } from "@/lib/base-path";
import { getPool } from "@/lib/pg";
import { feishuPlatform } from "@/lib/platform/feishu";
import { notifyUsers } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("event:edit_schedule", permCtx))
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
    if (!dept?.pocUserIds.length) continue;

    const reqPath = `${BASE_PATH}/production/${productionId}/tasks/${req.id}`;

    // Inbox + optional DM — always fires regardless of group chat.
    void notifyUsers({
      userIds: dept.pocUserIds,
      kind: "tech_req_poc",
      productionId,
      entityType: "tech_req",
      entityId: req.id,
      title: `新技术需求待确认 — ${dept.name}`,
      body: `${req.title || dept.name}（${event.title}）`,
      viewHref: reqPath,
      category: "action",
      actionRequired: true,
      buildExternalMessage: async (_userId, target) => {
        const dmActionUrl = target.adapter.buildActionUrl(reqPath);
        return {
          text: `新需求待确认：${req.title || dept.name}（${event.title}），查看：${dmActionUrl}`,
        };
      },
    }).catch(e => console.error("[awaiting-req] notify failed:", e));

    // Feishu group card — secondary, only if dept has a chatId.
    if (dept.chatId) {
      batchGetFeishuOpenIds(dept.pocUserIds).then(m => {
        const pocOpenIds = dept.pocUserIds.map(id => m.get(id)).filter((v): v is string => !!v);
        const groupActionUrl = feishuPlatform.buildActionUrl(reqPath);
        const card = buildAwaitingReqCard(req.title || dept.name, event.title, dept.name, pocOpenIds, groupActionUrl);
        feishuPlatform.sendGroupMessage(dept.chatId!, {
          text: `新需求待确认：${req.title || dept.name}（${event.title}）`,
          richContent: card,
        }).catch(e => console.error("[awaiting-req] group notify failed:", e));
      }).catch(e => console.error("[awaiting-req] group notify failed:", e));
    }
  }

  return Response.json({ techReqs });
}
