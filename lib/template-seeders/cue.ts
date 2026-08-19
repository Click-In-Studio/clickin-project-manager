/**
 * 项目模版 · cue 模版体系的**初始配置**（见 `lib/production-template.ts` 文件头）。
 *
 * 注意这两个 slot 的定位：cue 模版体系（类型注册表 + 受益方声明表，#227/#271）是**演出内
 * 的业务子系统**，不是项目模版的一部分——项目模版只是在建项目那一刻替它写下初始行，
 * 之后它自治。将来 event / task / wiki 模版体系照抄这个形状：各自一个 seeder 文件，
 * 项目模版多两个字段，机制代码不动。
 */
import type { SeedContext, NameRefs, TemplateSeeder } from "../production-template";
import { isValidCueRelKey, type CueTemplateTypeSeed } from "../cue-list-types";

export type CueTypesPayload = readonly CueTemplateTypeSeed[];

export type CueDeclaration = {
  /** 部门名（模版内按名字引用，seed 时解析成 id）。 */
  dept: string;
  /** cue 模版类型 key，必须是本模版 cueTemplateTypes 里声明过的。 */
  template: string;
  /** 建表资格。 */
  canCreate?: boolean;
  /** 受益相对键（'@view' / 'cues@create' …），建表时实例化为该表的部门区间键。 */
  permissions?: readonly string[];
};

export type CueDeclarationsPayload = readonly CueDeclaration[];

export const cueTypesSeeder: TemplateSeeder<CueTypesPayload> = {
  slot: "cueTemplateTypes",
  label: "Cue 模版类型",

  provides: (types) => ({ cue_template: types.map((t) => t.key) }),

  validate(types) {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const t of types) {
      if (!t.key.trim()) { errors.push("模版类型 key 不能为空"); continue; }
      if (seen.has(t.key)) errors.push(`模版类型重复：${t.key}`);
      seen.add(t.key);
    }
    return errors;
  },

  async seed(types: CueTypesPayload, ctx: SeedContext) {
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      await ctx.db.query(
        `INSERT INTO production_cue_template_type
           (production_id, key, abbr_hint, creator_roles, display_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (production_id, key) DO NOTHING`,
        [ctx.productionId, t.key, t.abbrHint, t.creatorRoles, i + 1],
      );
    }
  },
};

export const cueDeclarationsSeeder: TemplateSeeder<CueDeclarationsPayload> = {
  slot: "cueDeclarations",
  label: "Cue 受益方声明",

  validate(rows, refs: NameRefs) {
    const errors: string[] = [];
    const depts = refs.get("dept") ?? new Set<string>();
    const types = refs.get("cue_template") ?? new Set<string>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (!depts.has(row.dept)) errors.push(`引用了树里没有的部门：${row.dept}`);
      if (!types.has(row.template)) errors.push(`引用了未注册的模版类型：${row.template}`);
      // DB 侧 UNIQUE (dept_id, template)：同一对写两行，后一行会被 ON CONFLICT 静默吃掉，
      // 模版作者看到的是「我配的权限没生效」。挡在校验期。
      const id = `${row.dept}/${row.template}`;
      if (seen.has(id)) errors.push(`声明行重复：${id}`);
      seen.add(id);
      for (const rel of row.permissions ?? []) {
        if (!isValidCueRelKey(rel)) errors.push(`${id}：相对键不合法 ${rel}`);
      }
    }
    return errors;
  },

  async seed(rows: CueDeclarationsPayload, ctx: SeedContext) {
    for (const row of rows) {
      const deptId = ctx.idOf("dept", row.dept);
      if (!deptId) throw new Error(`[cueDeclarations] 部门未建出：${row.dept}`);
      await ctx.db.query(
        `INSERT INTO dept_cue_list_template
           (production_id, dept_id, template, can_create, permissions)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (dept_id, template) DO NOTHING`,
        [
          ctx.productionId, deptId, row.template,
          row.canCreate ?? false, [...new Set(row.permissions ?? [])],
        ],
      );
      // 建项目时还没有任何 cue 表，故无需 propagateTemplateToExisting——
      // 声明行此后由权限模版页维护，改动传播是那条路的事。
    }
  },
};
