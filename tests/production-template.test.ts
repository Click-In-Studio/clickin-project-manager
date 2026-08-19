/**
 * 项目模版基建（#163）。三层：
 *   ① 棘轮——仓库里的模版常量必须全部通过校验（错了在 CI 红，不是在建项目时炸）
 *   ② 反例——每一类校验都必须真的会红（否则棘轮是摆设）
 *   ③ 应用——名字→id 的跨 slot 解析、事务、以及「本 PR 行为等价于旧建项目路径」
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "./factories";
import {
  PRODUCTION_TEMPLATES, TEMPLATE_BY_TYPE, DEFAULT_TEMPLATE_KEY,
  resolveTemplate, validateTemplate, validateAllTemplates, applyTemplate,
  type ProductionTemplate,
} from "@/lib/production-template";
import { ROLE_NAMES } from "@/lib/permissions";
import { DEFAULT_CUE_TEMPLATE_TYPES } from "@/lib/cue-list-types";
import { POLICY_KEYS } from "@/lib/policy-keys";

const EMPTY: ProductionTemplate = {
  key: "test-empty", label: "测试空模版",
  roles: [], deptTree: [], deptPermissions: {},
  cueTemplateTypes: [], cueDeclarations: [], policies: {},
  approval: { ttlHours: 24 },
};

describe("① 棘轮：仓库内的模版常量", () => {
  it("全部通过校验", () => {
    expect(validateAllTemplates()).toEqual([]);
  });

  it("类型映射指向存在的模版，且默认模版存在", () => {
    for (const key of Object.values(TEMPLATE_BY_TYPE)) {
      expect(PRODUCTION_TEMPLATES[key]).toBeDefined();
    }
    expect(PRODUCTION_TEMPLATES[DEFAULT_TEMPLATE_KEY]).toBeDefined();
  });

  it("未映射的类型（含 null）回落默认模版——类型是模版的唯一入口", () => {
    expect(resolveTemplate(null).key).toBe(DEFAULT_TEMPLATE_KEY);
    expect(resolveTemplate("类型-不存在").key).toBe(DEFAULT_TEMPLATE_KEY);
  });
});

describe("② 反例：每一类校验都必须真的会红", () => {
  const bad = (patch: Partial<ProductionTemplate>) => validateTemplate({ ...EMPTY, ...patch });

  it("部门静态键引用了树里没有的部门", () => {
    expect(bad({ deptPermissions: { 幽灵部门: ["node:asset/*@create"] } }).join()).toMatch(/幽灵部门/);
  });

  it("治理键不得进模版", () => {
    const errs = bad({
      deptTree: [{ name: "管理组" }],
      deptPermissions: { 管理组: ["node:production/*/grants@edit"] },
    });
    expect(errs.join()).toMatch(/治理键/);
  });

  it("权限键本身不合法", () => {
    const errs = bad({
      deptTree: [{ name: "管理组" }],
      deptPermissions: { 管理组: ["asset@create"] },
    });
    expect(errs.join()).toMatch(/不合法/);
  });

  it("部门名在树内重复（重名则无法按名字寻址）", () => {
    const errs = bad({ deptTree: [{ name: "音响", children: [{ name: "音响" }] }] });
    expect(errs.join()).toMatch(/重复/);
  });

  it("cue 声明引用了未注册的模版类型 / 不存在的部门 / 非法相对键", () => {
    const errs = bad({
      deptTree: [{ name: "音响设计" }],
      cueTemplateTypes: [{ key: "音效", abbrHint: "SQ", creatorRoles: [] }],
      cueDeclarations: [
        { dept: "音响设计", template: "不存在的类型" },
        { dept: "不存在的部门", template: "音效" },
        { dept: "音响设计", template: "音效", permissions: ["cues@fly"] },
      ],
    });
    expect(errs.join()).toMatch(/未注册的模版类型/);
    expect(errs.join()).toMatch(/树里没有的部门/);
    expect(errs.join()).toMatch(/相对键不合法/);
  });

  it("同一 (部门, 类型) 声明两行（DB UNIQUE 会静默吃掉后一行）", () => {
    const errs = bad({
      deptTree: [{ name: "音响设计" }],
      cueTemplateTypes: [{ key: "音效", abbrHint: "SQ", creatorRoles: [] }],
      cueDeclarations: [
        { dept: "音响设计", template: "音效", canCreate: true },
        { dept: "音响设计", template: "音效", permissions: ["@view"] },
      ],
    });
    expect(errs.join()).toMatch(/声明行重复/);
  });

  it("策略键未知 / 取值非法", () => {
    const known = POLICY_KEYS[0].key;
    const errs = bad({ policies: { "policy.不存在的键": "on", [known]: "不合法的值" } });
    expect(errs.join()).toMatch(/未知策略键/);
    expect(errs.join()).toMatch(/不接受取值/);
  });

  it("角色名重复 / 为空", () => {
    expect(bad({ roles: ["导演", "导演"] }).join()).toMatch(/重复/);
    expect(bad({ roles: [" "] }).join()).toMatch(/不能为空/);
  });

  it("审批 TTL 越界", () => {
    expect(bad({ approval: { ttlHours: 0 } }).join()).toMatch(/720/);
    expect(bad({ approval: { ttlHours: 721 } }).join()).toMatch(/720/);
  });
});

describe("③ 应用：建项目走模版", () => {
  let prodId: string;

  beforeAll(async () => {
    ({ prodId } = await makeProduction());
  });

  afterAll(async () => {
    await cleanupProduction(prodId).catch(() => {});
  });

  it("默认模版的初始状态等价于旧建项目路径", async () => {
    const pool = getPool();
    const [roles, cueTypes, policies, approval, depts] = await Promise.all([
      pool.query("SELECT 1 FROM production_role WHERE production_id = $1", [prodId]),
      pool.query("SELECT 1 FROM production_cue_template_type WHERE production_id = $1", [prodId]),
      pool.query("SELECT 1 FROM production_policy WHERE production_id = $1", [prodId]),
      pool.query<{ ttl_hours: number }>(
        "SELECT ttl_hours FROM production_approval_config WHERE production_id = $1", [prodId]),
      pool.query("SELECT 1 FROM production_dept WHERE production_id = $1", [prodId]),
    ]);
    expect(roles.rowCount).toBe(ROLE_NAMES.length);
    expect(cueTypes.rowCount).toBe(DEFAULT_CUE_TEMPLATE_TYPES.length);
    // 落全量、不稀疏（#236）：缺行回落代码默认会让改默认值静默改变存量演出行为
    expect(policies.rowCount).toBe(POLICY_KEYS.length);
    expect(approval.rows[0].ttl_hours).toBe(24);
    // 当前通用模版不带部门树（内容待业务侧定稿；机制已在位）
    expect(depts.rowCount).toBe(0);
  });

  it("角色权限键随角色名从 grant_template 灌入", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM production_role_permission prp
       JOIN production_role pr ON pr.id = prp.role_id
       WHERE pr.production_id = $1`,
      [prodId],
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it("跨 slot 的名字引用在 seed 期解析成 id：部门树 → 静态键 / cue 声明", async () => {
    const pool = getPool();
    const { prodId: id } = await makeProduction();
    try {
      await applyTemplate(id, {
        ...EMPTY, key: "test-tree",
        deptTree: [
          { name: "设计组", children: [{ name: "音响设计" }, { name: "灯光设计" }] },
          { name: "执行组", children: [{ name: "音响部" }] },
          { name: "临时组", kind: "group" },
        ],
        deptPermissions: { 设计组: ["node:asset/*@create"], 音响设计: ["node:scene/*/mounts@create"] },
        cueTemplateTypes: [{ key: "音效", abbrHint: "SQ", creatorRoles: [] }],
        cueDeclarations: [
          { dept: "音响设计", template: "音效", canCreate: true, permissions: ["@view", "cues@create"] },
          { dept: "音响部", template: "音效", permissions: ["@view"] },
        ],
      });

      const depts = await pool.query<{ id: string; name: string; parent_id: string | null; kind: string; display_order: number }>(
        "SELECT id, name, parent_id, kind, display_order FROM production_dept WHERE production_id = $1", [id]);
      const byName = new Map(depts.rows.map(d => [d.name, d]));
      expect(depts.rowCount).toBe(6);
      expect(byName.get("音响设计")!.parent_id).toBe(byName.get("设计组")!.id);
      expect(byName.get("音响部")!.parent_id).toBe(byName.get("执行组")!.id);
      expect(byName.get("设计组")!.parent_id).toBeNull();
      expect(byName.get("临时组")!.kind).toBe("group");
      // 同层 display_order 按数组序
      expect(byName.get("音响设计")!.display_order).toBe(1);
      expect(byName.get("灯光设计")!.display_order).toBe(2);

      const perms = await pool.query<{ dept_id: string; permission_key: string }>(
        "SELECT dept_id, permission_key FROM production_dept_permission WHERE production_id = $1", [id]);
      expect(perms.rows).toHaveLength(2);
      expect(perms.rows.find(r => r.permission_key === "node:asset/*@create")!.dept_id)
        .toBe(byName.get("设计组")!.id);
      expect(perms.rows.find(r => r.permission_key === "node:scene/*/mounts@create")!.dept_id)
        .toBe(byName.get("音响设计")!.id);

      const decls = await pool.query<{ dept_id: string; template: string; can_create: boolean; permissions: string[] }>(
        "SELECT dept_id, template, can_create, permissions FROM dept_cue_list_template WHERE production_id = $1", [id]);
      const design = decls.rows.find(r => r.dept_id === byName.get("音响设计")!.id)!;
      const crew = decls.rows.find(r => r.dept_id === byName.get("音响部")!.id)!;
      expect(design.can_create).toBe(true);
      expect(design.permissions.sort()).toEqual(["@view", "cues@create"].sort());
      // 受益不建表：执行侧只拿 view，can_create 必须是 false
      expect(crew.can_create).toBe(false);
    } finally {
      await cleanupProduction(id).catch(() => {});
    }
  });

  it("幂等：重复应用同一模版不产生重复行、不报错", async () => {
    const pool = getPool();
    const { prodId: id } = await makeProduction();
    try {
      const template: ProductionTemplate = {
        ...EMPTY, key: "test-idem",
        roles: ["导演"],
        deptTree: [{ name: "创作组", children: [{ name: "剧本部门" }] }],
        deptPermissions: { 创作组: ["node:asset/*@create"] },
        cueTemplateTypes: [{ key: "音效", abbrHint: "SQ", creatorRoles: [] }],
        cueDeclarations: [{ dept: "剧本部门", template: "音效", permissions: ["@view"] }],
      };
      await applyTemplate(id, template);
      await applyTemplate(id, template);
      const counts = await Promise.all([
        pool.query("SELECT 1 FROM production_dept WHERE production_id = $1", [id]),
        pool.query("SELECT 1 FROM production_dept_permission WHERE production_id = $1", [id]),
        pool.query("SELECT 1 FROM dept_cue_list_template WHERE production_id = $1", [id]),
      ]);
      expect(counts.map(c => c.rowCount)).toEqual([2, 1, 1]);
    } finally {
      await cleanupProduction(id).catch(() => {});
    }
  });

  it("整体事务：任一 slot 失败则一行都不留", async () => {
    const pool = getPool();
    const { prodId: id } = await makeProduction();
    try {
      await expect(applyTemplate(id, {
        ...EMPTY, key: "test-rollback",
        deptTree: [{ name: "会建出来的部门" }],
        // 校验期能挡住这种载荷，但 seed 期的兜底必须也是「炸掉事务」而不是静默少发
        cueDeclarations: [{ dept: "不存在的部门", template: "音效" }],
      })).rejects.toThrow();
      const { rowCount } = await pool.query(
        "SELECT 1 FROM production_dept WHERE production_id = $1 AND name = $2",
        [id, "会建出来的部门"],
      );
      expect(rowCount).toBe(0);
    } finally {
      await cleanupProduction(id).catch(() => {});
    }
  });

  it("策略覆盖只改初始档位，且仍落全量键", async () => {
    const pool = getPool();
    const { prodId: id } = await makeProduction();
    try {
      // makeProduction 已落过全量默认行 → 覆盖对已有行无效（ON CONFLICT DO NOTHING），
      // 这正是「物化那一刻冻结」的语义：改的是**新演出**的初始值，不回溯。
      const key = POLICY_KEYS.find(d => d.values.length > 1)!;
      const other = key.values.find(v => v !== key.defaultValue)!;
      const { rows: before } = await pool.query<{ value: string }>(
        "SELECT value FROM production_policy WHERE production_id = $1 AND policy_key = $2", [id, key.key]);
      expect(before[0].value).toBe(key.defaultValue);

      await pool.query("DELETE FROM production_policy WHERE production_id = $1 AND policy_key = $2", [id, key.key]);
      await applyTemplate(id, { ...EMPTY, key: "test-policy", policies: { [key.key]: other } });

      const { rows: after } = await pool.query<{ value: string }>(
        "SELECT value FROM production_policy WHERE production_id = $1 AND policy_key = $2", [id, key.key]);
      expect(after[0].value).toBe(other);
      const all = await pool.query("SELECT 1 FROM production_policy WHERE production_id = $1", [id]);
      expect(all.rowCount).toBe(POLICY_KEYS.length);
    } finally {
      await cleanupProduction(id).catch(() => {});
    }
  });
});
