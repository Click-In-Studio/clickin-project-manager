/** 物料批次的来源归还义务与异常账本。 */

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../pg";
import {
  appendMaterialStockMovementInTx, MaterialError,
} from "./material-db";
import {
  deriveMaterialSourceStatus, isMaterialSourceExceptionKind,
  type MaterialSourceExceptionKind, type MaterialSourceStatus, type MaterialSourceType,
  type MaterialCustodian,
} from "./material-types";

export type MaterialSourceExceptionInput = {
  kind: MaterialSourceExceptionKind;
  quantity: number;
  note?: string;
};

export type MaterialSourceException = {
  id: string;
  productionId: string;
  lotId: string;
  sourceReturnId: string | null;
  kind: MaterialSourceExceptionKind;
  quantity: number;
  note: string;
  resolvesExceptionId: string | null;
  isResolved: boolean;
  occurredAt: string;
  createdBy: string;
  createdAt: string;
};

export type MaterialSourceReturn = {
  id: string;
  productionId: string;
  lotId: string;
  movementId: string;
  quantity: number;
  returnedAt: string;
  note: string;
  isReversed: boolean;
  exceptions: MaterialSourceException[];
  createdBy: string;
  createdAt: string;
};

export type MaterialSourceObligation = {
  lotId: string;
  materialId: string;
  materialNumber: string;
  materialName: string;
  sourceType: Extract<MaterialSourceType, "rented" | "borrowed">;
  sourceLabel: string;
  sourceReference: string;
  confirmedQuantity: number;
  arrivedQuantity: number;
  returnDueAt: string | null;
  returnDueQuantity: number;
  returnedQuantity: number;
  outstandingQuantity: number;
  openExceptionQuantity: number;
  actualArrivalAt: string | null;
  actualReturnedAt: string | null;
  status: MaterialSourceStatus;
  isOverdue: boolean;
};

const newSourceReturnId = () =>
  `msr_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const newSourceExceptionId = () =>
  `mse_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

function dbConstraint(error: unknown): string {
  return error && typeof error === "object" && "constraint" in error
    ? String(error.constraint) : "";
}

function sourceError(error: unknown): never {
  if (error instanceof MaterialError) throw error;
  const constraint = dbConstraint(error);
  if (constraint === "material_source_return_not_required"
      || constraint === "material_stock_lot_return_obligation_check")
    throw new MaterialError("bad_source", "该批次没有对外归还义务");
  if (constraint === "material_source_return_movement")
    throw new MaterialError("bad_source_return", "对外退还必须引用同批次的有效退出流水");
  if (constraint === "material_source_return_overflow")
    throw new MaterialError("source_return_overflow", "累计退还来源方数量不能超过应还数量");
  if (constraint === "material_source_exception_not_required"
      || constraint === "material_source_exception_return"
      || constraint === "material_source_exception_resolution"
      || constraint === "material_source_exception_quantity")
    throw new MaterialError("bad_source_exception", "来源异常记录无效");
  if (constraint === "production_material_source_exception_resolves_exception_id_key")
    throw new MaterialError("source_exception_resolved", "该来源异常已经解决");
  if (constraint === "material_quantity_scale"
      || constraint === "material_serialized_movement_quantity")
    throw new MaterialError("bad_precision", "数量不符合该物料的精度要求");
  throw error;
}

function assertOccurredAt(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new MaterialError("bad_source", "实际发生时间无效");
}

function assertExceptionInput(input: MaterialSourceExceptionInput): void {
  if (!isMaterialSourceExceptionKind(input.kind)
      || !Number.isFinite(input.quantity) || input.quantity <= 0)
    throw new MaterialError("bad_source_exception", "来源异常类型或数量无效");
}

async function insertSourceException(
  client: PoolClient,
  params: {
    productionId: string;
    lotId: string;
    sourceReturnId?: string | null;
    input: MaterialSourceExceptionInput;
    resolvesExceptionId?: string | null;
    occurredAt: Date;
    createdBy: string;
  },
): Promise<MaterialSourceException> {
  assertExceptionInput(params.input);
  assertOccurredAt(params.occurredAt);
  const { rows } = await client.query<{
    id: string; production_id: string; lot_id: string; source_return_id: string | null;
    kind: MaterialSourceExceptionKind; quantity: string; note: string;
    resolves_exception_id: string | null; occurred_at: Date; created_by: string; created_at: Date;
  }>(
    `INSERT INTO production_material_source_exception
       (id, production_id, lot_id, source_return_id, kind, quantity, note,
        resolves_exception_id, occurred_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, production_id, lot_id, source_return_id, kind, quantity::text,
               note, resolves_exception_id, occurred_at, created_by, created_at`,
    [newSourceExceptionId(), params.productionId, params.lotId,
      params.sourceReturnId ?? null, params.input.kind, params.input.quantity,
      params.input.note ?? "", params.resolvesExceptionId ?? null,
      params.occurredAt, params.createdBy],
  );
  const row = rows[0];
  return {
    id: row.id, productionId: row.production_id, lotId: row.lot_id,
    sourceReturnId: row.source_return_id, kind: row.kind, quantity: Number(row.quantity),
    note: row.note, resolvesExceptionId: row.resolves_exception_id,
    isResolved: false, occurredAt: row.occurred_at.toISOString(),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(),
  };
}

/**
 * 退还来源方是独立业务写点：退出库存和归还义务事实必须在同一事务提交。
 * 内部返库继续走 checked_out → in_stock，不会进入本表。
 */
export async function recordMaterialSourceReturn(params: {
  productionId: string;
  lotId: string;
  quantity: number;
  returnedAt?: Date;
  note?: string;
  reason?: string;
  fromLocation?: string;
  toLocation?: string;
  custodian?: MaterialCustodian | null;
  custodianLabel?: string;
  exceptions?: MaterialSourceExceptionInput[];
  createdBy: string;
}): Promise<MaterialSourceReturn> {
  const returnedAt = params.returnedAt ?? new Date();
  assertOccurredAt(returnedAt);
  for (const issue of params.exceptions ?? []) assertExceptionInput(issue);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const movement = await appendMaterialStockMovementInTx(client, {
      productionId: params.productionId, lotId: params.lotId,
      fromBucket: "in_stock", toBucket: "exited", quantity: params.quantity,
      reason: params.reason ?? "退还来源方", exitReason: "returned_to_source",
      fromLocation: params.fromLocation, toLocation: params.toLocation,
      custodian: params.custodian, custodianLabel: params.custodianLabel,
      occurredAt: returnedAt, note: params.note ?? "退还来源方", createdBy: params.createdBy,
    });
    const id = newSourceReturnId();
    const { rows } = await client.query<{
      production_id: string; lot_id: string; movement_id: string;
      returned_at: Date; note: string; created_by: string; created_at: Date;
    }>(
      `INSERT INTO production_material_source_return
         (id, production_id, lot_id, movement_id, returned_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING production_id, lot_id, movement_id, returned_at, note, created_by, created_at`,
      [id, params.productionId, params.lotId, movement.id, returnedAt,
        params.note ?? "", params.createdBy],
    );
    const exceptions: MaterialSourceException[] = [];
    for (const input of params.exceptions ?? []) {
      exceptions.push(await insertSourceException(client, {
        productionId: params.productionId, lotId: params.lotId,
        sourceReturnId: id, input, occurredAt: returnedAt, createdBy: params.createdBy,
      }));
    }
    await client.query("COMMIT");
    const row = rows[0];
    return {
      id, productionId: row.production_id, lotId: row.lot_id,
      movementId: row.movement_id, quantity: movement.quantity,
      returnedAt: row.returned_at.toISOString(), note: row.note,
      isReversed: false, exceptions,
      createdBy: row.created_by, createdAt: row.created_at.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    sourceError(error);
  } finally {
    client.release();
  }
}

/** 可在尚未实际退还时登记遗失/少件，也可独立登记已知损坏。 */
export async function recordMaterialSourceException(params: {
  productionId: string;
  lotId: string;
  input: MaterialSourceExceptionInput;
  occurredAt?: Date;
  createdBy: string;
}): Promise<MaterialSourceException> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await insertSourceException(client, {
      ...params, occurredAt: params.occurredAt ?? new Date(),
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    sourceError(error);
  } finally {
    client.release();
  }
}

/** 解决异常也只追加事实，不覆盖原异常。 */
export async function resolveMaterialSourceException(params: {
  productionId: string;
  lotId: string;
  exceptionId: string;
  note?: string;
  occurredAt?: Date;
  createdBy: string;
}): Promise<MaterialSourceException> {
  const occurredAt = params.occurredAt ?? new Date();
  assertOccurredAt(occurredAt);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const original = await client.query<{
      kind: MaterialSourceExceptionKind; quantity: string;
    }>(
      `SELECT kind, quantity::text FROM production_material_source_exception
        WHERE id=$1 AND production_id=$2 AND lot_id=$3
          AND resolves_exception_id IS NULL`,
      [params.exceptionId, params.productionId, params.lotId],
    );
    if (!original.rows[0])
      throw new MaterialError("bad_source_exception", "来源异常不存在");
    const result = await insertSourceException(client, {
      productionId: params.productionId, lotId: params.lotId,
      input: {
        kind: original.rows[0].kind, quantity: Number(original.rows[0].quantity),
        note: params.note ?? "",
      },
      resolvesExceptionId: params.exceptionId, occurredAt, createdBy: params.createdBy,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    sourceError(error);
  } finally {
    client.release();
  }
}

export async function listMaterialSourceReturns(
  lotId: string, productionId: string,
): Promise<MaterialSourceReturn[]> {
  const { rows } = await getPool().query<{
    id: string; production_id: string; lot_id: string; movement_id: string; quantity: string;
    returned_at: Date; note: string; is_reversed: boolean;
    created_by: string; created_at: Date;
  }>(
    `SELECT sr.id, sr.production_id, sr.lot_id, sr.movement_id,
            movement.quantity::text, sr.returned_at, sr.note,
            EXISTS (SELECT 1 FROM production_material_stock_movement reversed
                     WHERE reversed.reverses_event_id=movement.id) AS is_reversed,
            sr.created_by, sr.created_at
       FROM production_material_source_return sr
       JOIN production_material_stock_movement movement ON movement.id=sr.movement_id
      WHERE sr.lot_id=$1 AND sr.production_id=$2
      ORDER BY sr.returned_at, sr.id`,
    [lotId, productionId],
  );
  const exceptions = await listMaterialSourceExceptions(lotId, productionId);
  return rows.map(row => ({
    id: row.id, productionId: row.production_id, lotId: row.lot_id,
    movementId: row.movement_id, quantity: Number(row.quantity),
    returnedAt: row.returned_at.toISOString(), note: row.note,
    isReversed: row.is_reversed,
    exceptions: exceptions.filter(issue => issue.sourceReturnId === row.id),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(),
  }));
}

export async function listMaterialSourceExceptions(
  lotId: string, productionId: string,
): Promise<MaterialSourceException[]> {
  const { rows } = await getPool().query<{
    id: string; production_id: string; lot_id: string; source_return_id: string | null;
    kind: MaterialSourceExceptionKind; quantity: string; note: string;
    resolves_exception_id: string | null; is_resolved: boolean;
    occurred_at: Date; created_by: string; created_at: Date;
  }>(
    `SELECT e.id, e.production_id, e.lot_id, e.source_return_id, e.kind,
            e.quantity::text, e.note, e.resolves_exception_id,
            EXISTS (SELECT 1 FROM production_material_source_exception resolution
                     WHERE resolution.resolves_exception_id=e.id) AS is_resolved,
            e.occurred_at, e.created_by, e.created_at
       FROM production_material_source_exception e
      WHERE e.lot_id=$1 AND e.production_id=$2
      ORDER BY e.occurred_at, e.id`,
    [lotId, productionId],
  );
  return rows.map(row => ({
    id: row.id, productionId: row.production_id, lotId: row.lot_id,
    sourceReturnId: row.source_return_id, kind: row.kind, quantity: Number(row.quantity),
    note: row.note, resolvesExceptionId: row.resolves_exception_id,
    isResolved: row.is_resolved, occurredAt: row.occurred_at.toISOString(),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(),
  }));
}

/** #828 可直接消费的项目级归还义务读模型；逾期仍是派生事实。 */
export async function listMaterialSourceObligations(
  productionId: string,
): Promise<MaterialSourceObligation[]> {
  const { rows } = await getPool().query<{
    lot_id: string; material_id: string; material_number: string; material_name: string;
    source_type: Extract<MaterialSourceType, "rented" | "borrowed">;
    source_label: string; source_reference: string; confirmed_quantity: string;
    arrived_quantity: string; return_due_at: Date | null; return_due_quantity: string;
    returned_quantity: string; open_exception_quantity: string;
    actual_arrival_at: Date | null; actual_returned_at: Date | null; cancelled_quantity: string;
  }>(
    `SELECT lot.id AS lot_id, lot.material_id,
            identifier.display_value AS material_number,
            material.name AS material_name, lot.source_type, lot.source_label,
            lot.source_reference, lot.confirmed_quantity::text,
            arrival.quantity::text AS arrived_quantity,
            lot.return_due_at, LEAST(lot.return_due_quantity, lot.confirmed_quantity-cancelled.quantity)::text AS return_due_quantity,
            cancelled.quantity::text AS cancelled_quantity,
            returned.quantity::text AS returned_quantity,
            exception.open_quantity::text AS open_exception_quantity,
            arrival.actual_at AS actual_arrival_at,
            returned.actual_at AS actual_returned_at
       FROM production_material_stock_lot lot
       JOIN production_material material
         ON material.id=lot.material_id AND material.production_id=lot.production_id
       JOIN production_material_identifier identifier
         ON identifier.production_id=material.production_id
        AND identifier.material_id=material.id
        AND identifier.kind='material_number'
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(m.quantity), 0) AS quantity, MAX(m.occurred_at) AS actual_at
           FROM production_material_stock_movement m
          WHERE m.lot_id=lot.id
            AND m.from_bucket='expected' AND m.to_bucket='in_stock'
            AND m.reverses_event_id IS NULL AND m.return_of_movement_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement reverse_movement
                             WHERE reverse_movement.reverses_event_id=m.id)
       ) arrival ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN m.to_bucket='cancelled' THEN m.quantity
           WHEN m.from_bucket='cancelled' THEN -m.quantity ELSE 0 END),0) AS quantity
           FROM production_material_stock_movement m WHERE m.lot_id=lot.id
       ) cancelled ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(m.quantity), 0) AS quantity, MAX(sr.returned_at) AS actual_at
           FROM production_material_source_return sr
           JOIN production_material_stock_movement m ON m.id=sr.movement_id
          WHERE sr.lot_id=lot.id AND sr.production_id=lot.production_id
            AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement reverse_movement
                             WHERE reverse_movement.reverses_event_id=m.id)
       ) returned ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(e.quantity), 0) AS open_quantity
           FROM production_material_source_exception e
          WHERE e.lot_id=lot.id AND e.production_id=lot.production_id
            AND e.resolves_exception_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM production_material_source_exception resolution
                             WHERE resolution.resolves_exception_id=e.id)
            AND (e.source_return_id IS NULL OR EXISTS (
              SELECT 1 FROM production_material_source_return sr
              JOIN production_material_stock_movement m ON m.id=sr.movement_id
              WHERE sr.id=e.source_return_id
                AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement reverse_movement
                                 WHERE reverse_movement.reverses_event_id=m.id)
            ))
       ) exception ON true
      WHERE lot.production_id=$1 AND lot.source_type IN ('rented','borrowed')
      ORDER BY lot.return_due_at NULLS LAST, identifier.serial_number, lot.id`,
    [productionId],
  );
  const now = Date.now();
  return rows.map(row => {
    const confirmedQuantity = Number(row.confirmed_quantity);
    const arrivedQuantity = Number(row.arrived_quantity);
    const returnDueQuantity = Number(row.return_due_quantity);
    const returnedQuantity = Number(row.returned_quantity);
    const openExceptionQuantity = Number(row.open_exception_quantity);
    const outstandingQuantity = Math.max(0, returnDueQuantity - returnedQuantity);
    return {
      lotId: row.lot_id, materialId: row.material_id,
      materialNumber: row.material_number, materialName: row.material_name,
      sourceType: row.source_type, sourceLabel: row.source_label,
      sourceReference: row.source_reference, confirmedQuantity, arrivedQuantity,
      returnDueAt: row.return_due_at?.toISOString() ?? null,
      returnDueQuantity, returnedQuantity, outstandingQuantity, openExceptionQuantity,
      actualArrivalAt: row.actual_arrival_at?.toISOString() ?? null,
      actualReturnedAt: row.actual_returned_at?.toISOString() ?? null,
      status: deriveMaterialSourceStatus({
        confirmedQuantity, cancelledQuantity: Number(row.cancelled_quantity), arrivedQuantity, returnDueQuantity,
        returnedQuantity, openExceptionQuantity,
      }),
      isOverdue: row.return_due_at !== null
        && row.return_due_at.getTime() < now && outstandingQuantity > 0,
    };
  });
}
