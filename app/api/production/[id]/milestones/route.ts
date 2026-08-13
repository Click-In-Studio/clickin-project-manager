import { type NextRequest } from "next/server";
import { hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, listMilestones, createMilestone } from "@/lib/db";
import { hasPermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `ms${Date.now().toString(36)}${(++_seq).toString(36)}`;

export async function GET(_req: NextRequest, ctx: Ctx) {
  const req = _req;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const milestones = await listMilestones(productionId);
  return Response.json({ milestones });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access || !(access.permCtx.isAdmin || await hasGrant(access.permCtx.userId, productionId, "milestone", "*", "*", "create"))) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  const { name, endDate, sortOrder } = await req.json() as {
    name?: string;
    endDate?: string;
    sortOrder?: number;
  };
  if (!name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return Response.json({ error: "endDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }

  const milestone = await createMilestone(
    uid(),
    productionId,
    name.trim(),
    endDate,
    sortOrder ?? 0,
  );
  return Response.json({ milestone }, { status: 201 });
}
