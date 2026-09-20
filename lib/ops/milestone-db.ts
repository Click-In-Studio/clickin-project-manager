/**
 * 里程碑（milestone 表）数据层：项目内的 CRUD + 跨项目「我的近期里程碑」。
 *
 * milestone（点）与 phase（区间）平级，phase ↔ milestone 多对多在 phase-db.ts；
 * 这里只认 milestone 自己的行。可见性全员，写门在路由层。
 */
import { getPool } from "../pg";

export type Milestone = {
  id: string;
  productionId: string;
  name: string;
  endDate: string;
  sortOrder: number;
  createdAt: string;
};

type MilestoneRow = {
  id: string;
  production_id: string;
  name: string;
  end_date: string;
  sort_order: number;
  created_at: Date;
};

function mapMilestoneRow(r: MilestoneRow): Milestone {
  return {
    id: r.id,
    productionId: r.production_id,
    name: r.name,
    endDate: r.end_date,
    sortOrder: r.sort_order,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listMilestones(productionId: string): Promise<Milestone[]> {
  const res = await getPool().query<MilestoneRow>(
    "SELECT id, production_id, name, end_date::text AS end_date, sort_order, created_at FROM milestone WHERE production_id = $1 ORDER BY end_date ASC, sort_order ASC",
    [productionId],
  );
  return res.rows.map(mapMilestoneRow);
}

export async function createMilestone(
  id: string,
  productionId: string,
  name: string,
  endDate: string,
  sortOrder: number,
): Promise<Milestone> {
  const res = await getPool().query<MilestoneRow>(
    `INSERT INTO milestone (id, production_id, name, end_date, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, name, end_date::text AS end_date, sort_order, created_at`,
    [id, productionId, name, endDate, sortOrder],
  );
  return mapMilestoneRow(res.rows[0]);
}

export async function updateMilestone(
  id: string,
  fields: { name?: string; endDate?: string; sortOrder?: number },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push(`name = $${vals.push(fields.name)}`); }
  if (fields.endDate !== undefined) { sets.push(`end_date = $${vals.push(fields.endDate)}`); }
  if (fields.sortOrder !== undefined) { sets.push(`sort_order = $${vals.push(fields.sortOrder)}`); }
  if (!sets.length) return;
  vals.push(id);
  await getPool().query(`UPDATE milestone SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

export async function deleteMilestone(id: string): Promise<void> {
  await getPool().query("DELETE FROM milestone WHERE id = $1", [id]);
}

export async function getMilestone(id: string): Promise<Milestone | null> {
  const res = await getPool().query<MilestoneRow>(
    "SELECT id, production_id, name, end_date::text AS end_date, sort_order, created_at FROM milestone WHERE id = $1",
    [id],
  );
  return res.rows[0] ? mapMilestoneRow(res.rows[0]) : null;
}

export type UpcomingMilestoneEntry = {
  id: string;
  name: string;
  endDate: string;
  productionId: string;
  productionName: string;
};

export async function listUpcomingMilestonesForUser(
  userId: string,
  isAdmin: boolean,
): Promise<UpcomingMilestoneEntry[]> {
  const res = await getPool().query<{
    id: string; name: string; end_date: string;
    production_id: string; production_name: string;
  }>(
    `SELECT m.id, m.name, m.end_date::text AS end_date,
            m.production_id, p.name AS production_name
     FROM milestone m
     JOIN production p ON m.production_id = p.id
     WHERE m.end_date >= CURRENT_DATE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = m.production_id AND pm.user_id = $2
       ))
     ORDER BY m.end_date ASC, m.sort_order ASC
     LIMIT 10`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    endDate: r.end_date,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}
