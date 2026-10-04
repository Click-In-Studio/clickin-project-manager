import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { createMaterialStockLots, getMaterial, listMaterialStockLots, MaterialError } from "@/lib/ops/material-db";
import { listMaterialIdentifiers } from "@/lib/ops/material-identifier-db";
import { canManageMaterialSources, canRecordMaterialMovement } from "@/lib/ops/material-perm";
import { isMaterialSourceType } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await hasEffectiveGrant(toActor(session, access.permCtx), productionId, "material", "*", "*", "view"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  return Response.json({ lots: await listMaterialStockLots(materialId, productionId) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  const actor = toActor(session, access.permCtx);
  if (!await canRecordMaterialMovement(actor, productionId, material, { operation: "receipt" }))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
    || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
  if (typeof body.confirmedQuantity !== "number" || !Number.isFinite(body.confirmedQuantity)
      || body.confirmedQuantity <= 0 || (body.location !== undefined && typeof body.location !== "string")
      || (body.sourceType !== undefined && !isMaterialSourceType(body.sourceType))
      || (body.receiveNow !== undefined && typeof body.receiveNow !== "boolean")
      || idempotencyKey.length < 8 || idempotencyKey.length > 112)
    return Response.json({ error: "批次参数无效" }, { status: 400 });
  const sourceType = body.sourceType ?? "existing";
  if (sourceType !== "existing"
      && !await canManageMaterialSources(actor, productionId, material))
    return Response.json({ error: "登记采购、租赁或借用来源需要来源维护权限" }, { status: 403 });
  const date = (value: unknown) => typeof value === "string" && value ? new Date(value) : null;
  const expectedArrivalAt = date(body.expectedArrivalAt);
  const returnDueAt = date(body.returnDueAt);
  if ((expectedArrivalAt && Number.isNaN(expectedArrivalAt.getTime()))
      || (returnDueAt && Number.isNaN(returnDueAt.getTime())))
    return Response.json({ error: "日期无效" }, { status: 400 });
  try {
    const lots = await createMaterialStockLots({
      productionId, materialId, confirmedQuantity: body.confirmedQuantity,
      location: typeof body.location === "string" ? body.location : "",
      sourceType,
      sourceLabel: typeof body.sourceLabel === "string" ? body.sourceLabel : "",
      sourceReference: typeof body.sourceReference === "string" ? body.sourceReference : "",
      sourceNote: typeof body.sourceNote === "string" ? body.sourceNote : "",
      expectedArrivalAt,
      returnDueAt,
      returnDueQuantity: typeof body.returnDueQuantity === "number" ? body.returnDueQuantity : null,
      idempotencyKey,
      receiveNow: body.receiveNow === true,
      createdBy: session.userId,
    });
    const lotIds = new Set(lots.map((lot) => lot.id));
    const identifiers = (await listMaterialIdentifiers(productionId, materialId))
      .filter((identifier) => identifier.lotId && lotIds.has(identifier.lotId));
    return Response.json({ lots, identifiers }, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
