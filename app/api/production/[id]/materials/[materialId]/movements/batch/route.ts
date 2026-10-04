import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import {
  appendMaterialStockMovements, getMaterial, getMaterialStockMovement,
  listMaterialStockLots, MaterialError, type MaterialMovementInput,
} from "@/lib/ops/material-db";
import { listMaterialIdentifiers } from "@/lib/ops/material-identifier-db";
import { canRecordMaterialMovement, type MaterialMovementGate } from "@/lib/ops/material-perm";
import type { MaterialCustodian, MaterialStockBucket } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string }> };
type BatchOperation = "receipt" | "checkout" | "return" | "maintenance";
type BatchItem = { lotId: string; fromBucket: MaterialStockBucket; returnOfMovementId: string | null };

const OPERATIONS: readonly BatchOperation[] = ["receipt", "checkout", "return", "maintenance"];

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (material.trackingStrategy !== "serialized")
    return Response.json({ error: "只有逐件物料可以按编号批量操作" }, { status: 400 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const operation = body.operation as BatchOperation;
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
    || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
  if (!(OPERATIONS as readonly unknown[]).includes(operation)
      || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100
      || idempotencyKey.length < 8 || idempotencyKey.length > 112
      || (body.reason !== undefined && typeof body.reason !== "string")
      || (body.toLocation !== undefined && typeof body.toLocation !== "string")
      || (body.custodianLabel !== undefined && typeof body.custodianLabel !== "string"))
    return Response.json({ error: "批量流转参数无效" }, { status: 400 });
  let custodian: MaterialCustodian | null = null;
  if (body.custodian !== undefined && body.custodian !== null) {
    if (typeof body.custodian !== "object" || Array.isArray(body.custodian))
      return Response.json({ error: "经手对象无效" }, { status: 400 });
    const value = body.custodian as Record<string, unknown>;
    if (typeof value.kind !== "string" || !["user", "dept", "group", "event"].includes(value.kind)
        || typeof value.id !== "string" || !value.id)
      return Response.json({ error: "经手对象无效" }, { status: 400 });
    custodian = { kind: value.kind as MaterialCustodian["kind"], id: value.id };
  }
  const items: BatchItem[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return Response.json({ error: "批量流转实物参数无效" }, { status: 400 });
    const item = raw as Record<string, unknown>;
    if (typeof item.lotId !== "string" || !item.lotId
        || !["expected", "in_stock", "checked_out"].includes(String(item.fromBucket))
        || (item.returnOfMovementId !== undefined && item.returnOfMovementId !== null
          && (typeof item.returnOfMovementId !== "string" || !item.returnOfMovementId)))
      return Response.json({ error: "批量流转实物参数无效" }, { status: 400 });
    items.push({ lotId: item.lotId, fromBucket: item.fromBucket as MaterialStockBucket,
      returnOfMovementId: typeof item.returnOfMovementId === "string" ? item.returnOfMovementId : null });
  }
  if (new Set(items.map((item) => item.lotId)).size !== items.length)
    return Response.json({ error: "不能重复选择同一实物" }, { status: 400 });
  const lots = await listMaterialStockLots(materialId, productionId);
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  if (items.some((item) => !byId.has(item.lotId)))
    return Response.json({ error: "实物编号不存在" }, { status: 404 });

  const actor = toActor(session, access.permCtx);
  const movements: Array<Omit<MaterialMovementInput,
    "productionId" | "quantity" | "createdBy" | "idempotencyKey">> = [];
  for (const item of items) {
    const referenced = item.returnOfMovementId
      ? await getMaterialStockMovement(item.returnOfMovementId, item.lotId, productionId)
      : null;
    if (item.returnOfMovementId && (!referenced || referenced.fromBucket !== "in_stock"
        || referenced.toBucket !== "checked_out"))
      return Response.json({ error: "原签出记录无效" }, { status: 400 });
    let gate: MaterialMovementGate;
    let toBucket: MaterialStockBucket;
    if (operation === "receipt") {
      if (item.fromBucket !== "expected" || item.returnOfMovementId)
        return Response.json({ error: "批量入库只能选择待到货实物" }, { status: 400 });
      gate = { operation: "receipt" }; toBucket = "in_stock";
    } else if (operation === "checkout") {
      if (item.fromBucket !== "in_stock" || item.returnOfMovementId)
        return Response.json({ error: "批量签出只能选择在库实物" }, { status: 400 });
      gate = { operation: "checkout", custodianUserId: custodian?.kind === "user" ? custodian.id : null };
      toBucket = "checked_out";
    } else if (operation === "return") {
      if (item.fromBucket !== "checked_out" || !referenced)
        return Response.json({ error: "批量返库必须关联每件实物的原签出" }, { status: 400 });
      gate = { operation: "return", checkoutCustodianUserId: referenced.custodian?.kind === "user" ? referenced.custodian.id : null };
      toBucket = "in_stock";
    } else {
      if ((item.fromBucket !== "in_stock" && item.fromBucket !== "checked_out")
          || (item.fromBucket === "checked_out") !== Boolean(referenced))
        return Response.json({ error: "批量报修只能选择在库或已签出实物" }, { status: 400 });
      gate = { operation: "maintenance", checkoutCustodianUserId: referenced?.custodian?.kind === "user" ? referenced.custodian.id : null };
      toBucket = "maintenance";
    }
    if (!await canRecordMaterialMovement(actor, productionId, material, gate))
      return Response.json({ error: "所选实物中包含无权操作的编号" }, { status: 403 });
    movements.push({ lotId: item.lotId, fromBucket: item.fromBucket, toBucket,
      returnOfMovementId: item.returnOfMovementId,
      reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim()
        : operation === "receipt" ? "批量入库" : operation === "checkout" ? "批量签出"
          : operation === "return" ? "批量返库" : "批量报修",
      note: typeof body.reason === "string" ? body.reason.trim() : "",
      toLocation: typeof body.toLocation === "string" ? body.toLocation.trim() : "",
      custodian: operation === "checkout" ? custodian : null,
      custodianLabel: operation === "checkout" && typeof body.custodianLabel === "string"
        ? body.custodianLabel.trim() : "",
    });
  }
  try {
    const results = await appendMaterialStockMovements({
      productionId, movements, operation, idempotencyKey, createdBy: session.userId,
    });
    const selected = new Set(items.map((item) => item.lotId));
    const identifiers = operation === "receipt"
      ? (await listMaterialIdentifiers(productionId, materialId))
        .filter((identifier) => identifier.lotId && selected.has(identifier.lotId))
      : [];
    return Response.json({ movements: results, identifiers }, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
