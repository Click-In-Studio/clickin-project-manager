import { type NextRequest } from "next/server";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getPhase, updatePhase, deletePhase } from "@/lib/phase-db";
import { canManagePhaseScope } from "@/lib/phase-perm";

type Ctx = { params: Promise<{ id: string; phaseId: string }> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, phaseId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getPhase(phaseId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "阶段不存在" }, { status: 404 });
  }
  if (!await canManagePhaseScope(toActor(session, permCtx), permCtx.pocDeptIds, productionId, existing.deptId, "edit")) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const body = await req.json() as {
    name?: string;
    startDate?: string;
    endDate?: string | null;
    sortOrder?: number;
    milestoneIds?: string[];
  };
  if (body.name !== undefined && !body.name.trim()) {
    return Response.json({ error: "名称不能为空" }, { status: 400 });
  }
  if (body.startDate !== undefined && !DATE_RE.test(body.startDate)) {
    return Response.json({ error: "startDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }
  if (body.endDate !== undefined && body.endDate !== null && !DATE_RE.test(body.endDate)) {
    return Response.json({ error: "endDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }
  // 头尾次序校验取「改后终值」（DB CHECK 兜底，这里给出人话错误）
  const nextStart = body.startDate ?? existing.startDate;
  const nextEnd = body.endDate === undefined ? existing.endDate : body.endDate;
  if (nextEnd !== null && nextEnd < nextStart) {
    return Response.json({ error: "结束日期不能早于开始日期" }, { status: 400 });
  }

  // 字段与 milestone 边同事务（phase-db 内 BEGIN/COMMIT）
  await updatePhase(phaseId, productionId, {
    name: body.name?.trim(),
    startDate: body.startDate,
    endDate: body.endDate,
    sortOrder: body.sortOrder,
    milestoneIds: Array.isArray(body.milestoneIds)
      ? body.milestoneIds.filter(x => typeof x === "string")
      : undefined,
  });
  return Response.json({ phase: await getPhase(phaseId) });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, phaseId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getPhase(phaseId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "阶段不存在" }, { status: 404 });
  }
  if (!await canManagePhaseScope(toActor(session, permCtx), permCtx.pocDeptIds, productionId, existing.deptId, "delete")) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  await deletePhase(phaseId);
  return Response.json({ ok: true });
}
