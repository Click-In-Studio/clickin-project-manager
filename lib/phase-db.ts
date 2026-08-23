/**
 * Phase（项目大阶段）数据层。
 *
 * milestone（点）与 phase（区间）平级：phase ↔ milestone 多对多（phase_milestone），
 * task ↔ phase 多对多（task_phase，读写在 lib/event-db.ts 的 task 域）。
 * 可见性全员；dept_id 只表达归属与管理权（NULL = production-level）。
 */
import type { PoolClient } from "pg";
import { getPool } from "./pg";

export type Phase = {
  id: string;
  productionId: string;
  /** NULL = production-level；非 NULL = department-specific */
  deptId: string | null;
  deptName: string | null;
  name: string;
  startDate: string;
  /** NULL = 尾巴未定 */
  endDate: string | null;
  sortOrder: number;
  createdAt: string;
  milestoneIds: string[];
};

type PhaseRow = {
  id: string;
  production_id: string;
  dept_id: string | null;
  dept_name: string | null;
  name: string;
  start_date: string;
  end_date: string | null;
  sort_order: number;
  created_at: Date;
  milestone_ids: string[] | null;
};

const PHASE_SELECT = `
  SELECT p.id, p.production_id, p.dept_id::text AS dept_id, pd.name AS dept_name,
         p.name, p.start_date::text AS start_date, p.end_date::text AS end_date,
         p.sort_order, p.created_at,
         (SELECT array_agg(pm.milestone_id) FROM phase_milestone pm WHERE pm.phase_id = p.id)
           AS milestone_ids
  FROM phase p
  LEFT JOIN production_dept pd ON pd.id = p.dept_id`;

function mapPhaseRow(r: PhaseRow): Phase {
  return {
    id: r.id,
    productionId: r.production_id,
    deptId: r.dept_id,
    deptName: r.dept_name,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    sortOrder: r.sort_order,
    createdAt: r.created_at.toISOString(),
    milestoneIds: r.milestone_ids ?? [],
  };
}

export async function listPhases(productionId: string): Promise<Phase[]> {
  const res = await getPool().query<PhaseRow>(
    `${PHASE_SELECT}
     WHERE p.production_id = $1
     ORDER BY p.start_date ASC, p.sort_order ASC, p.created_at ASC`,
    [productionId],
  );
  return res.rows.map(mapPhaseRow);
}

export async function getPhase(id: string): Promise<Phase | null> {
  const res = await getPool().query<PhaseRow>(`${PHASE_SELECT} WHERE p.id = $1`, [id]);
  return res.rows[0] ? mapPhaseRow(res.rows[0]) : null;
}

/** 事务内整体替换 milestone 边。应用层不变量：milestone 与 phase 同 production（跨剧组 id 过滤丢弃）。 */
async function replaceMilestoneEdges(
  client: PoolClient, phaseId: string, productionId: string, milestoneIds: string[],
): Promise<void> {
  await client.query("DELETE FROM phase_milestone WHERE phase_id = $1", [phaseId]);
  const unique = [...new Set(milestoneIds)];
  if (unique.length > 0) {
    await client.query(
      `INSERT INTO phase_milestone (phase_id, milestone_id)
       SELECT $1, m.id FROM milestone m
       WHERE m.id = ANY($2::text[]) AND m.production_id = $3
       ON CONFLICT DO NOTHING`,
      [phaseId, unique, productionId],
    );
  }
}

/** 创建 phase；milestoneIds 一并给出时本体与边同事务落库（边失败则整体回滚，不留无绑定残行）。 */
export async function createPhase(
  id: string,
  productionId: string,
  fields: {
    name: string;
    startDate: string;
    endDate?: string | null;
    deptId?: string | null;
    sortOrder?: number;
    milestoneIds?: string[];
  },
): Promise<Phase> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO phase (id, production_id, dept_id, name, start_date, end_date, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, productionId, fields.deptId ?? null, fields.name,
       fields.startDate, fields.endDate ?? null, fields.sortOrder ?? 0],
    );
    if (fields.milestoneIds !== undefined && fields.milestoneIds.length > 0) {
      await replaceMilestoneEdges(client, id, productionId, fields.milestoneIds);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const created = await getPhase(id);
  if (!created) throw new Error(`phase not found after create: ${id}`);
  return created;
}

/** 更新 phase；milestoneIds !== undefined 时同事务整体替换绑定。 */
export async function updatePhase(
  id: string,
  productionId: string,
  fields: {
    name?: string;
    startDate?: string;
    /** null = 清空（尾巴未定） */
    endDate?: string | null;
    sortOrder?: number;
    milestoneIds?: string[];
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push(`name = $${vals.push(fields.name)}`); }
  if (fields.startDate !== undefined) { sets.push(`start_date = $${vals.push(fields.startDate)}`); }
  if (fields.endDate !== undefined) { sets.push(`end_date = $${vals.push(fields.endDate)}`); }
  if (fields.sortOrder !== undefined) { sets.push(`sort_order = $${vals.push(fields.sortOrder)}`); }
  if (!sets.length && fields.milestoneIds === undefined) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (sets.length) {
      await client.query(
        `UPDATE phase SET ${sets.join(", ")} WHERE id = $${vals.push(id)}`, vals,
      );
    }
    if (fields.milestoneIds !== undefined) {
      await replaceMilestoneEdges(client, id, productionId, fields.milestoneIds);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deletePhase(id: string): Promise<void> {
  await getPool().query("DELETE FROM phase WHERE id = $1", [id]);
}

/** 独立入口的整体替换（自成事务）。路由的创建/更新走 createPhase/updatePhase 的同事务路径。 */
export async function setPhaseMilestones(
  phaseId: string, productionId: string, milestoneIds: string[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await replaceMilestoneEdges(client, phaseId, productionId, milestoneIds);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
