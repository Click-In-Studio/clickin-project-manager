// wiki_entity_link 的实体侧维护——业务实体（task …）删除路径调用。
// 单独成文件而不放 links.ts：links.ts 经 asset/perm → wiki/perm 回到 ops/event-db，
// event-db 若反向 import links.ts 就成环（本仓有 Turbopack 循环依赖 TDZ 前科）。
// 这里只依赖 pg。
import type { PoolClient } from "pg";
import { getPool } from "../pg";

/** 实体本体删除时清掉指向它的全部边（body + manual）。悬空即删（node 树契约，
 *  DEV_GUIDE §13.1）：正文里的引用由 mention-resolve 呈现「#[已删除]」，但边表里的
 *  行没人会再重建它——留着只会让文档侧「关联对象」面板长期挂一颗死 chip。
 *  wiki 目标已在 node/db.ts 删壳时同款清零；task（#670）等业务实体从各自的删除
 *  路径调这里。可传事务 client 与本体删除同事务。 */
export async function clearEntityLinks(
  productionId: string, entityType: string, entityIds: readonly string[],
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<void> {
  if (entityIds.length === 0) return;
  await client.query(
    `DELETE FROM wiki_entity_link
     WHERE production_id = $1 AND entity_type = $2 AND entity_id = ANY($3::text[])`,
    [productionId, entityType, [...entityIds]],
  );
}
