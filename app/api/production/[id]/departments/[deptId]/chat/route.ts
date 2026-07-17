/**
 * POST /api/production/[id]/departments/[deptId]/chat
 *
 * Creates a Feishu group chat for the department and binds it.
 * - Permission: dept:manage
 * - Group owner: the operator
 * - Auto-members: operator + all dept members (members + POCs) + 制作人/制作助理
 * - Group name: "productionName - deptName"
 */

import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getProductionName, getBossOpenIds, batchGetFeishuOpenIds, getFeishuOpenId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getEventDepartment, setDepartmentChatId,
} from "@/lib/event-db";
import { createChat } from "@/lib/feishu-chat";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("dept:manage", session.isAdmin, memberRoles, overrides))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [dept, productionName, bossIds] = await Promise.all([
    getEventDepartment(deptId, productionId),
    getProductionName(productionId),
    getBossOpenIds(productionId),
  ]);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  if (dept.chatId) return Response.json({ error: "部门群已存在" }, { status: 409 });

  const chatName = `${productionName ?? "项目"} - ${dept.name}`;
  const allUserIds = [...new Set([...dept.memberUserIds, ...dept.pocUserIds])];
  const [userIdToOpenId, sessionOpenId] = await Promise.all([
    batchGetFeishuOpenIds(allUserIds),
    getFeishuOpenId(session.userId),
  ]);
  if (!sessionOpenId) return Response.json({ error: "无法获取操作者飞书身份" }, { status: 502 });
  const memberIds = [
    ...new Set([
      sessionOpenId,
      ...allUserIds.map(id => userIdToOpenId.get(id)).filter((v): v is string => !!v),
      ...bossIds,
    ]),
  ];

  const chatId = await createChat(chatName, sessionOpenId, memberIds, "only_owner_and_administrator");
  if (!chatId) return Response.json({ error: "飞书建群失败" }, { status: 502 });

  await setDepartmentChatId(deptId, chatId);
  return Response.json({ chatId });
}
