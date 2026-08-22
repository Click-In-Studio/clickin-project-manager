import { type NextRequest } from "next/server";
import { canAccessNode } from "@/lib/grant-template";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listProductionMembersWithRoles } from "@/lib/db";
import { listPhases } from "@/lib/phase-db";
import { listProductionEvents } from "@/lib/event-db";
import { listProductionDepts } from "@/lib/dept-db";
import { filterDraftVisibleEvents } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string }> };

// GET — 新建任务表单的选项集（面板模态框一次拉取）：
//   pocDepts   我是 POC 的部门（部门绑定仅限这些，目前的产品规则；树形 parentId）
//   members    可指派人员池（MemberPickerModal 形状）——
//              我持有 task 通配 assignees@edit ⇒ 全体成员；
//              否则 ⇒ 我 POC 部门的成员并集
//              （已绑定 event 且我是 organizer ⇒ 任何人：产品语义待定，暂未实现）
//   depts      人员 picker 的分组树（与 members 同口径裁剪）
//   phases     全部阶段
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

  const [depts, membersRaw, phases, allEvents, standaloneAccess, canAssignAnyone, canViewContact] = await Promise.all([
    listProductionDepts(productionId),
    listProductionMembersWithRoles(productionId),
    listPhases(productionId),
    listProductionEvents(productionId),
    canAccessNode(permCtx, productionId, "task", "*", "*", "create"),
    hasEffectiveGrant(actor, productionId, "task", "*", "assignees", "edit"),
    hasEffectiveGrant(actor, productionId, "member", "*", "contact", "view"),
  ]);

  const myPocDepts = depts.filter(d => d.pocUserIds.includes(session.userId));
  const pocDepts = myPocDepts.map(d => ({ id: d.id, name: d.name, parentId: d.parentId }));

  // 人员池：assignees@edit 通配 ⇒ 全员；否则 ⇒ 我 POC 部门的成员并集
  const poolIds = canAssignAnyone
    ? null  // 不裁剪
    : new Set(myPocDepts.flatMap(d => [...d.memberUserIds, ...d.pocUserIds]));
  const members = membersRaw
    .filter(m => poolIds === null || poolIds.has(m.userId))
    .map(m => ({
      userId: m.userId,
      name: m.name,
      avatarUrl: m.avatarUrl,
      photoUrl: m.photoUrl,
      roles: m.roles,
      tags: m.tags,
      email: canViewContact ? m.email : null,
      phone: canViewContact ? m.phone : null,
      status: m.status,
    }));
  const pickerDepts = (canAssignAnyone ? depts : myPocDepts).map(d => ({
    id: d.id,
    name: d.name,
    parentId: d.parentId,
    kind: d.kind,
    memberUserIds: [...new Set([...d.memberUserIds, ...d.pocUserIds])],
  }));

  // 可挂载事件：draft 可见性同门过滤后，逐一验 attach 资格
  const visibleEvents = await filterDraftVisibleEvents(permCtx, productionId, allEvents);
  const hasPocDept = myPocDepts.length > 0;
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
    members,
    depts: pickerDepts,
    canAssignAnyone,
    phases: phases.map(p => ({ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, deptName: p.deptName })),
    events,
    canCreateStandalone: standaloneAccess.allowed,
  });
}
