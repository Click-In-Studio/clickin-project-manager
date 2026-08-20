/**
 * 项目模版 · 角色 slot（见 `lib/production-template.ts` 文件头）。
 *
 * 承载三样东西：建哪些 `production_role` 行、全员基线键、逐角色的额外键。
 *
 * ## 为什么基线和角色键必须在模版里，不能留在 `grant_template`
 *
 * 那张表的取数（`templateKeysForRole`）是**并集**：per-type 行 ∪ 通用行，`NOT EXISTS`
 * 只去重完全相同的 `(role, key)`。也就是说 per-type **只能加，不能减**。而多套模版要求：
 *
 *   - 同名岗位不同等级——「作曲」在音乐剧与在音乐专辑里是两套权限，不是包含关系
 *   - 基线本身要分叉——影视类要求 script / cue 非必要不授予，得**削**基线
 *
 * 两件事都是减法，那张表表达不了。故收编，`grant_template` 随之退役
 * （`db/migrate-retire-grant-template.sql`）。
 *
 * ## 基线是合并进每个角色的行集，不是单独一层
 *
 * 沿用 `grant_template` 的既有语义（`role_name IN ($1, '*')`）：每个角色拿到
 * 基线 ∪ 自己的键。推论——**无角色成员拿到零**。这不是 bug：影视类正是靠它实现
 * 「有 role 才看得见素材列表，没 role 什么都看不到」。
 */
import type { SeedContext, TemplateSeeder } from "../production-template";
import { isGovernanceNodeKey } from "../grant-template";

export type RolesPayload = {
  /** 建哪些 production_role 行。 */
  names: readonly string[];
  /** 全员基线（原 grant_template 的 `'*'` 行）：合并进**每个**角色的行集。 */
  baseline: readonly string[];
  /** 角色名 → 该角色在基线之外的键。未列出的角色 = 零行（只有基线）。 */
  permissions: Readonly<Record<string, readonly string[]>>;
};

function checkKeys(where: string, keys: readonly string[]): string[] {
  const errors: string[] = [];
  for (const key of keys) {
    const governance = isGovernanceNodeKey(key);
    if (governance === null) errors.push(`${where}：权限键不合法 ${key}`);
    // 治理段不进任何模版——三态语义要求它由 owner 按需显式发放。
    // 制作人的 node:*/*@* 全集不在此列：type 通配不穿透治理域（RESERVED_TYPES）。
    else if (governance) errors.push(`${where}：治理键不得进模版 ${key}`);
  }
  return errors;
}

export const rolesSeeder: TemplateSeeder<RolesPayload> = {
  slot: "roles",
  label: "角色与权限键",

  provides: ({ names }) => ({ role: names }),

  validate({ names, baseline, permissions }) {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.trim()) { errors.push("角色名不能为空"); continue; }
      if (seen.has(name)) errors.push(`角色名重复：${name}`);
      seen.add(name);
    }
    errors.push(...checkKeys("基线", baseline));
    for (const [role, keys] of Object.entries(permissions)) {
      // 拼错的角色名会变成一组**永远发不出去**的死键，静默无声——挡在这里
      if (!seen.has(role)) errors.push(`权限键挂在名单外的角色上：${role}`);
      errors.push(...checkKeys(role, keys));
    }
    return errors;
  },

  async seed({ names, baseline, permissions }: RolesPayload, ctx: SeedContext) {
    for (const name of names) {
      // id 形态与此前的 seedProductionRoles 保持一致（存量演出的 role id 就长这样）
      const id = `r_${ctx.productionId}_${encodeURIComponent(name)}`;
      const ins = await ctx.db.query<{ id: string }>(
        `INSERT INTO production_role (id, production_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (production_id, name) DO NOTHING
         RETURNING id`,
        [id, ctx.productionId, name],
      );
      const roleId = ins.rows[0]?.id ?? (
        await ctx.db.query<{ id: string }>(
          "SELECT id FROM production_role WHERE production_id = $1 AND name = $2",
          [ctx.productionId, name],
        )
      ).rows[0].id;

      const keys = roleKeys({ names, baseline, permissions }, name);
      if (keys.length > 0) {
        await ctx.db.query(
          `INSERT INTO production_role_permission (role_id, permission_key)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [roleId, keys],
        );
      }
      ctx.register("role", name, roleId);
    }
  },
};

/** 一个角色最终拿到的键集 = 基线 ∪ 自己的键。项目内**后建**的自定义角色也走这里
 *  （`createProductionRole`）：名字对得上就拿模版那份，对不上就只有基线。 */
export function roleKeys(payload: RolesPayload, roleName: string): string[] {
  return [...new Set([...payload.baseline, ...(payload.permissions[roleName] ?? [])])];
}
