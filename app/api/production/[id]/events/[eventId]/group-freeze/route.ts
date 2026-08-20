import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { toActor } from "@/lib/grant-check";
import { canEnterEvent, hasEventContentEdit } from "@/lib/event-permissions";
import { getProductionEvent } from "@/lib/event-db";
import { describeFrozenGroups, freezeEventGroups, unfreezeEventGroups } from "@/lib/event-group-freeze";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

/**
 * GET — 关系视图的数据源。
 *
 * 回的是「冻结时的完整关系 + 每个节点的当前有效性」：POC 张三是否还在项目里、
 * 当时那个部门是否还在、它现在的 POC 是谁。**只给陈述，不给结论**——找谁善后是
 * PSM 的判断，尤其项目复杂或牵扯多个部门时机器做不出这个决定。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (!await getProductionEvent(eventId, productionId))
    return Response.json({ error: "事件不存在" }, { status: 404 });
  if (!await canEnterEvent(toActor(session, access.permCtx), productionId, eventId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const groups = await describeFrozenGroups(eventId);
  return Response.json({ frozen: groups.length > 0, groups });
}

/**
 * POST — 手动冻结（deadline 之前就想锁名单时用）。
 * DELETE — 解冻。organizer 一看「我还要 extend 活动」就能解开；解开后再冻会插新一版，
 *          旧版留着当审计记录（refreeze 追加不覆盖）。
 *
 * 两者同门 hasEventContentEdit——锁定名单本身就是 organizer 的决定。
 * completed 状态下它解析成 details@edit，通得过。
 */
async function gate(req: NextRequest, productionId: string, eventId: string) {
  const session = getSession(req.cookies);
  if (!session) return { error: Response.json({ error: "未登录" }, { status: 401 }) };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { error: Response.json({ error: "无权访问" }, { status: 403 }) };
  // 冻结/解冻是内容写入，与 rundown / 组绑定同类——归档项目一律不可改
  if (access.isArchived)
    return { error: Response.json({ error: "已归档的项目不可修改" }, { status: 403 }) };
  const event = await getProductionEvent(eventId, productionId);
  if (!event) return { error: Response.json({ error: "事件不存在" }, { status: 404 }) };
  if (!await hasEventContentEdit(toActor(session, access.permCtx), productionId, eventId, event.status))
    return { error: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const g = await gate(req, productionId, eventId);
  if (g.error) return g.error;
  return Response.json(await freezeEventGroups(eventId, g.session!.userId));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, eventId } = await ctx.params;
  const g = await gate(req, productionId, eventId);
  if (g.error) return g.error;
  return Response.json(await unfreezeEventGroups(eventId));
}
