/**
 * character 域的门快照 —— 纯层（无 pg 依赖，客户端组件可直接 import）。
 *
 * 与 lib/member-status-shared.ts 同一约定：判定用的谓词要在浏览器里跑（角色页逐行
 * 算 canEdit/canDelete），而 lib/character-perms.ts 连着 pg 进不了浏览器包。
 * 谓词只写一遍，两侧同源。
 *
 * 角色域的三个动作各有一把钥匙，而且**判定端三条路由分别查三枚不同的键**：
 *   POST   /api/production/[id]/characters          → character/*@create
 *   PATCH  /api/production/[id]/characters/[charId] → character/<charId>/*@edit
 *   DELETE /api/production/[id]/characters/[charId] → character/<charId>/*@delete
 *
 * 前端此前只算一枚 `character/*@edit` 当总门，用它同时决定「添加」表单、行内
 * 编辑态和「删除」按钮的显隐——与后端三选一对不上：只持 create 的人看不见添加
 * 表单，只持 edit 的人看得见删除按钮、点了 403。
 *
 * **实例级行也要收**：判定端 PATCH/DELETE 查的是 `resource_id IN (charId, '*')`，
 * 权限中心的键选择器又允许把 id 位指到具体角色（lib/resource-directory.ts 里
 * character 有名录查询）。只读域级行会让「只授权改角色 A」的人在前端一个入口
 * 都看不到——与本模块要修的是同一类漂移，方向相反而已。
 */
export type CharacterPerms = {
  create: boolean;
  /** 域级（resource_id='*'）edit / delete —— 对所有角色生效 */
  edit: boolean;
  delete: boolean;
  /** 实例级例外：只在这些 charId 上额外持有该动词 */
  editIds: string[];
  deleteIds: string[];
  /** 是否值得显示编辑态外壳 */
  any: boolean;
};

export const ALL_CHARACTER_PERMS: CharacterPerms = {
  create: true, edit: true, delete: true, editIds: [], deleteIds: [], any: true,
};

export const NO_CHARACTER_PERMS: CharacterPerms = {
  create: false, edit: false, delete: false, editIds: [], deleteIds: [], any: false,
};

/** 逐实例判定：域级行覆盖全部角色，实例级行只覆盖它自己那一个。 */
export function canEditCharacter(perms: CharacterPerms, charId: string): boolean {
  return perms.edit || perms.editIds.includes(charId);
}

export function canDeleteCharacter(perms: CharacterPerms, charId: string): boolean {
  return perms.delete || perms.deleteIds.includes(charId);
}

type GrantRow = { resource_id: string; resource_sub: string; permission_level: string };

/**
 * 纯函数层：按 hasGrant 的匹配语义折行成门。
 *
 * 三条路由查的 sub 都是 `'*'`，而 hasGrant 对非保留段 sub 的匹配是
 * `resource_sub IN (sub, '*')`——sub 自身就是 `'*'` 时只有 `'*'` 行能命中。
 * 故此处只认 `resource_sub === '*'`：character 的 biography@view 一类的
 * 字段行不喂任何写面开关。
 */
export function characterPermsFromRows(rows: readonly GrantRow[]): CharacterPerms {
  const wildcard = rows.filter((r) => r.resource_sub === "*");
  const domain = (verb: string): boolean =>
    wildcard.some((r) => r.resource_id === "*" && r.permission_level === verb);
  const instances = (verb: string): string[] => [
    ...new Set(
      wildcard
        .filter((r) => r.resource_id !== "*" && r.permission_level === verb)
        .map((r) => r.resource_id),
    ),
  ];

  const perms: CharacterPerms = {
    create: domain("create"),
    edit: domain("edit"),
    delete: domain("delete"),
    editIds: instances("edit"),
    deleteIds: instances("delete"),
    any: false,
  };
  perms.any = perms.create || perms.edit || perms.delete
    || perms.editIds.length > 0 || perms.deleteIds.length > 0;
  return perms;
}
