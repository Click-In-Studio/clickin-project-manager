import { getPool } from "../pg";
import type { TaskSubject } from "./task-poc";

export type MaterialSubjectRelation = TaskSubject & { member: boolean; poc: boolean };

/** 一次取回用户在本项目可代表的全部物料责任方；关系不物化 grant。 */
export async function listMaterialSubjectRelations(
  productionId: string,
  userId: string,
): Promise<MaterialSubjectRelation[]> {
  const { rows } = await getPool().query<{
    kind: "dept" | "group"; id: string; member: boolean; poc: boolean;
  }>(
    `SELECT 'dept'::text AS kind, d.id::text AS id,
            bool_or(m.user_id IS NOT NULL) AS member,
            bool_or(m.user_id IS NOT NULL AND m.is_poc) AS poc
       FROM production_dept d
       LEFT JOIN production_dept_member m
         ON m.dept_id=d.id AND m.production_id=d.production_id AND m.user_id=$2
      WHERE d.production_id=$1 AND m.user_id IS NOT NULL
      GROUP BY d.id
      UNION ALL
     SELECT 'group'::text AS kind, g.id::text AS id,
            (g.poc_user_id=$2 OR EXISTS (
               SELECT 1 FROM event_group_member direct
                WHERE direct.group_id=g.id AND direct.user_id=$2
             ) OR EXISTS (
               SELECT 1 FROM event_group_member gm
               JOIN production_dept_member pdm ON pdm.dept_id=gm.dept_id
                WHERE gm.group_id=g.id AND pdm.production_id=g.production_id
                  AND pdm.user_id=$2
             )) AS member,
            (g.poc_user_id=$2 OR EXISTS (
               SELECT 1 FROM production_dept_member pdm
                WHERE pdm.dept_id=g.poc_dept_id AND pdm.production_id=g.production_id
                  AND pdm.user_id=$2 AND pdm.is_poc
             )) AS poc
       FROM event_group g
      WHERE g.production_id=$1 AND (
        g.poc_user_id=$2
        OR EXISTS (SELECT 1 FROM event_group_member direct
                    WHERE direct.group_id=g.id AND direct.user_id=$2)
        OR EXISTS (SELECT 1 FROM event_group_member gm
                   JOIN production_dept_member pdm ON pdm.dept_id=gm.dept_id
                     AND pdm.production_id=g.production_id AND pdm.user_id=$2
                  WHERE gm.group_id=g.id)
        OR EXISTS (SELECT 1 FROM production_dept_member pdm
                    WHERE pdm.dept_id=g.poc_dept_id AND pdm.production_id=g.production_id
                      AND pdm.user_id=$2 AND pdm.is_poc)
      )
      ORDER BY kind,id`,
    [productionId, userId],
  );
  return rows;
}

export async function getMaterialSubjectRelation(
  productionId: string,
  userId: string,
  subject: TaskSubject | null,
): Promise<{ member: boolean; poc: boolean }> {
  if (!subject) return { member: false, poc: false };
  const relation = (await listMaterialSubjectRelations(productionId, userId))
    .find((row) => row.kind === subject.kind && row.id === subject.id);
  return relation ?? { member: false, poc: false };
}

export type MaterialLotCapabilityFact = {
  id: string;
  materialId: string;
  expectedQuantity: number;
  inStockQuantity: number;
  checkedOutQuantity: number;
  maintenanceQuantity: number;
  hasOwnOutstandingCheckout: boolean;
};

/** 能力接口所需的批次状态一次查询完成，不让客户端推导流水或逐行请求。 */
export async function listMaterialLotCapabilityFacts(
  productionId: string, userId: string,
): Promise<MaterialLotCapabilityFact[]> {
  const { rows } = await getPool().query<{
    id: string; material_id: string; expected: string; in_stock: string;
    checked_out: string; maintenance: string; own_checkout: boolean;
  }>(
    `SELECT l.id, l.material_id,
            (l.confirmed_quantity + COALESCE(SUM(CASE WHEN m.to_bucket='expected' THEN m.quantity ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN m.from_bucket='expected' THEN m.quantity ELSE 0 END),0))::text AS expected,
            (COALESCE(SUM(CASE WHEN m.to_bucket='in_stock' THEN m.quantity ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN m.from_bucket='in_stock' THEN m.quantity ELSE 0 END),0))::text AS in_stock,
            (COALESCE(SUM(CASE WHEN m.to_bucket='checked_out' THEN m.quantity ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN m.from_bucket='checked_out' THEN m.quantity ELSE 0 END),0))::text AS checked_out,
            (COALESCE(SUM(CASE WHEN m.to_bucket='maintenance' THEN m.quantity ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN m.from_bucket='maintenance' THEN m.quantity ELSE 0 END),0))::text AS maintenance,
            EXISTS (
              SELECT 1 FROM production_material_stock_movement c
               WHERE c.lot_id=l.id AND c.production_id=l.production_id
                 AND c.from_bucket='in_stock' AND c.to_bucket='checked_out'
                 AND c.reverses_event_id IS NULL AND c.return_of_movement_id IS NULL
                 AND c.custodian_kind='user' AND c.custodian_id=$2
                 AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement cr
                                  WHERE cr.reverses_event_id=c.id)
                 AND c.quantity > (
                   SELECT COALESCE(SUM(r.quantity),0)-COALESCE(SUM(rr.quantity),0)
                     FROM production_material_stock_movement r
                     LEFT JOIN production_material_stock_movement rr ON rr.reverses_event_id=r.id
                    WHERE r.return_of_movement_id=c.id
                 )
            ) AS own_checkout
       FROM production_material_stock_lot l
       LEFT JOIN production_material_stock_movement m ON m.lot_id=l.id
      WHERE l.production_id=$1
      GROUP BY l.id,l.material_id,l.confirmed_quantity,l.production_id
      ORDER BY l.created_at,l.id`,
    [productionId, userId],
  );
  return rows.map((r) => ({
    id: r.id, materialId: r.material_id,
    expectedQuantity: Number(r.expected), inStockQuantity: Number(r.in_stock),
    checkedOutQuantity: Number(r.checked_out), maintenanceQuantity: Number(r.maintenance),
    hasOwnOutstandingCheckout: r.own_checkout,
  }));
}
