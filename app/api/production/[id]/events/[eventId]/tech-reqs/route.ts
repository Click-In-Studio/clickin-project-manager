import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getProductionEvent, listEventTechReqs, createEventTechReq, getEventDepartment } from "@/lib/event-db";
import { loadEventPermContext, canEditTechReq } from "@/lib/event-permissions";
import { buildAwaitingReqCard } from "@/lib/feishu-bot";
import { batchGetFeishuOpenIds } from "@/lib/db";
import { feishuPlatform } from "@/lib/platform/feishu";
import { BASE_PATH } from "@/lib/base-path";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

let _seq = 0;
const uid = () => `tr${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (!hasPermission("event:follow", session.isAdmin, memberRoles, overrides))
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
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const body = (await req.json()) as {
    title?: string; description?: string; scheduleItemIds?: string[];
    presetMinutes?: number | null; departmentId?: string | null;
    assignees?: { userId: string; name: string }[];
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "标题不能为空" }, { status: 400 });

  // Allow if role-based edit OR POC of the target department
  const permCtx = await loadEventPermContext(session.userId, eventId);
  if (!canEditTechReq(session.isAdmin, memberRoles, overrides, permCtx, body.departmentId ?? null))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const techReq = await createEventTechReq({
    id: uid(),
    eventId,
    scheduleItemIds: body.scheduleItemIds ?? [],
    title,
    description: body.description ?? "",
    presetMinutes: body.presetMinutes ?? null,
    departmentId: body.departmentId ?? null,
    assignees: body.assignees ?? [],
  });

  // Notify dept group chat when a new awaiting req is created
  if (techReq.status === "awaiting" && techReq.departmentId) {
    const dept = await getEventDepartment(techReq.departmentId, productionId);
    if (dept?.chatId && dept.pocUserIds.length) {
      const reqPath = `${BASE_PATH}/production/${productionId}/events/${eventId}/reqs/${techReq.id}`;
      // Feishu open_ids still needed for @mention syntax inside the card body
      batchGetFeishuOpenIds(dept.pocUserIds).then(m => {
        const pocOpenIds = dept.pocUserIds.map(uid => m.get(uid)).filter((v): v is string => !!v);
        const url = feishuPlatform.buildActionUrl(reqPath);
        const card = buildAwaitingReqCard(techReq.title, event.title, dept.name, pocOpenIds, url);
        feishuPlatform.sendGroupMessage(dept.chatId!, {
          text: `新需求待确认：${techReq.title}（${event.title}）`,
          richContent: card,
        }).catch(e => console.error("[tech-req] notify failed:", e));
      }).catch(e => console.error("[tech-req] notify failed:", e));
    }
  }

  return Response.json({ techReq }, { status: 201 });
}
