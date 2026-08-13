import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getMilestone, updateMilestone, deleteMilestone } from "@/lib/db";
import { } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string; milestoneId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, milestoneId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "milestone", "*", "*", "edit"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const existing = await getMilestone(milestoneId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "里程碑不存在" }, { status: 404 });
  }

  const { name, endDate, sortOrder } = await req.json() as {
    name?: string;
    endDate?: string;
    sortOrder?: number;
  };
  if (endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return Response.json({ error: "endDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }

  await updateMilestone(milestoneId, {
    name: name?.trim(),
    endDate,
    sortOrder,
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const req = _req;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId, milestoneId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "milestone", "*", "*", "delete"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const existing = await getMilestone(milestoneId);
  if (!existing || existing.productionId !== productionId) {
    return Response.json({ error: "里程碑不存在" }, { status: 404 });
  }

  await deleteMilestone(milestoneId);
  return Response.json({ ok: true });
}
