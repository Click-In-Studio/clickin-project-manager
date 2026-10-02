import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { canWriteMaterial } from "@/lib/ops/material-perm";
import { appendMaterialStockMovement, getMaterial, listMaterialStockLots, MaterialError } from "@/lib/ops/material-db";
import { recordMaterialSourceReturn } from "@/lib/ops/material-source-db";
import { MATERIAL_EXIT_REASONS, MATERIAL_STOCK_BUCKETS, type MaterialCustodian, type MaterialExitReason, type MaterialStockBucket } from "@/lib/ops/material-types";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string; materialId: string }> };

/** #822 细分流转权限前，沿用物料实例 edit / 当前责任方 POC 写门；不开放新权限旁路。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId, materialId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  const material = await getMaterial(materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await canWriteMaterial(toActor(session, access.permCtx), productionId, material, "edit"))
    return Response.json({ error: "权限不足" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.value;
  const bad = () => Response.json({ error: "物料流转参数无效" }, { status: 400 });
  if (typeof b.lotId !== "string" || typeof b.quantity !== "number" || !Number.isFinite(b.quantity) || b.quantity <= 0
      || !(MATERIAL_STOCK_BUCKETS as readonly unknown[]).includes(b.fromBucket)
      || !(MATERIAL_STOCK_BUCKETS as readonly unknown[]).includes(b.toBucket)) return bad();
  for (const key of ["reason", "note", "fromLocation", "toLocation", "custodianLabel"])
    if (b[key] !== undefined && typeof b[key] !== "string") return bad();
  for (const key of ["eventId", "taskId", "reversesEventId", "returnOfMovementId"])
    if (b[key] !== undefined && b[key] !== null && (typeof b[key] !== "string" || !b[key])) return bad();
  if (b.reversesEventId != null && b.returnOfMovementId != null) return bad();
  if (b.exitReason !== undefined && b.exitReason !== null
      && !(MATERIAL_EXIT_REASONS as readonly unknown[]).includes(b.exitReason)) return bad();
  let custodian: MaterialCustodian | null = null;
  if (b.custodian !== undefined && b.custodian !== null) {
    if (typeof b.custodian !== "object" || Array.isArray(b.custodian)) return bad();
    const c = b.custodian as Record<string, unknown>;
    if (typeof c.kind !== "string" || !["user", "dept", "group", "event"].includes(c.kind) || typeof c.id !== "string" || !c.id) return bad();
    custodian = { kind: c.kind as MaterialCustodian["kind"], id: c.id };
  }
  if (b.occurredAt !== undefined && typeof b.occurredAt !== "string") return bad();
  const occurredAt = b.occurredAt === undefined ? undefined : new Date(b.occurredAt as string);
  if (occurredAt && Number.isNaN(occurredAt.getTime())) return bad();
  const lot = (await listMaterialStockLots(materialId, productionId)).find(l => l.id === b.lotId);
  if (!lot) return Response.json({ error: "物料批次不存在" }, { status: 404 });
  try {
    // 经手对象与签出用途正交：custodian.kind=event 不等于 eventId 用途关联。
    if (b.exitReason === "returned_to_source" && b.reversesEventId == null
        && ["rented", "borrowed"].includes(lot.sourceType)) {
      if (b.fromBucket !== "in_stock" || b.toBucket !== "exited" || b.returnOfMovementId != null || b.eventId != null || b.taskId != null) return bad();
      const sourceReturn = await recordMaterialSourceReturn({ productionId, lotId: lot.id,
        quantity: b.quantity, returnedAt: occurredAt, note: b.note as string | undefined,
        fromLocation: b.fromLocation as string | undefined, toLocation: b.toLocation as string | undefined,
        custodian, custodianLabel: b.custodianLabel as string | undefined, reason: b.reason as string | undefined,
        createdBy: session.userId });
      return Response.json({ sourceReturn }, { status: 201 });
    }
    const movement = await appendMaterialStockMovement({ productionId, lotId: lot.id,
      fromBucket: b.fromBucket as MaterialStockBucket, toBucket: b.toBucket as MaterialStockBucket, quantity: b.quantity,
      reversesEventId: b.reversesEventId as string | null | undefined,
      returnOfMovementId: b.returnOfMovementId as string | null | undefined,
      reason: b.reason as string | undefined, note: b.note as string | undefined,
      exitReason: b.exitReason as MaterialExitReason | null | undefined,
      fromLocation: b.fromLocation as string | undefined, toLocation: b.toLocation as string | undefined,
      eventId: b.eventId as string | null | undefined, taskId: b.taskId as string | null | undefined,
      custodian, custodianLabel: b.custodianLabel as string | undefined, occurredAt, createdBy: session.userId });
    return Response.json({ movement }, { status: 201 });
  } catch (e) {
    if (e instanceof MaterialError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
