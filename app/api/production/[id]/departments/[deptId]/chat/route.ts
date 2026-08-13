/**
 * POST /api/production/[id]/departments/[deptId]/chat
 *
 * Creates a Feishu group chat for the department and binds it.
 * - Permission: dept:create
 * - Group owner: the operator
 * - Auto-members: operator + all dept members + POCs + 制作人/制作助理
 * - Group name: "productionName - deptName"
 */

import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext,
  getProductionName,
  getBossOpenIds,
  batchGetFeishuOpenIds,
  getFeishuOpenId,
} from "@/lib/db";
import { } from "@/lib/permissions";
import { getProductionDept, setDeptChatId } from "@/lib/dept-db";
import { feishuPlatform } from "@/lib/platform/feishu";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(
    session.userId,
    session.isAdmin,
    productionId,
  );
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!(permCtx.isAdmin || await hasGrant(permCtx.userId, productionId, "org_dept", "*", "*", "create")))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const [dept, productionName, bossIds] = await Promise.all([
    getProductionDept(deptId, productionId),
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
  if (!sessionOpenId)
    return Response.json({ error: "无法获取操作者飞书身份" }, { status: 502 });

  const memberIds = [
    ...new Set([
      sessionOpenId,
      ...allUserIds
        .map((id) => userIdToOpenId.get(id))
        .filter((v): v is string => !!v),
      ...bossIds,
    ]),
  ];

  const chatId = await feishuPlatform.createDeptGroup(chatName, memberIds, sessionOpenId);
  if (!chatId) return Response.json({ error: "飞书建群失败" }, { status: 502 });

  await setDeptChatId(deptId, chatId);
  return Response.json({ chatId });
}
