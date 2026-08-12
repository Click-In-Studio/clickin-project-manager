import { type NextRequest } from "next/server";
import { hasAnyEffectiveGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getBossUserIds, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";
import { getProductionDept, getDeptMembers, setDeptMembers } from "@/lib/dept-db";
import { feishuPlatform } from "@/lib/platform/feishu";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId
  );
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx, isArchived } = access;
  if (!hasPermission("dept:add_member", permCtx) && !hasPermission("dept:create", permCtx))
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived };
  return { session, deny: null, isArchived };
}

/**
 * GET — list members of a department.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasAnyEffectiveGrant({ userId: session.userId, isAdmin: permCtx.isAdmin, isOwner: permCtx.isOwner }, productionId, "event", ["meta", "details"], "view")))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const dept = await getProductionDept(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  const members = await getDeptMembers(deptId);
  return Response.json({ members });
}

/**
 * PUT — replace the full member list for a department.
 * Body: { members: { userId: string; isPoc: boolean; pocExtraPermissions?: string[]; pocBlockedPermissions?: string[] }[] }
 *
 * Presence in the array means "is in the dept"; absence means "remove from dept".
 * This follows production_dept_member semantics (no is_member flag).
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const dept = await getProductionDept(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });

  const body = (await req.json()) as { members?: unknown };
  if (
    !Array.isArray(body.members) ||
    body.members.some(
      (x) =>
        typeof x !== "object" ||
        x === null ||
        typeof (x as Record<string, unknown>).userId !== "string" ||
        typeof (x as Record<string, unknown>).isPoc !== "boolean",
    )
  ) {
    return Response.json(
      { error: "members 必须是 { userId: string; isPoc: boolean }[]" },
      { status: 400 },
    );
  }

  const members = (
    body.members as {
      userId: string;
      isPoc: boolean;
      pocExtraPermissions?: string[];
      pocBlockedPermissions?: string[];
    }[]
  );

  // Snapshot before save — needed for Feishu sync diff
  const [before, bossUserIds] = await Promise.all([
    getDeptMembers(deptId),
    getBossUserIds(productionId),
  ]);

  const { pocConflictsResolved } = await setDeptMembers(deptId, productionId, members);

  const updated = await getProductionDept(deptId, productionId);

  // ── Feishu dept group sync ───────────────────────────────────────────────────
  if (dept.chatId) {
    const chatId = dept.chatId;
    const bossSet = new Set(bossUserIds);

    const beforeMemberSet = new Set(before.map((m) => m.userId));
    const afterMemberSet = new Set(members.map((m) => m.userId));
    const beforePocSet = new Set(before.filter((m) => m.isPoc).map((m) => m.userId));
    const afterPocSet = new Set(members.filter((m) => m.isPoc).map((m) => m.userId));

    const toAddUserIds = [...afterMemberSet].filter((id) => !beforeMemberSet.has(id));
    const toRemoveUserIds = [...beforeMemberSet].filter(
      (id) => !afterMemberSet.has(id) && !bossSet.has(id),
    );
    const newPocUserIds = [...afterPocSet].filter((id) => !beforePocSet.has(id));

    const allUserIds = [...new Set([...toAddUserIds, ...toRemoveUserIds, ...newPocUserIds])];
    const openIdMap = allUserIds.length
      ? await batchGetFeishuOpenIds(allUserIds)
      : new Map<string, string>();

    const toAddOpenIds = toAddUserIds
      .map((id) => openIdMap.get(id))
      .filter((id): id is string => !!id);
    const toRemoveOpenIds = toRemoveUserIds
      .map((id) => openIdMap.get(id))
      .filter((id): id is string => !!id);

    if (toAddOpenIds.length) await feishuPlatform.addGroupMembers(chatId, toAddOpenIds);
    await Promise.all(toRemoveOpenIds.map((id) => feishuPlatform.removeGroupMember(chatId, id)));
  }

  return Response.json({ department: updated, pocConflictsResolved });
}
