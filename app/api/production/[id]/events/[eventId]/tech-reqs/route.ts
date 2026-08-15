import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { createEventTechReq, getEventDepartment, getProductionEvent, isUserDeptPoc, listEventTechReqs } from "@/lib/event-db";
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
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
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
  // attach 语义：给 event 挂 task = event 子集合操作。
  // 路径三（用户场景：服装设计看到排练 schedule 主动来对装）：部门 POC 可为
  // **本部门**对可见 event 发起 task——可见性由成员基础 details@view 天然界定
  const bodyPeek = (await req.clone().json()) as { departmentId?: string | null };
  // 路径三前提=对该 event 有 details 视图（"对看得见的东西反应"）：宽松剧组经
  // 成员模板通配行命中；严格剧组（模板撤掉 details@view）未被授视图的 POC 发不了
  const viaPoc = typeof bodyPeek.departmentId === "string"
    && await isUserDeptPoc(bodyPeek.departmentId, session.userId)
    && await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "details", "view");
  if (!viaPoc
      && !await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "tasks", "create"))
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
    productionId,
    eventId,
    scheduleItemIds: body.scheduleItemIds ?? [],
    title,
    description: body.description ?? "",
    presetMinutes: body.presetMinutes ?? null,
    departmentId: body.departmentId ?? null,
    assignees: body.assignees ?? [],
    createdBy: session.userId,
    createdVia: viaPoc ? "poc" : "explicit",
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
