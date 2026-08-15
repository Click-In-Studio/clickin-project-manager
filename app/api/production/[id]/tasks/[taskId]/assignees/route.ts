import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, batchGetFeishuOpenIds } from "@/lib/db";
import { getTechReqByProduction, setTechReqAssignees } from "@/lib/event-db";
import { feishuPlatform } from "@/lib/platform/feishu";
import { canAssignTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/**
 * PUT — replace the assignee list for a task.
 * Body: { assignees: { userId: string; name: string }[] }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, taskId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getTechReqByProduction(taskId, productionId);
  if (!existing) return Response.json({ error: "任务不存在" }, { status: 404 });

  if (!await canAssignTechReq(permCtx, taskId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { assignees?: unknown };
  if (
    !Array.isArray(body.assignees) ||
    body.assignees.some(
      (x) =>
        typeof x !== "object" || x === null ||
        typeof (x as Record<string, unknown>).userId !== "string" ||
        typeof (x as Record<string, unknown>).name !== "string"
    )
  ) {
    return Response.json({ error: "assignees 必须是 { userId: string; name: string }[]" }, { status: 400 });
  }

  const prevAssignees = new Set(existing.assignees.map(a => a.userId));
  await setTechReqAssignees(taskId, body.assignees as { userId: string; name: string }[]);
  const updated = await getTechReqByProduction(taskId, productionId);

  if (updated?.chatId) {
    const newUserIds = (body.assignees as { userId: string }[])
      .map(a => a.userId)
      .filter(id => !prevAssignees.has(id));
    if (newUserIds.length) {
      batchGetFeishuOpenIds(newUserIds).then(m => {
        const openIds = newUserIds.map(uid => m.get(uid)).filter((v): v is string => !!v);
        if (openIds.length) feishuPlatform.addGroupMembers(updated.chatId!, openIds).catch(console.error);
      }).catch(console.error);
    }
  }

  return Response.json({ task: updated });
}
