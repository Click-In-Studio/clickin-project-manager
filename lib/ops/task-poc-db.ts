import { getPool } from "../pg";

/**
 * 批量列出当前用户担任 POC 的 task id。
 *
 * 列表页不能逐条调用 isTaskPoc（会变成 N+1），但也不能另抄一份简化成「部门 POC」：
 * 用户组的 POC 既可能是个人、也可能来自部门，event 冻结后还必须读当时的快照。
 * 本函数是 isTaskPoc 的集合版；productionId 为空时用于跨项目「我的任务」。
 */
export async function listTaskPocIdsForUser(
  userId: string,
  productionId?: string,
): Promise<string[]> {
  const params: unknown[] = [userId];
  const productionFilter = productionId ? `AND t.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{ id: string }>(
    `SELECT t.id
       FROM task t
       LEFT JOIN event_group eg
         ON eg.id = t.group_id AND eg.production_id = t.production_id
      WHERE 1 = 1
        ${productionFilter}
        AND (
          EXISTS (
            SELECT 1 FROM production_dept_member pdm
             WHERE pdm.production_id = t.production_id
               AND pdm.dept_id = t.department_id
               AND pdm.user_id = $1 AND pdm.is_poc = true
          )
          OR (
            t.group_id IS NOT NULL
            AND (
              (
                EXISTS (
                  SELECT 1 FROM event_group_freeze f
                   WHERE f.event_id = t.event_id AND f.group_id = t.group_id
                     AND f.released_at IS NULL
                )
                AND (
                  EXISTS (
                    SELECT 1
                      FROM event_group_freeze f
                      JOIN event_group_freeze_member m
                        ON m.event_id = f.event_id AND m.group_id = f.group_id
                       AND m.frozen_at = f.frozen_at
                     WHERE f.event_id = t.event_id AND f.group_id = t.group_id
                       AND f.released_at IS NULL
                       AND m.user_id = $1 AND m.was_poc = true
                  )
                  OR EXISTS (
                    SELECT 1 FROM event_group_freeze f
                     WHERE f.event_id = t.event_id AND f.group_id = t.group_id
                       AND f.released_at IS NULL AND f.poc_user_id = $1
                  )
                )
              )
              OR (
                NOT EXISTS (
                  SELECT 1 FROM event_group_freeze f
                   WHERE f.event_id = t.event_id AND f.group_id = t.group_id
                     AND f.released_at IS NULL
                )
                AND (
                  eg.poc_user_id = $1
                  OR EXISTS (
                    SELECT 1 FROM production_dept_member pdm
                     WHERE pdm.production_id = t.production_id
                       AND pdm.dept_id = eg.poc_dept_id
                       AND pdm.user_id = $1 AND pdm.is_poc = true
                  )
                )
              )
            )
          )
        )
      ORDER BY t.id`,
    params,
  );
  return res.rows.map(row => row.id);
}
