import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { hasEventDomainView } from "@/lib/event-permissions";
import { getProductionEvent } from "@/lib/event-db";
import { canDeleteEventGroup, canEditEventGroup, canSetEventGroupPoc, type EventGate } from "@/lib/event-group-perm";
import {
  deleteEventGroup, EventGroupError, getEventGroup, updateEventGroup,
  type EventGroup, type EventGroupMember, type EventGroupPoc,
} from "@/lib/event-group-db";

type Ctx = { params: Promise<{ id: string; groupId: string }> };

function parseMember(v: unknown): EventGroupMember | null {
  if (typeof v !== "object" || v === null) return null;
  const { kind, id } = v as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (kind !== "dept" && kind !== "user") return null;
  return { kind, id };
}

/** A 型组的门要拿它自己所属 event 的状态；B 型组无 event。 */
async function gateOf(group: EventGroup, productionId: string): Promise<EventGate | null> {
  if (group.eventId === null) return null;
  const event = await getProductionEvent(group.eventId, productionId);
  return event ? { eventId: event.id, status: event.status } : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, groupId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEventDomainView(toActor(session, access.permCtx), productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const group = await getEventGroup(groupId, productionId);
  if (!group) return Response.json({ error: "用户组不存在" }, { status: 404 });
  return Response.json({ group });
}

/**
 * PATCH — 改名称 / 地点 / 颜色 / 排序 / 成员 / POC。
 *
 * POC 与其余字段的门**不同**：B 型组的 POC 跨 event 生效，独立一枚 `poc@edit`。
 * 同一次请求里既改成员又改 POC 时，两道门都要过。
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, groupId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const group = await getEventGroup(groupId, productionId);
  if (!group) return Response.json({ error: "用户组不存在" }, { status: 404 });

  const body = (await req.json()) as {
    name?: unknown; location?: unknown; color?: unknown;
    orderIndex?: unknown; members?: unknown; poc?: unknown;
  };

  let members: EventGroupMember[] | undefined;
  if (body.members !== undefined) {
    if (!Array.isArray(body.members))
      return Response.json({ error: "members 必须是数组" }, { status: 400 });
    members = [];
    for (const item of body.members) {
      const m = parseMember(item);
      if (!m) return Response.json({ error: "members 项必须是 { kind: 'dept'|'user'; id: string }" }, { status: 400 });
      members.push(m);
    }
  }

  let poc: EventGroupPoc | undefined;
  if (body.poc !== undefined) {
    if (body.poc === null) poc = null;
    else {
      const m = parseMember(body.poc);
      if (!m) return Response.json({ error: "poc 必须是 { kind: 'dept'|'user'; id: string } 或 null" }, { status: 400 });
      poc = m;
    }
  }

  const actor = toActor(session, access.permCtx);
  const gate = await gateOf(group, productionId);

  const changesBeyondPoc =
    body.name !== undefined || body.location !== undefined
    || body.color !== undefined || body.orderIndex !== undefined || members !== undefined;
  if (changesBeyondPoc && !await canEditEventGroup(actor, productionId, group, gate))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (poc !== undefined && !await canSetEventGroupPoc(actor, productionId, group, gate))
    return Response.json({ error: "没有设置该组 POC 的权限" }, { status: 403 });

  try {
    const updated = await updateEventGroup(groupId, productionId, {
      name: typeof body.name === "string" ? body.name : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      color: body.color === null || typeof body.color === "string" ? body.color as string | null : undefined,
      orderIndex: typeof body.orderIndex === "number" ? body.orderIndex : undefined,
      members,
      poc,
    });
    return Response.json({ group: updated });
  } catch (e) {
    if (e instanceof EventGroupError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("event_group_name_unique_idx"))
      return Response.json({ error: "同名的组已存在" }, { status: 409 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, groupId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const group = await getEventGroup(groupId, productionId);
  if (!group) return Response.json({ error: "用户组不存在" }, { status: 404 });

  const gate = await gateOf(group, productionId);
  if (!await canDeleteEventGroup(toActor(session, access.permCtx), productionId, group, gate))
    return Response.json({ error: "权限不足" }, { status: 403 });

  try {
    await deleteEventGroup(groupId, productionId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof EventGroupError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
