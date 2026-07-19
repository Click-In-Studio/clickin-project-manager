import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getBossUserIds, batchGetFeishuOpenIds } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getEventDepartment, setDepartmentMembers,
  getDepartmentCurrentEntries, getDeptReqsWithChat,
} from "@/lib/event-db";
import { addChatMembers, removeChatMember } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(
    session.userId, session.isAdmin, productionId
  );
  if (!hasPermission("dept:manage", session.isAdmin, memberRoles, overrides))
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived };
  return { session, deny: null, isArchived };
}

/**
 * PUT — replace the full member/POC list for a department.
 * Body: { members: { userId: string; isMember: boolean; isPoc: boolean }[] }
 * POC and membership are independent — a person can be POC without being a member.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const dept = await getEventDepartment(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });

  const body = (await req.json()) as { members?: unknown };
  if (
    !Array.isArray(body.members) ||
    body.members.some(
      (x) => typeof x !== "object" || x === null ||
              typeof (x as Record<string, unknown>).userId !== "string" ||
              typeof (x as Record<string, unknown>).isMember !== "boolean" ||
              typeof (x as Record<string, unknown>).isPoc !== "boolean"
    )
  ) {
    return Response.json({ error: "members 必须是 { userId: string; isMember: boolean; isPoc: boolean }[]" }, { status: 400 });
  }

  const members = (body.members as { userId: string; isMember: boolean; isPoc: boolean }[]);

  // Snapshot before save — needed for diff-based Feishu sync
  const [before, bossUserIds] = await Promise.all([
    getDepartmentCurrentEntries(deptId),
    getBossUserIds(productionId),
  ]);

  await setDepartmentMembers(deptId, members);

  const updated = await getEventDepartment(deptId, productionId);

  // ── Feishu dept group sync ───────────────────────────────────────────────────
  if (updated?.chatId) {
    const chatId = updated.chatId;
    const bossSet = new Set(bossUserIds);

    const beforeActive = new Set(before.filter(m => m.isMember || m.isPoc).map(m => m.userId));
    const afterActive  = new Set(members.filter(m => m.isMember || m.isPoc).map(m => m.userId));
    const beforePocs   = new Set(before.filter(m => m.isPoc).map(m => m.userId));
    const afterPocs    = new Set(members.filter(m => m.isPoc).map(m => m.userId));

    const toAddUserIds    = [...afterActive].filter(id => !beforeActive.has(id));
    const toRemoveUserIds = [...beforeActive].filter(id => !afterActive.has(id) && !bossSet.has(id));
    const newPocUserIds   = [...afterPocs].filter(id => !beforePocs.has(id));

    const allUserIds = [...new Set([...toAddUserIds, ...toRemoveUserIds, ...newPocUserIds])];
    const openIdMap = allUserIds.length ? await batchGetFeishuOpenIds(allUserIds) : new Map<string, string>();

    const toAddOpenIds    = toAddUserIds.map(id => openIdMap.get(id)).filter((id): id is string => !!id);
    const toRemoveOpenIds = toRemoveUserIds.map(id => openIdMap.get(id)).filter((id): id is string => !!id);
    const newPocOpenIds   = newPocUserIds.map(id => openIdMap.get(id)).filter((id): id is string => !!id);

    if (toAddOpenIds.length) await addChatMembers(chatId, toAddOpenIds);
    await Promise.all(toRemoveOpenIds.map(id => removeChatMember(chatId, id)));

    if (newPocOpenIds.length) {
      const reqsWithChat = await getDeptReqsWithChat(deptId);
      await Promise.all(reqsWithChat.map(r => addChatMembers(r.chatId, newPocOpenIds)));
    }
  } else if (updated) {
    // No dept chat — still handle POC→req chat sync
    const beforePocs = new Set(before.filter(m => m.isPoc).map(m => m.userId));
    const afterPocs  = new Set(members.filter(m => m.isPoc).map(m => m.userId));
    const newPocUserIds = [...afterPocs].filter(id => !beforePocs.has(id));
    if (newPocUserIds.length) {
      const openIdMap = await batchGetFeishuOpenIds(newPocUserIds);
      const newPocOpenIds = newPocUserIds.map(id => openIdMap.get(id)).filter((id): id is string => !!id);
      if (newPocOpenIds.length) {
        const reqsWithChat = await getDeptReqsWithChat(deptId);
        await Promise.all(reqsWithChat.map(r => addChatMembers(r.chatId, newPocOpenIds)));
      }
    }
  }

  return Response.json({ department: updated });
}
