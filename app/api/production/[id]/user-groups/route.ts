import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { hasEventDomainView } from "@/lib/event-permissions";
import { getProductionEvent } from "@/lib/event-db";
import { canCreateEventGroup } from "@/lib/event-group-perm";
import {
  createEventGroup, EventGroupError, listEventGroups,
  type EventGroupMember, type EventGroupPoc,
} from "@/lib/event-group-db";

type Ctx = { params: Promise<{ id: string }> };

/** 请求体里的成员 / POC 形状校验——两者的 wire 形状一致，共用一个解析器。 */
function parseMember(v: unknown): EventGroupMember | null {
  if (typeof v !== "object" || v === null) return null;
  const { kind, id } = v as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (kind !== "dept" && kind !== "user") return null;
  return { kind, id };
}

function parseMembers(v: unknown): EventGroupMember[] | null {
  if (!Array.isArray(v)) return null;
  const out: EventGroupMember[] = [];
  for (const item of v) {
    const m = parseMember(item);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

function parsePoc(v: unknown): { ok: true; poc: EventGroupPoc } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, poc: null };
  const m = parseMember(v);
  return m ? { ok: true, poc: m } : { ok: false };
}

/**
 * GET — 列出可用的用户组。
 *
 * `?eventId=` 给定时返回「该 event 的 A 型组 + 全部 B 型组」，即排这个 event 的
 * rundown 时可选的全集；不给则只返回 B 型组。
 *
 * 读门是 event 域视图——组是排 rundown 用的，看得见事件域就看得见编制。组本身不
 * 携带内容，成员名单在通讯录里本来就可见。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await hasEventDomainView(toActor(session, access.permCtx), productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const eventId = req.nextUrl.searchParams.get("eventId");
  if (eventId && !await getProductionEvent(eventId, productionId))
    return Response.json({ error: "事件不存在" }, { status: 404 });

  return Response.json({ groups: await listEventGroups(productionId, eventId) });
}

/**
 * POST — 建组。
 *
 * body.eventId 决定型别与门：
 *   非空 → A 型，门 = 该 event 的 hasEventContentEdit
 *   为空 → B 型，门 = node:user_group/*@create
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json()) as {
    eventId?: unknown; name?: unknown; color?: unknown;
    orderIndex?: unknown; members?: unknown; poc?: unknown;
  };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "组名不能为空" }, { status: 400 });

  const eventId = typeof body.eventId === "string" && body.eventId ? body.eventId : null;
  const event = eventId ? await getProductionEvent(eventId, productionId) : null;
  if (eventId && !event) return Response.json({ error: "事件不存在" }, { status: 404 });

  const members = parseMembers(body.members ?? []);
  if (!members) return Response.json({ error: "members 必须是 { kind: 'dept'|'user'; id: string }[]" }, { status: 400 });
  const poc = parsePoc(body.poc);
  if (!poc.ok) return Response.json({ error: "poc 必须是 { kind: 'dept'|'user'; id: string } 或 null" }, { status: 400 });

  const gate = event ? { eventId: event.id, status: event.status } : null;
  if (!await canCreateEventGroup(toActor(session, access.permCtx), productionId, gate))
    return Response.json({ error: "权限不足" }, { status: 403 });

  try {
    const group = await createEventGroup({
      productionId,
      eventId,
      name,
      color: typeof body.color === "string" ? body.color : null,
      orderIndex: typeof body.orderIndex === "number" ? body.orderIndex : 0,
      members,
      poc: poc.poc,
      createdBy: session.userId,
    });
    return Response.json({ group }, { status: 201 });
  } catch (e) {
    if (e instanceof EventGroupError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("event_group_name_unique_idx"))
      return Response.json({ error: "同名的组已存在" }, { status: 409 });
    throw e;
  }
}
