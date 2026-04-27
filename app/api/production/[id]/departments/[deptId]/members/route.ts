import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import { getEventDepartment, setDepartmentMembers } from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }) };
  const { memberRoles, overrides } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  if (!hasPermission("dept:manage", session.isAdmin, memberRoles, overrides))
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }) };
  return { session, deny: null };
}

/**
 * PUT — replace the full member/POC list for a department.
 * Body: { members: { openId: string; isMember: boolean; isPoc: boolean }[] }
 * POC and membership are independent — a person can be POC without being a member.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny } = await requireManage(req, productionId);
  if (deny) return deny;

  const dept = await getEventDepartment(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });

  const body = (await req.json()) as { members?: unknown };
  if (
    !Array.isArray(body.members) ||
    body.members.some(
      (x) => typeof x !== "object" || x === null ||
              typeof (x as Record<string, unknown>).openId !== "string" ||
              typeof (x as Record<string, unknown>).isMember !== "boolean" ||
              typeof (x as Record<string, unknown>).isPoc !== "boolean"
    )
  ) {
    return Response.json({ error: "members 必须是 { openId: string; isMember: boolean; isPoc: boolean }[]" }, { status: 400 });
  }

  const members = (body.members as { openId: string; isMember: boolean; isPoc: boolean }[]);
  await setDepartmentMembers(deptId, members);

  const updated = await getEventDepartment(deptId, productionId);
  return Response.json({ department: updated });
}
