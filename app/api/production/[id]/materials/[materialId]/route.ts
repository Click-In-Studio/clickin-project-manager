import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext } from "@/lib/db";
import { hasEffectiveGrant, toActor } from "@/lib/grant-check";
import { resolveSubjectPatch } from "@/lib/task-poc";
import { deleteMaterial, getMaterial, MaterialError, updateMaterial } from "@/lib/material-db";

type Ctx = { params: Promise<{ id: string; materialId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getMaterial(materialId, productionId);
  if (!existing) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", materialId, "*", "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const body = (await req.json()) as {
    code?: unknown; name?: unknown; category?: unknown;
    departmentId?: unknown; groupId?: unknown; statusId?: unknown;
    location?: unknown; quantity?: unknown; notes?: unknown;
  };
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim()))
    return Response.json({ error: "名称不能为空" }, { status: 400 });
  if (body.quantity !== undefined && (typeof body.quantity !== "number" || body.quantity < 0))
    return Response.json({ error: "数量必须是不小于 0 的数字" }, { status: 400 });

  // 每个字段只清它自己那一支——旧客户端只知道部门时发一个 departmentId: null，
  // 不该顺手把用户组绑定也清掉（task 那边踩过这个坑，见 lib/task-poc.ts）
  const patch = await resolveSubjectPatch(productionId, body, existing);
  if (!patch.ok) return Response.json({ error: patch.error }, { status: patch.status });

  try {
    const material = await updateMaterial(materialId, productionId, {
      code: typeof body.code === "string" ? body.code : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      statusId: body.statusId === null || typeof body.statusId === "string"
        ? body.statusId as string | null : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      quantity: typeof body.quantity === "number" ? body.quantity : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      subjectCols: patch.cols,
    });
    return Response.json({ material });
  } catch (e) {
    if (e instanceof MaterialError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  if (!await getMaterial(materialId, productionId))
    return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", materialId, "*", "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteMaterial(materialId, productionId);
  return Response.json({ ok: true });
}
