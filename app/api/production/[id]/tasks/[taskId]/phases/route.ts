import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getTechReqByProduction, setTaskPhases } from "@/lib/event-db";
import { canEditTechReq } from "@/lib/event-permissions";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/**
 * PUT — replace the phase bindings. Body: { phaseIds: string[] }
 * 不约束任务起止 ⊆ 阶段区间（用户规范，与原 milestone 边同款）；跨剧组 phase id 静默丢弃。
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

  const body = (await req.json()) as { phaseIds?: unknown };
  if (!Array.isArray(body.phaseIds) || body.phaseIds.some(x => typeof x !== "string"))
    return Response.json({ error: "phaseIds 必须是 string[]" }, { status: 400 });

  await setTaskPhases(taskId, productionId, body.phaseIds as string[]);
  const updated = await getTechReqByProduction(taskId, productionId);
  return Response.json({ task: updated });
}
