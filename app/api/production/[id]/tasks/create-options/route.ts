import { type NextRequest } from "next/server";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembersWithRoles, listMilestones } from "@/lib/db";
import { listEventDepartments, listProductionEvents } from "@/lib/event-db";
import { filterDraftVisibleEvents } from "@/lib/event-permissions";
import { getPool } from "@/lib/pg";

type Ctx = { params: Promise<{ id: string }> };

// GET — 新建任务表单的选项集（面板模态框一次拉取）：
//   pocDepts   我是 POC 的部门（部门绑定仅限这些，目前的产品规则）
//   people     可指派人员池 = 我 POC 部门的成员 ∪ 持有 task 通配 assignees@edit 行的成员
//   milestones 全部里程碑
//   events     可挂载事件（服务端过滤：event tasks@create，或 POC 路径=
//              我有 POC 部门且对该 event 有 details@view——后者标 requiresPocDept）
//   canCreateStandalone 无绑定创建资格（node:task/*@create）
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  const actor = toActor(session, permCtx);

  const [depts, members, milestones, allEvents, standaloneAccess] = await Promise.all([
    listEventDepartments(productionId),
    listProductionMembersWithRoles(productionId),
    listMilestones(productionId),
    listProductionEvents(productionId),
    canAccessNode(permCtx, productionId, "task", "*", "*", "create"),
  ]);

  const pocDepts = depts
    .filter(d => d.pocUserIds.includes(session.userId))
    .map(d => ({ id: d.id, name: d.name }));

  // 人员池：我 POC 部门的成员 ∪ 持有 task/*/assignees@edit 行的成员
  const nameOf = new Map(members.map(m => [m.userId, m.name]));
  const pool = new Map<string, string>();
  for (const d of depts) {
    if (!d.pocUserIds.includes(session.userId)) continue;
    for (const uid of [...d.memberUserIds, ...d.pocUserIds]) {
      if (nameOf.has(uid)) pool.set(uid, nameOf.get(uid)!);
    }
  }
  const holders = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT g.user_id FROM production_member_grant g
     WHERE g.production_id = $1 AND g.resource_type = 'task' AND g.resource_id = '*'
       AND g.resource_sub IN ('assignees', '*') AND g.permission_level IN ('edit', '*')
       AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())`,
    [productionId],
  );
  for (const { user_id } of holders.rows) {
    if (nameOf.has(user_id)) pool.set(user_id, nameOf.get(user_id)!);
  }

  // 可挂载事件：draft 可见性同门过滤后，逐一验 attach 资格
  const visibleEvents = await filterDraftVisibleEvents(permCtx, productionId, allEvents);
  const hasPocDept = pocDepts.length > 0;
  const flags = await Promise.all(visibleEvents.map(async ev => {
    const canAttach = await hasEffectiveGrant(actor, productionId, "event", ev.id, "tasks", "create");
    const pocPath = !canAttach && hasPocDept
      && await hasEffectiveGrant(actor, productionId, "event", ev.id, "details", "view");
    return { ev, canAttach, pocPath };
  }));
  const events = flags
    .filter(f => f.canAttach || f.pocPath)
    .map(f => ({
      id: f.ev.id,
      title: f.ev.title,
      startTime: f.ev.startTime,
      /** 仅 POC 路径可挂载：必须同时选择本人 POC 的部门 */
      requiresPocDept: !f.canAttach,
    }));

  return Response.json({
    pocDepts,
    people: [...pool.entries()].map(([userId, name]) => ({ userId, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    milestones: milestones.map(m => ({ id: m.id, name: m.name, endDate: m.endDate })),
    events,
    canCreateStandalone: standaloneAccess.allowed,
  });
}
