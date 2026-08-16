import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getTaskDependencies, getTechReqByProduction, setTaskBlockedBy } from "@/lib/event-db";
import { canEditTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/**
 * PUT — replace "谁挡住我"的任务集合（GitHub blocked-by 编辑面）。
 * Body: { taskIds: string[] }。成环 / 跨剧组 / 不存在 → 400。
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

  if (!await canEditTechReq(permCtx, taskId, existing.eventId, productionId))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as { taskIds?: unknown };
  if (!Array.isArray(body.taskIds) || body.taskIds.some(x => typeof x !== "string"))
    return Response.json({ error: "taskIds 必须是 string[]" }, { status: 400 });

  try {
    await setTaskBlockedBy(taskId, productionId, body.taskIds as string[], session.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "更新失败";
    if (msg.includes("成环") || msg.includes("不存在或跨剧组"))
      return Response.json({ error: msg }, { status: 400 });
    throw err;
  }

  const dependencies = await getTaskDependencies(taskId);
  return Response.json({ task: existing, ...dependencies });
}
