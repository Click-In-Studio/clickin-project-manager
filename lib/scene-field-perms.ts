/**
 * scene 字段门的 DB 层（2026-08-17）。类型 / 折行 / 谓词在
 * lib/scene-field-perms-shared.ts —— 客户端组件从那里 import，避免把 pg 拖进浏览器包；
 * 本模块 re-export 它，服务端调用方无需关心这层拆分。
 *
 * 总表 §0「字段写权限挂 meta 下」：scene 的每个可写字段各有一把钥匙，
 * 项目模版（原 grant_template）也是逐字段发的。这里把「字段 → 节点 sub」的映射集中一处，
 * 三个消费方共用，避免再次出现模板与判定各说各话：
 *
 *   - app/api/production/[id]/scenes/[sceneId]  构作页 REST 的逐字段门
 *   - lib/script-ops.ts                          剧本页 patch 的 marker 字段门
 *   - app/production/[id]/dramaturgy             前端按字段禁用编辑态
 *
 * 曾经这里只有一把 meta/name@edit 总钥匙，而模板发的是 synopsis@edit 之类，
 * 两边永不相交——作曲想改 music 实际要的是改名权，而改名权模板从没发过。
 */
import { getPool } from "./pg";
import { sceneFieldPermsFromRows, ALL_SCENE_FIELD_PERMS, type SceneFieldPerms, type SceneGrantRow } from "./scene-field-perms-shared";

export * from "./scene-field-perms-shared";

export async function getSceneFieldPerms(
  userId: string,
  productionId: string,
  bypass: boolean,
): Promise<SceneFieldPerms> {
  if (bypass) return ALL_SCENE_FIELD_PERMS;

  const { rows } = await getPool().query<SceneGrantRow>(
    `SELECT resource_id, resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2 AND resource_type = 'scene'
       AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId],
  );
  return sceneFieldPermsFromRows(rows);
}
