import { type NextRequest } from "next/server";
import { hasEventDomainView } from "@/lib/event-permissions";
import { toActor, hasGrant } from "@/lib/grant-check";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import {
  getProductionDept,
  updateProductionDept,
  deleteProductionDept,
} from "@/lib/dept-db";

type Ctx = { params: Promise<{ id: string; deptId: string }> };

async function requireManage(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, deny: Response.json({ error: "未登录" }, { status: 401 }), isArchived: false };
  const access = await getProductionPermissionContext(
    session.userId, session.isAdmin, productionId
  );
  if (!access) return { deny: Response.json({ error: "无权访问" }, { status: 403 }) };
  const { permCtx, isArchived } = access;
  if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, productionId, "org_dept", "*", "*", "create")))
    return { session, deny: Response.json({ error: "权限不足" }, { status: 403 }), isArchived };
  return { session, deny: null, isArchived };
}

/** GET — get a single department with its members. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(await hasEventDomainView(toActor(session, permCtx), productionId)))
    return Response.json({ error: "无权访问" }, { status: 403 });

  const dept = await getProductionDept(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  return Response.json({ department: dept });
}

/** PATCH — update name, parentId, displayOrder, permissions, allowedCueTypes. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const body = (await req.json()) as {
    name?: string;
    parentId?: string | null;
    kind?: "dept" | "group";
    displayOrder?: number;
  };

  const fields: Parameters<typeof updateProductionDept>[2] = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return Response.json({ error: "名称不能为空" }, { status: 400 });
    fields.name = name;
  }
  if ("parentId" in body) fields.parentId = body.parentId ?? null;
  if (body.kind === "dept" || body.kind === "group") fields.kind = body.kind;
  if (typeof body.displayOrder === "number") fields.displayOrder = body.displayOrder;

  await updateProductionDept(deptId, productionId, fields);

  const dept = await getProductionDept(deptId, productionId);
  if (!dept) return Response.json({ error: "部门不存在" }, { status: 404 });
  return Response.json({ department: dept });
}

/** DELETE — remove a department (blocked if resource_dept_manage records exist). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, deptId } = await ctx.params;
  const { deny, isArchived } = await requireManage(req, productionId);
  if (deny) return deny;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const result = await deleteProductionDept(deptId, productionId);
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "部门不存在" }, { status: 404 });
    if (result.reason === "has_resource_manage")
      return Response.json({ error: "部门仍在管理资源，无法解散。请先移除资源管理关系。" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
