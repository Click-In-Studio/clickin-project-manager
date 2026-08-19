/**
 * 项目模版 · 角色 slot（见 `lib/production-template.ts` 文件头）。
 *
 * 本 slot 只管**角色名单**（结构性数据：建哪些 production_role 行）。每个角色的权限键
 * 仍由 `grant_template` 按角色名灌——那张表是同一层 bootstrap 但站错了边（放 DB、无界面、
 * 会漂），收编进模版常量另起 PR，本 PR 不动它。
 */
import type { SeedContext, TemplateSeeder } from "../production-template";
import { seedRoleFromTemplate } from "../grant-template";

export type RolesPayload = readonly string[];

export const rolesSeeder: TemplateSeeder<RolesPayload> = {
  slot: "roles",
  label: "角色名单",

  provides: (names) => ({ role: names }),

  validate(names) {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.trim()) { errors.push("角色名不能为空"); continue; }
      if (seen.has(name)) errors.push(`角色名重复：${name}`);
      seen.add(name);
    }
    return errors;
  },

  async seed(names: RolesPayload, ctx: SeedContext) {
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

      await seedRoleFromTemplate(roleId, name, ctx.productionType, ctx.db);
      ctx.register("role", name, roleId);
    }
  },
};
