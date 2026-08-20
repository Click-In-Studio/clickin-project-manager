/**
 * 物料台账的读写。
 *
 * 与 asset（数字资产：文件 / R2 / 飞书链接）是两回事——本模块管的是实体物：
 * 「PR-014 旧式黄铜航海罗盘，库位 A-03，道具组负责，已入库」。
 *
 * ## 两条口径
 *
 * **责任方复用 task 的主体抽象**（部门 | 用户组，二选一）。组自带 POC，所以
 * 「这批道具归谁负责」和「这条任务归谁负责」是同一套解析，见 lib/task-poc.ts。
 *
 * **状态只是列表，不是状态机**（2026-08-20 用户定谳）。任何状态可以改到任何状态。
 * 等真实用法跑出规则了再加约束——反过来（先定死再放开）是破坏性的。
 */

import { getPool } from "./pg";
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
  location: string;
  quantity: number;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export class MaterialError extends Error {
  constructor(readonly reason: "duplicate_code" | "bad_subject" | "bad_status", message: string) {
    super(message);
  }
}

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
  m.location, m.quantity, m.notes, m.created_by, m.created_at, m.updated_at`;

type MaterialRow = {
  id: string; production_id: string; code: string; name: string; category: string;
  department_id: string | null; department_name: string | null;
  group_id: string | null; group_name: string | null;
  status_id: string | null; status_name: string | null; status_color: string | null;
  location: string; quantity: number; notes: string;
  created_by: string; created_at: Date; updated_at: Date;
};

function rowToMaterial(r: MaterialRow): Material {
  return {
    id: r.id, productionId: r.production_id, code: r.code, name: r.name, category: r.category,
    departmentId: r.department_id, departmentName: r.department_name,
    groupId: r.group_id, groupName: r.group_name,
    statusId: r.status_id, statusName: r.status_name, statusColor: r.status_color,
    location: r.location, quantity: r.quantity, notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const MATERIAL_FROM = `
  FROM production_material m
  LEFT JOIN production_dept d ON d.id = m.department_id
  LEFT JOIN event_group g     ON g.id = m.group_id
  LEFT JOIN production_material_status s ON s.id = m.status_id`;

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
  const cols = subjectColumns(params.subject);
  try {
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO production_material
         (production_id, code, name, category, department_id, group_id,
          status_id, location, quantity, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        params.productionId, params.code.trim(), params.name.trim(), params.category ?? "",
        cols.departmentId, cols.groupId, params.statusId ?? null,
        params.location ?? "", params.quantity ?? 1, params.notes ?? "", params.createdBy,
      ],
    );
    const created = await getMaterial(res.rows[0].id, params.productionId);
    if (!created) throw new Error(`material not found after create: ${res.rows[0].id}`);
    return created;
  } catch (e) {
    if (e instanceof Error && e.message.includes("production_material_code_idx"))
      throw new MaterialError("duplicate_code", "该编号在本项目里已存在");
    throw e;
  }
}

/**
 * 改台账行。
 *
 * `subjectCols` 由调用方用 lib/task-poc 的 resolveSubjectPatch 算好再传——那里的
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
  if (fields.statusId !== undefined) await assertStatusUsable(productionId, fields.statusId);

  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id, productionId];
  if (fields.code     !== undefined) sets.push(`code      = $${vals.push(fields.code.trim())}`);
  if (fields.name     !== undefined) sets.push(`name      = $${vals.push(fields.name.trim())}`);
  if (fields.category !== undefined) sets.push(`category  = $${vals.push(fields.category)}`);
  if (fields.statusId !== undefined) sets.push(`status_id = $${vals.push(fields.statusId)}`);
  if (fields.location !== undefined) sets.push(`location  = $${vals.push(fields.location)}`);
  if (fields.quantity !== undefined) sets.push(`quantity  = $${vals.push(fields.quantity)}`);
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
  await getPool().query(
    "DELETE FROM production_material WHERE id = $1 AND production_id = $2",
    [id, productionId],
  );
}
