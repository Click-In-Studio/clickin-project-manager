/**
 * character 域的门快照（与 lib/scene-field-perms.ts 同构）。
 *
 * 角色域的三个动作各有一把钥匙，而且**判定端三条路由分别查三枚不同的键**：
 *   POST   /api/production/[id]/characters          → character/*@create
 *   PATCH  /api/production/[id]/characters/[charId] → character/<id>/*@edit
 *   DELETE /api/production/[id]/characters/[charId] → character/<id>/*@delete
 *
 * 前端此前只算一枚 `character/*@edit` 当总门，用它同时决定「添加」表单、行内
 * 编辑态和「删除」按钮的显隐——与后端三选一对不上：只持 create 的人看不见添加
 * 表单，只持 edit 的人看得见删除按钮、点了 403。此处一次查询取全三枚，
 * 消费方逐枚用。
 *
 * 与 getSceneFieldPerms 同一口径：只取 `resource_id = '*'` 的域级行。实例级行
 * （resource_id = 具体 charId）不进这个快照——它是列表页的粗门，不是逐实例判定。
 */
import { getPool } from "./pg";

export type CharacterPerms = {
  create: boolean;
  edit: boolean;
  delete: boolean;
  /** 是否值得显示编辑态外壳 */
  any: boolean;
};

export const ALL_CHARACTER_PERMS: CharacterPerms = {
  create: true, edit: true, delete: true, any: true,
};

export const NO_CHARACTER_PERMS: CharacterPerms = {
  create: false, edit: false, delete: false, any: false,
};

/** 纯函数层：按 hasGrant 的 sub 匹配语义（sub ∈ {'*', 具体 sub}）折行成门。 */
export function characterPermsFromRows(
  rows: readonly { resource_sub: string; permission_level: string }[],
): CharacterPerms {
  const has = (verb: string): boolean =>
    rows.some((r) => r.resource_sub === "*" && r.permission_level === verb);
  const perms = { create: has("create"), edit: has("edit"), delete: has("delete") } as CharacterPerms;
  perms.any = perms.create || perms.edit || perms.delete;
  return perms;
}

export async function getCharacterPerms(
  userId: string,
  productionId: string,
  bypass: boolean,
): Promise<CharacterPerms> {
  if (bypass) return ALL_CHARACTER_PERMS;

  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2 AND resource_type = 'character'
       AND resource_id = '*' AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId],
  );
  return characterPermsFromRows(rows);
}
