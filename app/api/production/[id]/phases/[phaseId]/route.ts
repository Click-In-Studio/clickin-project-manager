import { type NextRequest } from "next/server";
import { toActor, hasEffectiveGrant, type GrantActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import type { PermissionContext } from "@/lib/permissions";
import { getPhase, updatePhase, deletePhase, setPhaseMilestones, type Phase } from "@/lib/phase-db";
import { isPolicyOn } from "@/lib/policy-db";

type Ctx = { params: Promise<{ id: string; phaseId: string }> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 写门：phase/*@<verb>（owner 旁路内建）∨ 部门 POC 管自己部门的 phase
 * （与创建同一枚 policy 开关——能建不能改是残缺 UX，故 create/edit/delete 对称）。
 */
async function canManagePhase(
  actor: GrantActor, permCtx: PermissionContext, productionId: string, phase: Phase,
  verb: "edit" | "delete",
): Promise<boolean> {
  if (await hasEffectiveGrant(actor, productionId, "phase", "*", "*", verb)) return true;
  return phase.deptId !== null
    && permCtx.pocDeptIds.includes(phase.deptId)
    && await isPolicyOn(productionId, "policy.phase_dept_poc_create");
}

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
  if (!await canManagePhase(toActor(session, permCtx), permCtx, productionId, existing, "edit")) {
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

  await updatePhase(phaseId, {
    name: body.name?.trim(),
    startDate: body.startDate,
    endDate: body.endDate,
    sortOrder: body.sortOrder,
  });
  if (Array.isArray(body.milestoneIds)) {
    await setPhaseMilestones(phaseId, productionId, body.milestoneIds.filter(x => typeof x === "string"));
  }
  return Response.json({ phase: await getPhase(phaseId) });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const req = _req;
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
  if (!await canManagePhase(toActor(session, permCtx), permCtx, productionId, existing, "delete")) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  await deletePhase(phaseId);
  return Response.json({ ok: true });
}
