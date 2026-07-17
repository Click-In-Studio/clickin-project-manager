import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import {
  getEventDepartment,
  updateEventDepartment,
  deleteEventDepartment,
} from "@/lib/event-db";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(
    session.openId, session.isAdmin, productionId
  );
  if (!hasPermission("dept:manage", session.isAdmin, memberRoles, overrides))
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived };
  return { session, deny: null, isArchived };
}

/** PATCH — update name, kind, or displayOrder. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json()) as {
    name?: string;
    kind?: string;
    displayOrder?: number;
  };

  const fields: Parameters<typeof updateEventDepartment>[2] = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
    fields.name = name;
  }
  if (body.kind === "dept" || body.kind === "group") fields.kind = body.kind;
  if (typeof body.displayOrder === "number") fields.displayOrder = body.displayOrder;

  await updateEventDepartment(deptId, productionId, fields);

  const dept = await getEventDepartment(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  return Response.json({ department: dept });
}

/** DELETE — remove a department or group. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const dept = await getEventDepartment(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });

  await deleteEventDepartment(deptId, productionId);
  return Response.json({ ok: true });
}
