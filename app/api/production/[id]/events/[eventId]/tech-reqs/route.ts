import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionEvent, listEventTechReqs, createEventTechReq, getEventDepartment } from "@/lib/event-db";
import { hasResourceGrantLevel } from "@/lib/resource-grant-db";
import { buildAwaitingReqCard } from "@/lib/platform/feishu/feishu-bot";
import { batchGetFeishuOpenIds } from "@/lib/db";
import { feishuPlatform } from "@/lib/platform/feishu";
import { SERVER_URL } from "@/lib/server-url";
import { notifyUsers } from "@/lib/notify";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `tr${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const techReqs = await listEventTechReqs(eventId);
  return Response.json({ techReqs });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  // Creating a tech_req requires edit-level on the event
  if (!permCtx.isAdmin && !await hasResourceGrantLevel(session.userId, productionId, "event", eventId, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    title?: string; description?: string; scheduleItemIds?: string[];
    presetMinutes?: number | null; departmentId?: string | null;
    assignees?: { userId: string; name: string }[];
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });

  const techReq = await createEventTechReq({
    id: uid(),
    eventId,
    scheduleItemIds: body.scheduleItemIds ?? [],
    title,
    description: body.description ?? "",
    presetMinutes: body.presetMinutes ?? null,
    departmentId: body.departmentId ?? null,
    assignees: body.assignees ?? [],
    createdBy: session.userId,
  });

  // Notify POCs when a new awaiting req is created for their department.
  if (techReq.status === "awaiting" && techReq.departmentId) {
    const dept = await getEventDepartment(techReq.departmentId, productionId);
    if (dept?.pocUserIds.length) {
      const reqPath = `${SERVER_URL}/production/${productionId}/tasks/${techReq.id}`;

      void notifyUsers({
        userIds: dept.pocUserIds,
        kind: "tech_req_poc",
        productionId,
        entityType: "tech_req",
        entityId: techReq.id,
        title: `新技术需求待确认 — ${dept.name}`,
        body: `${techReq.title}（${event.title}）`,
        viewHref: reqPath,
        category: "action",
        actionRequired: true,
        buildExternalMessage: async (_userId, target) => {
          const actionUrl = target.adapter.buildActionUrl(reqPath);
          return {
            text: `新需求待确认：${techReq.title}（${event.title}），查看：${actionUrl}`,
          };
        },
      }).catch(e => console.error("[tech-req] notify failed:", e));

      if (dept.chatId) {
        batchGetFeishuOpenIds(dept.pocUserIds).then(m => {
          const pocOpenIds = dept.pocUserIds.map(id => m.get(id)).filter((v): v is string => !!v);
          const url = feishuPlatform.buildActionUrl(reqPath);
          const card = buildAwaitingReqCard(techReq.title, event.title, dept.name, pocOpenIds, url);
          feishuPlatform.sendGroupMessage(dept.chatId!, {
            text: `新需求待确认：${techReq.title}（${event.title}）`,
            richContent: card,
          }).catch(e => console.error("[tech-req] group notify failed:", e));
        }).catch(e => console.error("[tech-req] group notify failed:", e));
      }
    }
  }

  return Response.json({ techReq }, { status: 201 });
}
