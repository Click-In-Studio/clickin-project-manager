import { type NextRequest } from "next/server";
import { toActor } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { listPhases, createPhase } from "@/lib/phase-db";
import { canManagePhaseScope } from "@/lib/phase-perm";

type Ctx = { params: Promise<{ id: string }> };

let _seq = 0;
const uid = () => `ph${Date.now().toString(36)}${(++_seq).toString(36)}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 先验格式再进 SQL：裸 $1::uuid 遇畸形输入会让 PG 抛错变 500，而这里该回 400
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** deptId 合法性：属于本 production 且 kind='dept'（用户组不该有阶段）。 */
async function isDeptOfProduction(deptId: string, productionId: string): Promise<boolean> {
  if (!UUID_RE.test(deptId)) return false;
  const res = await getPool().query(
    "SELECT 1 FROM production_dept WHERE id = $1::uuid AND production_id = $2 AND kind = 'dept'",
    [deptId, productionId],
  );
  return res.rows.length > 0;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  // 可见性全员：成员即可读，无 grant 门（与 milestone GET 同规范）
  const phases = await listPhases(productionId);
  return Response.json({ phases });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const { id: productionId } = await ctx.params;
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = await req.json() as {
    name?: string;
    startDate?: string;
    endDate?: string | null;
    deptId?: string | null;
    sortOrder?: number;
    milestoneIds?: string[];
  };
  if (!body.name?.trim()) return Response.json({ error: "名称不能为空" }, { status: 400 });
  // 没头默认当天开始
  const startDate = body.startDate ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(startDate)) {
    return Response.json({ error: "startDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }
  const endDate = body.endDate ?? null;
  if (endDate !== null && !DATE_RE.test(endDate)) {
    return Response.json({ error: "endDate 格式应为 YYYY-MM-DD" }, { status: 400 });
  }
  if (endDate !== null && endDate < startDate) {
    return Response.json({ error: "结束日期不能早于开始日期" }, { status: 400 });
  }
  const deptId = body.deptId ?? null;

  if (!await canManagePhaseScope(toActor(session, permCtx), permCtx.pocDeptIds, productionId, deptId, "create")) {
    return Response.json({ error: "无权操作" }, { status: 403 });
  }

  if (deptId !== null && !await isDeptOfProduction(deptId, productionId)) {
    return Response.json({ error: "部门不存在或不是部门类型" }, { status: 400 });
  }

  // 本体与 milestone 边同事务落库（phase-db 内 BEGIN/COMMIT，边失败整体回滚）
  const phase = await createPhase(uid(), productionId, {
    name: body.name.trim(),
    startDate,
    endDate,
    deptId,
    sortOrder: body.sortOrder ?? 0,
    milestoneIds: Array.isArray(body.milestoneIds)
      ? body.milestoneIds.filter(x => typeof x === "string")
      : undefined,
  });
  return Response.json({ phase }, { status: 201 });
}
