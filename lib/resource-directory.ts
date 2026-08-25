/**
 * 资源实例名录：`resource_type → (id → 名称)`。
 *
 * 原本只长在 `app/api/production/[id]/resource-directory/route.ts` 里，服务权限键选择器的
 * id 位下拉。#274 起权限中心也要它——折叠起来的实例行得显示「Cue 表『LQ 灯光』」而不是
 * 一串 UUID。抄一份查询就会漂，故上移到这里，两处同源。
 *
 * 只回 id + 名称，无内容字段。调用方负责门（两处都要求管理面资格）。
 * **wiki 不在本表**：默认隐私，标题会沿可见性流出，必须按调用者过滤（见路由里的特例）。
 */
import { getPool } from "./pg";

export const RESOURCE_DIRECTORY_QUERIES: Record<string, string> = {
  cue_list: "SELECT id, COALESCE(name, id) AS label FROM cue_list WHERE production_id = $1 ORDER BY created_at",
  event: "SELECT id, COALESCE(title, id) AS label FROM production_event WHERE production_id = $1 ORDER BY created_at DESC",
  asset: "SELECT id, COALESCE(name, file_name) AS label FROM asset WHERE production_id = $1 ORDER BY created_at DESC",
  milestone: "SELECT id, COALESCE(name, id) AS label FROM milestone WHERE production_id = $1 ORDER BY end_date",
  phase: "SELECT id, COALESCE(name, id) AS label FROM phase WHERE production_id = $1 ORDER BY start_date, sort_order",
  material: `SELECT id::text AS id, (code || ' ' || name) AS label FROM production_material
             WHERE production_id = $1 ORDER BY category, code`,
  // 权限键的 id 位指向预算科目——「只能看/管舞美那一档预算」是真实需求
  finance: `SELECT id::text AS id, name AS label FROM production_budget_category
            WHERE production_id = $1 ORDER BY order_index, name`,
  announcement: "SELECT id, COALESCE(title, id) AS label FROM production_announcement WHERE production_id = $1 ORDER BY created_at DESC",
  dept: "SELECT id::text AS id, name AS label FROM production_dept WHERE production_id = $1 ORDER BY display_order, name",
  role: "SELECT id, name AS label FROM production_role WHERE production_id = $1 AND NOT is_deprecated ORDER BY name",
  member: `SELECT pm.user_id::text AS id, COALESCE(up.name, pm.user_id::text) AS label
           FROM production_member pm LEFT JOIN user_profile up ON up.user_id = pm.user_id
           WHERE pm.production_id = $1 AND pm.status = 'active'
           ORDER BY up.name NULLS LAST`,
  scene: `SELECT s.id, COALESCE(sv.name, s.id) AS label
          FROM scene s
          LEFT JOIN scene_version sv ON sv.scene_id = s.id
            AND sv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
          WHERE s.production_id = $1 ORDER BY sv.name NULLS LAST`,
  character: `SELECT c.id, COALESCE(cv.name, c.id) AS label
              FROM character c
              LEFT JOIN character_version cv ON cv.character_id = c.id
                AND cv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
              WHERE c.production_id = $1 ORDER BY cv.name NULLS LAST`,
  task: `SELECT etr.id, COALESCE(etr.title, etr.id) AS label
         FROM task etr
         WHERE etr.production_id = $1 ORDER BY etr.id DESC`,
  // 只列项目级（B 型）组：A 型组绑死在某个 event 上，不该出现在项目级权限键的 id 位
  user_group: `SELECT id::text AS id, name AS label FROM event_group
               WHERE production_id = $1 AND event_id IS NULL ORDER BY order_index, name`,
};

/** 指定类型的 id → 名称。未支持的类型返回空 Map（调用方回落显示 id）。 */
export async function resourceLabels(
  productionId: string,
  resourceType: string,
): Promise<Map<string, string>> {
  const sql = RESOURCE_DIRECTORY_QUERIES[resourceType];
  if (!sql) return new Map();
  const { rows } = await getPool().query<{ id: string; label: string }>(sql, [productionId]);
  return new Map(rows.map((r) => [r.id, r.label]));
}
