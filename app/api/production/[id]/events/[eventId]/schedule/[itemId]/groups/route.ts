import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { getProductionEvent, getScheduleItem } from "@/lib/event-db";
import { canBindGroupToSchedule } from "@/lib/event-group-perm";
import { EventGroupError, listScheduleItemGroupIds, setScheduleItemGroups } from "@/lib/event-group-db";

type Ctx = { params: Promise<{ id: string; eventId: string; itemId: string }> };

/**
 * PUT — 全量覆盖某个流程项挂的用户组。
 *
 * 门恒为该 event 的内容编辑权，**与组的两型无关**：拿到项目级组的人不需要
 * user_group 键就能用它排自己的 rundown（用 ≠ 改）。
 *
 * 反向也成立且是有意的：组 POC 不因为自己的组被排进这个 rundown 就能改 rundown
 * ——本路由不查 isGroupPoc（用户定谳）。
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId, itemId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const event = await getProductionEvent(eventId, productionId);
  if (!event) return Response.json({ error: "事件不存在" }, { status: 404 });

  if (!await canBindGroupToSchedule(
    toActor(session, access.permCtx), productionId, { eventId: event.id, status: event.status },
  )) return Response.json({ error: "权限不足" }, { status: 403 });

  const item = await getScheduleItem(itemId, eventId);
  if (!item) return Response.json({ error: "流程项不存在" }, { status: 404 });

  const body = (await req.json()) as { groupIds?: unknown };
  if (!Array.isArray(body.groupIds) || body.groupIds.some(x => typeof x !== "string"))
    return Response.json({ error: "groupIds 必须是 string[]" }, { status: 400 });

  try {
    await setScheduleItemGroups(itemId, eventId, productionId, body.groupIds as string[]);
  } catch (e) {
    if (e instanceof EventGroupError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const map = await listScheduleItemGroupIds(eventId);
  return Response.json({ ok: true, groupIds: map.get(itemId) ?? [] });
}
