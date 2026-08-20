import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { createEventTechReq, getEventDepartment, getProductionEvent, listEventTechReqs } from "@/lib/event-db";
import { isSubjectPoc, parseTaskSubject, subjectColumns } from "@/lib/task-poc";
import { buildAwaitingReqCard } from "@/lib/platform/feishu/feishu-bot";
import { batchGetFeishuOpenIds } from "@/lib/db";
import { feishuPlatform } from "@/lib/platform/feishu";
import { SERVER_URL } from "@/lib/server-url";
import { notifyTaskAssigned, notifyUsers } from "@/lib/notify";

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

  // 单次解析：departmentId 校验、viaPoc 门、指派门、创建全部消费同一份值
  //（此前 clone 双重解析被 review 指为潜在分歧面）
  const body = (await req.json()) as {
    title?: string; description?: string; scheduleItemIds?: string[];
    presetMinutes?: number | null; departmentId?: string | null; groupId?: string | null;
    assignees?: { userId: string; name: string }[];
  };

  // 责任主体 = 部门 | 用户组，二选一；解析同时校验属于本 production
  const parsed = await parseTaskSubject(productionId, body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const subject = parsed.subject;

  // Creating a tech_req requires edit-level on the event
  // attach 语义：给 event 挂 task = event 子集合操作。
  // 路径三（用户场景：服装设计看到排练 schedule 主动来对装）：部门 POC 可为
  // **本部门**对可见 event 发起 task——可见性由成员基础 details@view 天然界定。
  // 路径三前提=对该 event 有 details 视图（"对看得见的东西反应"）：宽松剧组经
  // 成员模板通配行命中；严格剧组（模板撤掉 details@view）未被授视图的 POC 发不了
  const viaPoc = subject !== null
    && await isSubjectPoc(productionId, subject, session.userId)
    && await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "details", "view");
  if (!viaPoc
      && !await hasEffectiveGrant(toActor(session, permCtx), productionId, "event", eventId, "tasks", "create"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });

  // 创建即指派同受指派面约束（2026-08-15 定谳：event 编辑级联不含指派——
  // organizer 发部门、POC 分人）：task 通配 assignees@edit 或所绑部门 POC
  if ((body.assignees?.length ?? 0) > 0) {
    const canDirectAssign =
      await hasEffectiveGrant(toActor(session, permCtx), productionId, "task", "*", "assignees", "edit")
      || await isSubjectPoc(productionId, subject, session.userId);
    if (!canDirectAssign)
      return Response.json({ error: "你没有直接指派的权限——请绑定部门或用户组后交由其 POC 分配" }, { status: 403 });
  }

  const techReq = await createEventTechReq({
    id: uid(),
    productionId,
    eventId,
    scheduleItemIds: body.scheduleItemIds ?? [],
    title,
    description: body.description ?? "",
    presetMinutes: body.presetMinutes ?? null,
    ...subjectColumns(subject),
    assignees: body.assignees ?? [],
    createdBy: session.userId,
    createdVia: viaPoc ? "poc" : "explicit",
  });

  // 创建即指派 → 指派通知（老板派活语义：纯告知，act=打开详情）
  if (techReq.assignees.length > 0) {
    void notifyTaskAssigned({
      productionId,
      taskId: techReq.id,
      taskTitle: techReq.title,
      eventTitle: event.title,
      assignedBy: session.userId,
      userIds: techReq.assignees.map(a => a.userId),
    }).catch(e => console.error("[task-assign] notify failed:", e));
  }

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
