/**
 * 物料台账的读写。
 *
 * 与 asset（数字资产：文件 / R2 / 飞书链接）是两回事——本模块管的是实体物：
 * 「PR-014 旧式黄铜航海罗盘，库位 A-03，道具组负责，已入库」。
 *
 * ## 三层口径
 *
 * **责任方复用 task 的主体抽象**（部门 | 用户组，二选一）。组自带 POC，所以
 * 「这批道具归谁负责」和「这条任务归谁负责」是同一套解析，见 lib/ops/task-poc.ts。
 *
 * production_material 只描述物料定义；production_material_stock_lot 记录已经确认会
 * 入库的批次；production_material_stock_movement 是不可改写的数量流水。当前库存只能
 * 从批次和流水推导，不能覆盖写一个 quantity/当前桶位值。
 *
 * status_id 是 #820 接管状态机前的旧页面展示字段，不参与库存计算。
 */

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { subjectColumns, type TaskSubject } from "./task-poc";

export type MaterialStatus = {
  id: string;
  name: string;
  color: string | null;
  orderIndex: number;
  isSystem: boolean;
};

export type Material = {
  id: string;
  productionId: string;
  code: string;
  name: string;
  category: string;
  /** 责任方：与 groupId 互斥 */
  departmentId: string | null;
  departmentName: string | null;
  groupId: string | null;
  groupName: string | null;
  statusId: string | null;
  statusName: string | null;
  statusColor: string | null;
  /** 各批次登记库位的汇总，仅供 #820 前旧页面展示。 */
  location: string;
  expectedQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  inStockQuantity: number;
  checkedOutQuantity: number;
  maintenanceQuantity: number;
  exitedQuantity: number;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export class MaterialError extends Error {
  constructor(readonly reason:
    | "duplicate_code" | "bad_subject" | "bad_status" | "bad_quantity"
    | "has_history" | "negative_stock" | "bad_reversal" | "inventory_requires_movement",
  message: string) {
    super(message);
  }
}

export const MATERIAL_STOCK_BUCKETS = [
  "expected", "in_stock", "checked_out", "maintenance", "exited",
] as const;
export type MaterialStockBucket = typeof MATERIAL_STOCK_BUCKETS[number];

export type MaterialStockLot = {
  id: string;
  productionId: string;
  materialId: string;
  confirmedQuantity: number;
  location: string;
  createdBy: string;
  createdAt: string;
};

export type MaterialStockMovement = {
  id: string;
  productionId: string;
  lotId: string;
  fromBucket: MaterialStockBucket;
  toBucket: MaterialStockBucket;
  quantity: number;
  reversesEventId: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
};

const newLotId = () => `ml_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const newMovementId = () => `mm_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

// ─── 状态定义 ─────────────────────────────────────────────────────────────────

/** 系统预设 + 该剧组自定义，按 order_index 排。 */
export async function listMaterialStatuses(productionId: string): Promise<MaterialStatus[]> {
  const res = await getPool().query<{
    id: string; name: string; color: string | null; order_index: number; is_system: boolean;
  }>(
    `SELECT id, name, color, order_index, is_system
       FROM production_material_status
      WHERE production_id IS NULL OR production_id = $1
      ORDER BY is_system DESC, order_index, name`,
    [productionId],
  );
  return res.rows.map(r => ({
    id: r.id, name: r.name, color: r.color, orderIndex: r.order_index, isSystem: r.is_system,
  }));
}

export async function createMaterialStatus(
  productionId: string, name: string, color: string | null, orderIndex: number,
): Promise<MaterialStatus> {
  const res = await getPool().query<{
    id: string; name: string; color: string | null; order_index: number; is_system: boolean;
  }>(
    `INSERT INTO production_material_status (production_id, name, color, order_index)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, color, order_index, is_system`,
    [productionId, name.trim(), color, orderIndex],
  );
  const r = res.rows[0];
  return { id: r.id, name: r.name, color: r.color, orderIndex: r.order_index, isSystem: r.is_system };
}

/**
 * 删一个剧组自定义状态。系统预设删不掉（`production_id = $2` 保证）。
 * 引用它的台账行 status_id 会被 ON DELETE SET NULL 置空，不连坐删物料。
 */
export async function deleteMaterialStatus(statusId: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM production_material_status WHERE id = $1 AND production_id = $2",
    [statusId, productionId],
  );
}

// ─── 台账 ─────────────────────────────────────────────────────────────────────

const MATERIAL_SELECT = `
  m.id, m.production_id, m.code, m.name, m.category,
  m.department_id, d.name AS department_name,
  m.group_id, g.name AS group_name,
  m.status_id, s.name AS status_name, s.color AS status_color,
  stock.location, stock.expected_quantity, stock.in_stock_quantity,
  stock.checked_out_quantity, stock.maintenance_quantity, stock.exited_quantity,
  m.notes, m.created_by, m.created_at, m.updated_at`;

type MaterialRow = {
  id: string; production_id: string; code: string; name: string; category: string;
  department_id: string | null; department_name: string | null;
  group_id: string | null; group_name: string | null;
  status_id: string | null; status_name: string | null; status_color: string | null;
  location: string; expected_quantity: string; in_stock_quantity: string;
  checked_out_quantity: string; maintenance_quantity: string; exited_quantity: string;
  notes: string;
  created_by: string; created_at: Date; updated_at: Date;
};

function rowToMaterial(r: MaterialRow): Material {
  const expectedQuantity = Number(r.expected_quantity);
  const inStockQuantity = Number(r.in_stock_quantity);
  const checkedOutQuantity = Number(r.checked_out_quantity);
  const maintenanceQuantity = Number(r.maintenance_quantity);
  const exitedQuantity = Number(r.exited_quantity);
  return {
    id: r.id, productionId: r.production_id, code: r.code, name: r.name, category: r.category,
    departmentId: r.department_id, departmentName: r.department_name,
    groupId: r.group_id, groupName: r.group_name,
    statusId: r.status_id, statusName: r.status_name, statusColor: r.status_color,
    location: r.location,
    expectedQuantity,
    heldQuantity: inStockQuantity + checkedOutQuantity + maintenanceQuantity,
    availableQuantity: inStockQuantity,
    inStockQuantity, checkedOutQuantity, maintenanceQuantity, exitedQuantity,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const MATERIAL_FROM = `
  FROM production_material m
  LEFT JOIN production_dept d ON d.id = m.department_id
  LEFT JOIN event_group g     ON g.id = m.group_id
  LEFT JOIN production_material_status s ON s.id = m.status_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(string_agg(DISTINCT NULLIF(l.location, ''), '、'), '') AS location,
      COALESCE(SUM(l.confirmed_quantity + mv.expected_delta), 0)::text AS expected_quantity,
      COALESCE(SUM(mv.in_stock_delta), 0)::text AS in_stock_quantity,
      COALESCE(SUM(mv.checked_out_delta), 0)::text AS checked_out_quantity,
      COALESCE(SUM(mv.maintenance_delta), 0)::text AS maintenance_quantity,
      COALESCE(SUM(mv.exited_delta), 0)::text AS exited_quantity
    FROM production_material_stock_lot l
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(CASE WHEN sm.to_bucket = 'expected' THEN sm.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN sm.from_bucket = 'expected' THEN sm.quantity ELSE 0 END), 0) AS expected_delta,
        COALESCE(SUM(CASE WHEN sm.to_bucket = 'in_stock' THEN sm.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN sm.from_bucket = 'in_stock' THEN sm.quantity ELSE 0 END), 0) AS in_stock_delta,
        COALESCE(SUM(CASE WHEN sm.to_bucket = 'checked_out' THEN sm.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN sm.from_bucket = 'checked_out' THEN sm.quantity ELSE 0 END), 0) AS checked_out_delta,
        COALESCE(SUM(CASE WHEN sm.to_bucket = 'maintenance' THEN sm.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN sm.from_bucket = 'maintenance' THEN sm.quantity ELSE 0 END), 0) AS maintenance_delta,
        COALESCE(SUM(CASE WHEN sm.to_bucket = 'exited' THEN sm.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN sm.from_bucket = 'exited' THEN sm.quantity ELSE 0 END), 0) AS exited_delta
      FROM production_material_stock_movement sm
      WHERE sm.lot_id = l.id
    ) mv ON true
    WHERE l.material_id = m.id AND l.production_id = m.production_id
  ) stock ON true`;

export async function listMaterials(productionId: string): Promise<Material[]> {
  const res = await getPool().query<MaterialRow>(
    `SELECT ${MATERIAL_SELECT} ${MATERIAL_FROM}
      WHERE m.production_id = $1
      ORDER BY m.category, m.code`,
    [productionId],
  );
  return res.rows.map(rowToMaterial);
}

export async function getMaterial(id: string, productionId: string): Promise<Material | null> {
  const res = await getPool().query<MaterialRow>(
    `SELECT ${MATERIAL_SELECT} ${MATERIAL_FROM}
      WHERE m.id = $1 AND m.production_id = $2`,
    [id, productionId],
  );
  return res.rows[0] ? rowToMaterial(res.rows[0]) : null;
}

/** 状态必须属于本剧组（或系统预设）——跨剧组的自定义状态不能用。 */
async function assertStatusUsable(productionId: string, statusId: string | null): Promise<void> {
  if (!statusId) return;
  const { rows } = await getPool().query(
    `SELECT 1 FROM production_material_status
      WHERE id = $1 AND (production_id IS NULL OR production_id = $2)`,
    [statusId, productionId],
  );
  if (!rows.length) throw new MaterialError("bad_status", "状态不存在");
}

export async function createMaterial(params: {
  productionId: string;
  code: string;
  name: string;
  category?: string;
  subject: TaskSubject | null;
  statusId?: string | null;
  location?: string;
  quantity?: number;
  notes?: string;
  createdBy: string;
}): Promise<Material> {
  await assertStatusUsable(params.productionId, params.statusId ?? null);
  const quantity = params.quantity ?? 1;
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new MaterialError("bad_quantity", "确认入库数量必须大于 0");
  const cols = subjectColumns(params.subject);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ id: string }>(
      `INSERT INTO production_material
         (production_id, code, name, category, department_id, group_id,
          status_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        params.productionId, params.code.trim(), params.name.trim(), params.category ?? "",
        cols.departmentId, cols.groupId, params.statusId ?? null,
        params.notes ?? "", params.createdBy,
      ],
    );
    const lot = await insertMaterialLot(client, {
      productionId: params.productionId, materialId: res.rows[0].id,
      confirmedQuantity: quantity, location: params.location ?? "", createdBy: params.createdBy,
    });
    await insertMaterialMovement(client, {
      productionId: params.productionId, lotId: lot.id,
      fromBucket: "expected", toBucket: "in_stock", quantity,
      note: "登记时入库", createdBy: params.createdBy,
    });
    await client.query("COMMIT");
    const created = await getMaterial(res.rows[0].id, params.productionId);
    if (!created) throw new Error(`material not found after create: ${res.rows[0].id}`);
    return created;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && e.message.includes("production_material_code_idx"))
      throw new MaterialError("duplicate_code", "该编号在本项目里已存在");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 改台账行。
 *
 * `subjectCols` 由调用方用 lib/ops/task-poc 的 resolveSubjectPatch 算好再传——那里的
 * 语义是「每个字段只清它自己那一支」，避免旧客户端发一个 departmentId: null 就把
 * 用户组绑定顺手清掉（task 那边踩过这个坑）。传 null 表示这次不动责任方。
 */
export async function updateMaterial(
  id: string,
  productionId: string,
  fields: {
    code?: string; name?: string; category?: string;
    statusId?: string | null; location?: string; quantity?: number; notes?: string;
    subjectCols?: { departmentId: string | null; groupId: string | null } | null;
  },
): Promise<Material | null> {
  if (fields.location !== undefined || fields.quantity !== undefined)
    throw new MaterialError("inventory_requires_movement", "数量和库位必须通过库存流水变更");
  if (fields.statusId !== undefined) await assertStatusUsable(productionId, fields.statusId);

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  if (fields.code     !== undefined) sets.push(`code      = $${vals.push(fields.code.trim())}`);
  if (fields.name     !== undefined) sets.push(`name      = $${vals.push(fields.name.trim())}`);
  if (fields.category !== undefined) sets.push(`category  = $${vals.push(fields.category)}`);
  if (fields.statusId !== undefined) sets.push(`status_id = $${vals.push(fields.statusId)}`);
  if (fields.notes    !== undefined) sets.push(`notes     = $${vals.push(fields.notes)}`);
  if (fields.subjectCols) {
    sets.push(`department_id = $${vals.push(fields.subjectCols.departmentId)}`);
    sets.push(`group_id      = $${vals.push(fields.subjectCols.groupId)}`);
  }

  try {
    const res = await getPool().query<{ id: string }>(
      `UPDATE production_material SET ${sets.join(", ")}
        WHERE id = $1 AND production_id = $2 RETURNING id`,
      vals,
    );
    if (!res.rows[0]) return null;
  } catch (e) {
    if (e instanceof Error && e.message.includes("production_material_code_idx"))
      throw new MaterialError("duplicate_code", "该编号在本项目里已存在");
    throw e;
  }
  return getMaterial(id, productionId);
}

export async function deleteMaterial(id: string, productionId: string): Promise<void> {
  try {
    await getPool().query(
      "DELETE FROM production_material WHERE id = $1 AND production_id = $2",
      [id, productionId],
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("material_stock_lot_material_fk"))
      throw new MaterialError("has_history", "已有库存历史的物料不能删除");
    throw e;
  }
}

type QueryClient = Pick<PoolClient, "query">;

async function insertMaterialLot(client: QueryClient, params: {
  productionId: string; materialId: string; confirmedQuantity: number;
  location?: string; createdBy: string;
}): Promise<MaterialStockLot> {
  if (!Number.isFinite(params.confirmedQuantity) || params.confirmedQuantity <= 0)
    throw new MaterialError("bad_quantity", "确认入库数量必须大于 0");
  const { rows } = await client.query<{
    id: string; production_id: string; material_id: string; confirmed_quantity: string;
    location: string; created_by: string; created_at: Date;
  }>(
    `INSERT INTO production_material_stock_lot
       (id, production_id, material_id, confirmed_quantity, location, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, production_id, material_id, confirmed_quantity::text,
               location, created_by, created_at`,
    [newLotId(), params.productionId, params.materialId, params.confirmedQuantity,
      params.location ?? "", params.createdBy],
  );
  const r = rows[0];
  return {
    id: r.id, productionId: r.production_id, materialId: r.material_id,
    confirmedQuantity: Number(r.confirmed_quantity), location: r.location,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  };
}

/** 建立一个已确认、尚未入库的批次；数量初始全部位于 expected。 */
export async function createMaterialStockLot(params: {
  productionId: string; materialId: string; confirmedQuantity: number;
  location?: string; createdBy: string;
}): Promise<MaterialStockLot> {
  return insertMaterialLot(getPool(), params);
}

async function insertMaterialMovement(client: QueryClient, params: {
  productionId: string; lotId: string; fromBucket: MaterialStockBucket;
  toBucket: MaterialStockBucket; quantity: number; reversesEventId?: string | null;
  note?: string; createdBy: string;
}): Promise<MaterialStockMovement> {
  if (!Number.isFinite(params.quantity) || params.quantity <= 0)
    throw new MaterialError("bad_quantity", "流水数量必须大于 0");
  try {
    const { rows } = await client.query<{
      id: string; production_id: string; lot_id: string;
      from_bucket: MaterialStockBucket; to_bucket: MaterialStockBucket; quantity: string;
      reverses_event_id: string | null; note: string; created_by: string; created_at: Date;
    }>(
      `INSERT INTO production_material_stock_movement
         (id, production_id, lot_id, from_bucket, to_bucket, quantity,
          reverses_event_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, production_id, lot_id, from_bucket, to_bucket, quantity::text,
                 reverses_event_id, note, created_by, created_at`,
      [newMovementId(), params.productionId, params.lotId, params.fromBucket,
        params.toBucket, params.quantity, params.reversesEventId ?? null,
        params.note ?? "", params.createdBy],
    );
    const r = rows[0];
    return {
      id: r.id, productionId: r.production_id, lotId: r.lot_id,
      fromBucket: r.from_bucket, toBucket: r.to_bucket, quantity: Number(r.quantity),
      reversesEventId: r.reverses_event_id, note: r.note,
      createdBy: r.created_by, createdAt: r.created_at.toISOString(),
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("material_stock_nonnegative"))
      throw new MaterialError("negative_stock", "该批次在来源状态下的数量不足");
    if (e instanceof Error && e.message.includes("material_stock_exact_reversal"))
      throw new MaterialError("bad_reversal", "冲销流水必须与原流水数量和方向完全相反");
    throw e;
  }
}

/** 唯一库存写点：追加一次桶间移动；数据库会锁定批次并拒绝负库存。 */
export async function appendMaterialStockMovement(params: {
  productionId: string; lotId: string; fromBucket: MaterialStockBucket;
  toBucket: MaterialStockBucket; quantity: number; reversesEventId?: string | null;
  note?: string; createdBy: string;
}): Promise<MaterialStockMovement> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 锁必须是 INSERT 之前的独立语句：并发等待结束后，INSERT/触发器会拿到新快照，
    // 从而看见前一笔已提交流水，而不是基于等待前的余额继续扣减。
    const lock = await client.query(
      `SELECT 1 FROM production_material_stock_lot
        WHERE id = $1 AND production_id = $2 FOR UPDATE`,
      [params.lotId, params.productionId],
    );
    if (!lock.rowCount) throw new Error("material stock lot not found");
    const movement = await insertMaterialMovement(client, params);
    await client.query("COMMIT");
    return movement;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function listMaterialStockLots(
  materialId: string, productionId: string,
): Promise<MaterialStockLot[]> {
  const { rows } = await getPool().query<{
    id: string; production_id: string; material_id: string; confirmed_quantity: string;
    location: string; created_by: string; created_at: Date;
  }>(
    `SELECT id, production_id, material_id, confirmed_quantity::text,
            location, created_by, created_at
       FROM production_material_stock_lot
      WHERE material_id = $1 AND production_id = $2
      ORDER BY created_at, id`,
    [materialId, productionId],
  );
  return rows.map(r => ({
    id: r.id, productionId: r.production_id, materialId: r.material_id,
    confirmedQuantity: Number(r.confirmed_quantity), location: r.location,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}

export async function listMaterialStockMovements(
  lotId: string, productionId: string,
): Promise<MaterialStockMovement[]> {
  const { rows } = await getPool().query<{
    id: string; production_id: string; lot_id: string;
    from_bucket: MaterialStockBucket; to_bucket: MaterialStockBucket; quantity: string;
    reverses_event_id: string | null; note: string; created_by: string; created_at: Date;
  }>(
    `SELECT id, production_id, lot_id, from_bucket, to_bucket, quantity::text,
            reverses_event_id, note, created_by, created_at
       FROM production_material_stock_movement
      WHERE lot_id = $1 AND production_id = $2
      ORDER BY created_at, id`,
    [lotId, productionId],
  );
  return rows.map(r => ({
    id: r.id, productionId: r.production_id, lotId: r.lot_id,
    fromBucket: r.from_bucket, toBucket: r.to_bucket, quantity: Number(r.quantity),
    reversesEventId: r.reverses_event_id, note: r.note,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}
