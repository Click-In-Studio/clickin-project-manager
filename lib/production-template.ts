/**
 * 项目模版（#163）——建项目那一刻的初始状态，**写一次、之后零读取、永不回溯**。
 *
 * ## 与「资源模版」是两回事，别混
 *
 * Cue 表模版、将来的 event / task / wiki 模版，是**演出内的业务子系统**（类型注册表
 * ＋受益方声明表，见 #271）：跟着项目走、项目全程都在改、有自己的配置面。**即使
 * 根本没有项目模版这个东西，它们也照样成立。**
 *
 * 项目模版只是能**携带**某个子系统的初始配置（音乐剧模版自带几个 cue 类型和默认声明
 * 组）。携带 ≠ 拥有：灌进去那一刻起那些行就是项目自己的东西，项目里怎么改、加几个
 * 自定义类型，与模版再无关系；反过来改模版也永远不影响存量演出。
 *
 * ## 为什么是代码常量而不是全局表
 *
 * 谁有资格碰它？只有开发者。它什么时候要改？基建增加了配置需求 / 权限处理改了 /
 * 新功能带来独立权限键 / policy 键增删——**全是开发的事**。既然如此它就该是代码常量：
 * 改模版＝改代码＝走 PR＝有 review 有 CI 棘轮。
 *
 * `grant_template` 是反面教材：它同样是 bootstrap（运行时零读取、只在建演出时 seed），
 * 却被放进 DB 且没有界面，结果线上 108 行里 69 行仓库从没记录，新建演出的编剧连
 * `blocks@edit` 都没有，最后靠 `db/migrate-role-template-seed.sql` 把既成事实倒灌回仓库。
 * 角色权限键这一层暂时仍走那张表（本文件的 roles slot 只管角色名单），收编另起 PR。
 *
 * ## 形状：模版不认识任何子系统的语义
 *
 * 每个子系统在 `lib/template-seeders/` 下自带 seeder（校验器＋写入器），本文件只做三件事：
 * 按依赖序调用它们、把「名字 → id」的解析结果在 seeder 之间传递、整体事务。
 * 加一个新的资源模版体系 = 新增一个 seeder 文件 ＋ `ProductionTemplate` 多一个字段 ＋
 * `SEEDERS` 多一行 bind——本文件不需要理解它是什么。
 *
 * ## 跨子系统引用只能按名字
 *
 * 模版是全局常量，演出内的 id 建出来才有。所以 cue 声明行引用部门写的是「音响设计」
 * 而不是 UUID；解析只发生在 seed 那一刻（`SeedContext.idOf`），解析完即断链。
 */
import { getPool } from "./pg";
import type { Pool, PoolClient } from "pg";

import { ROLE_NAMES } from "./permissions";
import { DEFAULT_CUE_TEMPLATE_TYPES } from "./cue-list-types";

import { rolesSeeder, type RolesPayload } from "./template-seeders/roles";
import {
  deptTreeSeeder, deptPermissionsSeeder,
  type DeptTreePayload, type DeptPermissionsPayload,
} from "./template-seeders/depts";
import {
  cueTypesSeeder, cueDeclarationsSeeder,
  type CueTypesPayload, type CueDeclarationsPayload,
} from "./template-seeders/cue";
import { policySeeder, type PolicyPayload } from "./template-seeders/policy";
import { approvalSeeder, type ApprovalPayload } from "./template-seeders/approval";

// ─── seeder 契约 ──────────────────────────────────────────────────────────────

/** 名字空间 → 该空间已登记的名字集合。校验期用（此时还没有 id）。 */
export type NameRefs = ReadonlyMap<string, ReadonlySet<string>>;

export type SeedContext = {
  productionId: string;
  /** `production.type`；角色权限键仍按它查 grant_template 的 per-type 行。 */
  productionType: string | null;
  /** 整个模版应用共用一个连接 —— 全程一个事务。 */
  db: PoolClient;
  /** 前序 seeder 建出来的行的 id：名字空间 → 名字 → id。 */
  idOf(namespace: string, name: string): string | undefined;
  register(namespace: string, name: string, id: string): void;
};

export type TemplateSeeder<P> = {
  /** 进度/报错用的 slot 名（同时是错误信息前缀）。 */
  slot: string;
  label: string;
  /** 本 seeder 会建出哪些**可被后续 seeder 按名字引用**的东西。 */
  provides?(payload: P): Record<string, readonly string[]>;
  /** 静态校验：只看载荷本身与前序 slot 提供的名字。返回人话错误列表（空 = 通过）。 */
  validate(payload: P, refs: NameRefs): string[];
  seed(payload: P, ctx: SeedContext): Promise<void>;
};

/** 绑定后的 seeder：把「从模版里取哪一份载荷」的知识留在本文件，
 *  seeder 自己不需要认识 `ProductionTemplate` 的整体形状。 */
type BoundSeeder = {
  slot: string;
  label: string;
  provides(t: ProductionTemplate): Record<string, readonly string[]>;
  validate(t: ProductionTemplate, refs: NameRefs): string[];
  seed(t: ProductionTemplate, ctx: SeedContext): Promise<void>;
};

function bind<P>(seeder: TemplateSeeder<P>, pick: (t: ProductionTemplate) => P): BoundSeeder {
  return {
    slot: seeder.slot,
    label: seeder.label,
    provides: (t) => seeder.provides?.(pick(t)) ?? {},
    validate: (t, refs) => seeder.validate(pick(t), refs),
    seed: (t, ctx) => seeder.seed(pick(t), ctx),
  };
}

// ─── 模版形状 ─────────────────────────────────────────────────────────────────

export type ProductionTemplate = {
  key: string;
  label: string;
  /** ① 角色名单（权限键仍由 grant_template 按角色名灌，见文件头）。 */
  roles: RolesPayload;
  /** ② 部门树。 */
  deptTree: DeptTreePayload;
  /** ③ 部门静态区间键：部门名 → 键。 */
  deptPermissions: DeptPermissionsPayload;
  /** ④ cue 模版类型注册表（cue 模版体系的初始配置，不是项目模版的一部分）。 */
  cueTemplateTypes: CueTypesPayload;
  /** ⑤ cue 受益方声明行（同上）。 */
  cueDeclarations: CueDeclarationsPayload;
  /** ⑥ 策略键覆盖；未列出的键取 `lib/policy-keys.ts` 的代码默认。 */
  policies: PolicyPayload;
  /** ⑦ 审批 TTL。 */
  approval: ApprovalPayload;
};

/**
 * 应用顺序 = 依赖顺序。部门必须先于「部门静态键」和「cue 声明行」建出来，
 * cue 类型必须先于声明行——否则名字解析不到 id。
 */
const SEEDERS: readonly BoundSeeder[] = [
  bind(rolesSeeder, (t) => t.roles),
  bind(deptTreeSeeder, (t) => t.deptTree),
  bind(deptPermissionsSeeder, (t) => t.deptPermissions),
  bind(cueTypesSeeder, (t) => t.cueTemplateTypes),
  bind(cueDeclarationsSeeder, (t) => t.cueDeclarations),
  bind(policySeeder, (t) => t.policies),
  bind(approvalSeeder, (t) => t.approval),
];

// ─── 模版清单 ─────────────────────────────────────────────────────────────────

/**
 * 通用模版：**本 PR 是基建，这套模版的内容刻意等价于此前的建项目行为**——
 * 角色名单照旧、cue 类型照旧、策略全取代码默认、不建任何部门。
 *
 * 部门树 / 部门静态区间键 / cue 声明组的**具体内容是业务侧的事**（草案见 MindWeave
 * 《基础模版-音乐剧角色与部门》§3/§3.1/§3.2），定稿后往下面几个数组里填即可，
 * 不需要动任何机制代码。
 */
const STANDARD_TEMPLATE: ProductionTemplate = {
  key: "standard",
  label: "通用模版",
  roles: ROLE_NAMES,
  deptTree: [],
  deptPermissions: {},
  cueTemplateTypes: DEFAULT_CUE_TEMPLATE_TYPES,
  cueDeclarations: [],
  policies: {},
  approval: { ttlHours: 24 },
};

export const PRODUCTION_TEMPLATES: Readonly<Record<string, ProductionTemplate>> = {
  [STANDARD_TEMPLATE.key]: STANDARD_TEMPLATE,
};

export const DEFAULT_TEMPLATE_KEY = STANDARD_TEMPLATE.key;

/**
 * `production.type` → 模版 key。**空表 = 所有类型都回落通用模版**，这是当前的有意状态：
 * 机制在位，等业务侧定稿再加映射行。类型是模版的**唯一入口**（UX 上不给「角色用 A、
 * 部门用 B」的组合面——角色模版与部门模版并不真正正交：设计族 / 执行族 role 是零行，
 * 职能全压在部门声明上，拆开组合会配出设计师什么都干不了的项目）。
 */
export const TEMPLATE_BY_TYPE: Readonly<Record<string, string>> = {};

export function resolveTemplate(productionType: string | null | undefined): ProductionTemplate {
  const key = (productionType && TEMPLATE_BY_TYPE[productionType]) || DEFAULT_TEMPLATE_KEY;
  return PRODUCTION_TEMPLATES[key] ?? PRODUCTION_TEMPLATES[DEFAULT_TEMPLATE_KEY];
}

// ─── 校验（CI 棘轮用；模版是常量，错了应该在 CI 红，不是在建项目时炸）──────────

/** 逐 slot 按序校验：每个 seeder 只看得到**前序** slot 提供的名字，
 *  与 seed 时的解析顺序一致——校验通过就意味着 seed 期不会有解析不到的名字。 */
export function validateTemplate(t: ProductionTemplate): string[] {
  const errors: string[] = [];
  const refs = new Map<string, Set<string>>();
  for (const seeder of SEEDERS) {
    for (const e of seeder.validate(t, refs)) errors.push(`[${t.key}/${seeder.slot}] ${e}`);
    for (const [ns, names] of Object.entries(seeder.provides(t))) {
      const set = refs.get(ns) ?? new Set<string>();
      for (const n of names) set.add(n);
      refs.set(ns, set);
    }
  }
  return errors;
}

export function validateAllTemplates(): string[] {
  const errors = Object.values(PRODUCTION_TEMPLATES).flatMap(validateTemplate);
  for (const [type, key] of Object.entries(TEMPLATE_BY_TYPE)) {
    if (!PRODUCTION_TEMPLATES[key]) errors.push(`[TEMPLATE_BY_TYPE] 类型 ${type} 指向不存在的模版 ${key}`);
  }
  if (!PRODUCTION_TEMPLATES[DEFAULT_TEMPLATE_KEY]) {
    errors.push(`[TEMPLATE_BY_TYPE] 默认模版 ${DEFAULT_TEMPLATE_KEY} 不存在`);
  }
  return errors;
}

// ─── 应用 ─────────────────────────────────────────────────────────────────────

/**
 * 把模版灌进一个刚建出来的演出。整体事务：半截生效会留下一个「有部门树没权限行」
 * 或「有声明行没 cue 类型」的残项目，比建失败更难收拾。
 *
 * 幂等（各 seeder 全部 ON CONFLICT DO NOTHING）：失败重试安全。但**不是回放**——
 * 演出里被人改过的配置不会被模版重新覆盖回去。
 */
export async function applyProductionTemplate(
  productionId: string,
  productionType: string | null,
  pool: Pool = getPool(),
): Promise<void> {
  await applyTemplate(productionId, resolveTemplate(productionType), productionType, pool);
}

/** 应用**指定**模版。建项目走上面那个（类型是模版的唯一入口）；本函数供测试
 *  与将来可能的运维入口显式指定模版用。 */
export async function applyTemplate(
  productionId: string,
  template: ProductionTemplate,
  productionType: string | null = null,
  pool: Pool = getPool(),
): Promise<void> {
  const client = await pool.connect();
  const ids = new Map<string, Map<string, string>>();
  const ctx: SeedContext = {
    productionId,
    productionType,
    db: client,
    idOf: (ns, name) => ids.get(ns)?.get(name),
    register: (ns, name, id) => {
      const bucket = ids.get(ns) ?? new Map<string, string>();
      bucket.set(name, id);
      ids.set(ns, bucket);
    },
  };
  try {
    await client.query("BEGIN");
    for (const seeder of SEEDERS) await seeder.seed(template, ctx);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
