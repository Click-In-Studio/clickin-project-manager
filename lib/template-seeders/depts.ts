/**
 * 项目模版 · 部门 slot（见 `lib/production-template.ts` 文件头）。
 *
 * 两个 seeder：树本身，和挂在树上的静态区间键。分成两个 slot 是因为它们的失败模式不同
 * ——树是结构，键是资格；也因为校验期「键引用的部门名必须存在」需要树先登记名字。
 *
 * **静态区间键 ≠ 部门权限行的全部**：建 cue 表时声明行会往同一张
 * `production_dept_permission` 里实例化写入动态键（`node:cue_list/<id>/…`）。模版只管
 * 静态的那一半，两类在配置面的呈现问题见 #274。
 */
import type { SeedContext, NameRefs, TemplateSeeder } from "../production-template";
import { isGovernanceNodeKey } from "../grant-template";

export type DeptNode = {
  name: string;
  /** 'dept' = 部门（可提 notes、可作归属）；'group' = 用户组（仅选人）。默认 'dept'。 */
  kind?: "dept" | "group";
  children?: readonly DeptNode[];
};

export type DeptTreePayload = readonly DeptNode[];

/** 部门名 → 该部门的静态区间键。 */
export type DeptPermissionsPayload = Readonly<Record<string, readonly string[]>>;

function flatten(nodes: readonly DeptNode[]): DeptNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

export const deptTreeSeeder: TemplateSeeder<DeptTreePayload> = {
  slot: "deptTree",
  label: "部门树",

  provides: (tree) => ({ dept: flatten(tree).map((d) => d.name) }),

  validate(tree) {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const node of flatten(tree)) {
      if (!node.name.trim()) { errors.push("部门名不能为空"); continue; }
      // DB 唯一索引只到 (production_id, name, parent)，模版这一层要求**全树唯一**：
      // 部门静态键与 cue 声明行都按名字引用部门，重名就无法寻址。
      if (seen.has(node.name)) errors.push(`部门名在树内重复，无法按名字引用：${node.name}`);
      seen.add(node.name);
    }
    return errors;
  },

  async seed(tree: DeptTreePayload, ctx: SeedContext) {
    const insertLevel = async (nodes: readonly DeptNode[], parentId: string | null) => {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const ins = await ctx.db.query<{ id: string }>(
          `INSERT INTO production_dept (production_id, name, parent_id, kind, display_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (production_id, name, COALESCE(parent_id::text, '')) DO NOTHING
           RETURNING id`,
          [ctx.productionId, node.name, parentId, node.kind ?? "dept", i + 1],
        );
        const deptId = ins.rows[0]?.id ?? (
          await ctx.db.query<{ id: string }>(
            `SELECT id FROM production_dept
             WHERE production_id = $1 AND name = $2
               AND COALESCE(parent_id::text, '') = COALESCE($3::text, '')`,
            [ctx.productionId, node.name, parentId],
          )
        ).rows[0].id;

        ctx.register("dept", node.name, deptId);
        if (node.children?.length) await insertLevel(node.children, deptId);
      }
    };
    await insertLevel(tree, null);
  },
};

export const deptPermissionsSeeder: TemplateSeeder<DeptPermissionsPayload> = {
  slot: "deptPermissions",
  label: "部门静态区间键",

  validate(rows, refs: NameRefs) {
    const errors: string[] = [];
    const depts = refs.get("dept") ?? new Set<string>();
    for (const [deptName, keys] of Object.entries(rows)) {
      if (!depts.has(deptName)) errors.push(`引用了树里没有的部门：${deptName}`);
      for (const key of keys) {
        const governance = isGovernanceNodeKey(key);
        if (governance === null) errors.push(`${deptName}：权限键不合法 ${key}`);
        // 治理段（production / member / role / dept 管理）不进任何模版——
        // 三态语义要求它由 owner 按需显式发放（《基础模版》§3.3 原则对账）。
        else if (governance) errors.push(`${deptName}：治理键不得进模版 ${key}`);
      }
    }
    return errors;
  },

  async seed(rows: DeptPermissionsPayload, ctx: SeedContext) {
    for (const [deptName, keys] of Object.entries(rows)) {
      const deptId = ctx.idOf("dept", deptName);
      // 校验期已挡住；这里是 seed 期的兜底，宁可炸掉整个事务也不要静默少发权限行。
      if (!deptId) throw new Error(`[deptPermissions] 部门未建出：${deptName}`);
      if (keys.length === 0) continue;
      await ctx.db.query(
        `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
         SELECT $1, $2, unnest($3::text[])
         ON CONFLICT (dept_id, permission_key) DO NOTHING`,
        [ctx.productionId, deptId, [...new Set(keys)]],
      );
    }
  },
};
