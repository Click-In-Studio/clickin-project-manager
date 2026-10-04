import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { canManageMaterialDefinition } from "@/lib/ops/material-perm";
import { resolveSubjectPatch } from "@/lib/ops/task-poc";
import { deleteMaterial, getMaterial, listMaterialCheckouts, listMaterialStockLots, listMaterialStockMovements, MaterialError, updateMaterial } from "@/lib/ops/material-db";
import { listMaterialIdentifiers } from "@/lib/ops/material-identifier-db";
import { listMaterialSourceExceptions, listMaterialSourceReturns } from "@/lib/ops/material-source-db";
import { getMaterialCapabilities } from "@/lib/ops/material-capabilities";
import { isMaterialTrackingStrategy } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const actor = toActor(session, access.permCtx);
  if (!await hasEffectiveGrant(actor, productionId, "material", "*", "*", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  const lots = await listMaterialStockLots(materialId, productionId);
  const [identifiers, checkouts, lotDetails, capabilities] = await Promise.all([
    listMaterialIdentifiers(productionId, materialId),
    listMaterialCheckouts(materialId, productionId),
    Promise.all(lots.map(async (lot) => ({
      lotId: lot.id,
      movements: await listMaterialStockMovements(lot.id, productionId),
      sourceReturns: await listMaterialSourceReturns(lot.id, productionId),
      sourceExceptions: await listMaterialSourceExceptions(lot.id, productionId),
    }))),
    getMaterialCapabilities(actor, productionId, access.isArchived, [material]),
  ]);
  return Response.json({ material, lots, identifiers, checkouts, lotDetails, capabilities });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const existing = await getMaterial(materialId, productionId);
  if (!existing) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await canManageMaterialDefinition(toActor(session, access.permCtx), productionId, existing, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  if (body.statusId !== undefined)
    return Response.json({ error: "物料状态由流转记录决定" }, { status: 400 });
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim()))
    return Response.json({ error: "名称不能为空" }, { status: 400 });
  if (body.trackingStrategy !== undefined && !isMaterialTrackingStrategy(body.trackingStrategy))
    return Response.json({ error: "跟踪方式无效" }, { status: 400 });
  if (body.quantity !== undefined || body.location !== undefined)
    return Response.json({ error: "数量和库位必须通过库存流水变更" }, { status: 400 });

  // 每个字段只清它自己那一支——旧客户端只知道部门时发一个 departmentId: null，
  // 不该顺手把用户组绑定也清掉（task 那边踩过这个坑，见 lib/ops/task-poc.ts）
  const patch = await resolveSubjectPatch(productionId, body, existing);
  if (!patch.ok) return Response.json({ error: patch.error }, { status: patch.status });

  try {
    const material = await updateMaterial(materialId, productionId, {
      name: typeof body.name === "string" ? body.name : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      trackingStrategy: body.trackingStrategy,
      unit: typeof body.unit === "string" ? body.unit : undefined,
      quantityScale: typeof body.quantityScale === "number" ? body.quantityScale : undefined,
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

  const existing = await getMaterial(materialId, productionId);
  if (!existing) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await canManageMaterialDefinition(toActor(session, access.permCtx), productionId, existing, "delete"))
    return Response.json({ error: "权限不足" }, { status: 403 });

  await deleteMaterial(materialId, productionId);
  return Response.json({ ok: true });
}
