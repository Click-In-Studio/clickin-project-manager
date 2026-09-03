/**
 * 审批流程模版存储层（prA，db/add-approval-flow-template.sql）。
 *
 * **只存不驱动**：执行引擎（prB）落地前，published 仅是「使用中」声明标记，
 * 不改变任何申请的流转。本模块不碰 grant 行、不碰 approval_request。
 *
 * 单一使用中：编译器语义「该项目有已发布模版？」是单数（设计文档 §3），由
 * 部分唯一索引 uq_approval_flow_template_published 兜底；publish 在事务内先
 * 降旧再升新，对外表现为「切换使用中的流程」。
 *
 * 删除约束 v1 从简：仅草稿可删，published 必须先转回草稿。运行实例引用后的
 * 删除约束（设计文档 §6 不做清单）等 prB 落快照再谈——实例结构自快照，物理
 * 删除不会悬空在途行，这里挡的是「误删使用中配置」。
 */
import { randomBytes } from "node:crypto";
import { getPool } from "./pg";
import {
  validateTemplateNodes,
  MAX_TEMPLATE_NAME_LENGTH,
  type ApprovalFlowTemplateStatus,
  type ApprovalTemplateNode,
} from "./approval-flow-template";

/** 仓库 id 规约：新表 TEXT PK + 前缀 + 时间 + 随机尾（与 agent-runtime/ids.ts 同款）。 */
function newTemplateId(): string {
  return `aft_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export type ApprovalFlowTemplateRow = {
  id: string;
  productionId: string;
  name: string;
  description: string;
  resourceScope: string;
  status: ApprovalFlowTemplateStatus;
  nodes: ApprovalTemplateNode[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
};

type DbRow = {
  id: string;
  production_id: string;
  name: string;
  description: string;
  resource_scope: string;
  status: ApprovalFlowTemplateStatus;
  nodes: ApprovalTemplateNode[];
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

function toRow(r: DbRow): ApprovalFlowTemplateRow {
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    description: r.description,
    resourceScope: r.resource_scope,
    status: r.status,
    nodes: r.nodes,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  };
}

const SELECT_COLS = `id, production_id, name, description, resource_scope, status,
                     nodes, created_at, updated_at, updated_by`;

export async function listFlowTemplates(productionId: string): Promise<ApprovalFlowTemplateRow[]> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT ${SELECT_COLS} FROM approval_flow_template
     WHERE production_id = $1 ORDER BY created_at ASC`,
    [productionId],
  );
  return rows.map(toRow);
}

export async function getFlowTemplate(
  productionId: string,
  templateId: string,
): Promise<ApprovalFlowTemplateRow | null> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT ${SELECT_COLS} FROM approval_flow_template
     WHERE production_id = $1 AND id = $2`,
    [productionId, templateId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export type FlowTemplateWriteResult =
  | { ok: true; template: ApprovalFlowTemplateRow }
  | { ok: false; reason: "not_found" | "invalid"; errors?: string[] };

function validateName(name: unknown): string[] {
  if (typeof name !== "string" || name.trim().length === 0) return ["name 不能为空"];
  if (name.length > MAX_TEMPLATE_NAME_LENGTH) return [`name 不能超过 ${MAX_TEMPLATE_NAME_LENGTH} 字符`];
  return [];
}

export async function createFlowTemplate(
  productionId: string,
  userId: string,
  input: { name: string; description?: string; resourceScope?: string; nodes: unknown },
): Promise<FlowTemplateWriteResult> {
  const errors = [...validateName(input.name), ...validateTemplateNodes(input.nodes)];
  if (errors.length > 0) return { ok: false, reason: "invalid", errors };

  const { rows } = await getPool().query<DbRow>(
    `INSERT INTO approval_flow_template
       (id, production_id, name, description, resource_scope, status, nodes, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6::jsonb, $7)
     RETURNING ${SELECT_COLS}`,
    [
      newTemplateId(), productionId, input.name.trim(),
      input.description ?? "", input.resourceScope ?? "",
      JSON.stringify(input.nodes), userId,
    ],
  );
  return { ok: true, template: toRow(rows[0]) };
}

/**
 * PATCH 语义：内容字段任改；status 只接受 "draft"（回撤发布）。
 * 升为 published 必须走 publishFlowTemplate——那是带降旧事务的专用动作，
 * 混进 PATCH 会绕开单一使用中的切换语义。
 */
export async function updateFlowTemplate(
  productionId: string,
  templateId: string,
  userId: string,
  patch: { name?: string; description?: string; resourceScope?: string; nodes?: unknown; status?: string },
): Promise<FlowTemplateWriteResult> {
  const errors: string[] = [];
  if (patch.name !== undefined) errors.push(...validateName(patch.name));
  if (patch.nodes !== undefined) errors.push(...validateTemplateNodes(patch.nodes));
  if (patch.status !== undefined && patch.status !== "draft") {
    errors.push('status 仅接受 "draft"（发布请走 publish 接口）');
  }
  if (errors.length > 0) return { ok: false, reason: "invalid", errors };

  const { rows } = await getPool().query<DbRow>(
    `UPDATE approval_flow_template SET
       name           = COALESCE($3, name),
       description    = COALESCE($4, description),
       resource_scope = COALESCE($5, resource_scope),
       nodes          = COALESCE($6::jsonb, nodes),
       status         = COALESCE($7, status),
       updated_by     = $8,
       updated_at     = now()
     WHERE production_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [
      productionId, templateId,
      patch.name?.trim() ?? null,
      patch.description ?? null,
      patch.resourceScope ?? null,
      patch.nodes !== undefined ? JSON.stringify(patch.nodes) : null,
      patch.status ?? null,
      userId,
    ],
  );
  if (!rows[0]) return { ok: false, reason: "not_found" };
  return { ok: true, template: toRow(rows[0]) };
}

/** 发布：事务内先把本项目其他 published 降回草稿，再升本条——「切换使用中的流程」。 */
export async function publishFlowTemplate(
  productionId: string,
  templateId: string,
  userId: string,
): Promise<FlowTemplateWriteResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE approval_flow_template SET status = 'draft', updated_by = $2, updated_at = now()
       WHERE production_id = $1 AND status = 'published' AND id <> $3`,
      [productionId, userId, templateId],
    );
    const { rows } = await client.query<DbRow>(
      `UPDATE approval_flow_template SET status = 'published', updated_by = $3, updated_at = now()
       WHERE production_id = $1 AND id = $2
       RETURNING ${SELECT_COLS}`,
      [productionId, templateId, userId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    await client.query("COMMIT");
    return { ok: true, template: toRow(rows[0]) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type FlowTemplateDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "published" };

export async function deleteFlowTemplate(
  productionId: string,
  templateId: string,
): Promise<FlowTemplateDeleteResult> {
  const { rows } = await getPool().query<{ status: ApprovalFlowTemplateStatus }>(
    `SELECT status FROM approval_flow_template WHERE production_id = $1 AND id = $2`,
    [productionId, templateId],
  );
  if (!rows[0]) return { ok: false, reason: "not_found" };
  if (rows[0].status === "published") return { ok: false, reason: "published" };
  await getPool().query(
    `DELETE FROM approval_flow_template WHERE production_id = $1 AND id = $2 AND status <> 'published'`,
    [productionId, templateId],
  );
  return { ok: true };
}
