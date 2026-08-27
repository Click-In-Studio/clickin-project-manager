/**
 * character 域门快照的 DB 层。纯层（类型 / 折行 / 谓词）在
 * lib/character-perms-shared.ts —— 客户端组件从那里 import，避免把 pg 拖进浏览器包。
 *
 * 判定端三条路由分别查三枚不同的键：
 *   POST   /api/production/[id]/characters          → character/*@create
 *   PATCH  /api/production/[id]/characters/[charId] → character/<charId>/*@edit
 *   DELETE /api/production/[id]/characters/[charId] → character/<charId>/*@delete
 *
 * 实例级行也要收：判定端 PATCH/DELETE 查的是 `resource_id IN (charId, '*')`，
 * 权限中心的键选择器又允许把 id 位指到具体角色（lib/resource-directory.ts）。
 */
import { getPool } from "./pg";
import { characterPermsFromRows, ALL_CHARACTER_PERMS, type CharacterPerms } from "./character-perms-shared";

export * from "./character-perms-shared";

type GrantRow = { resource_id: string; resource_sub: string; permission_level: string };

export async function getCharacterPerms(
  userId: string,
  productionId: string,
  bypass: boolean,
): Promise<CharacterPerms> {
  if (bypass) return ALL_CHARACTER_PERMS;

  const { rows } = await getPool().query<GrantRow>(
    `SELECT resource_id, resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2 AND resource_type = 'character'
       AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId],
  );
  return characterPermsFromRows(rows);
}
