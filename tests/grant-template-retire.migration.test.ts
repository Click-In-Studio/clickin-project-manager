/**
 * Migration tests for migrate-retire-grant-template.sql（#163 项目模版收编）。
 *
 *   1. Schema     — grant_template 表已消失
 *   2. Integrity  — 已 seed 进各演出的 production_role_permission 行不受影响
 *                   （本迁移只删模板源，不碰实例行），且无孤儿 role_id
 *   3. Invariance — **收编等价性**：迁移前表里那份模板，必须在模版常量里一键不差地
 *                   重现。这是这支迁移唯一真正的风险面——DROP 本身不会丢业务数据，
 *                   丢的是「以后新建演出还能不能拿到同一份权限」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH,
  type GrantTemplateRetireSnapshot,
} from "./grant-template-retire-snapshot";
import { THEATRE_TEMPLATE } from "@/lib/templates/theatre";
import { roleKeys } from "@/lib/template-seeders/roles";

let snapshot: GrantTemplateRetireSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH, "utf8"),
  ) as GrantTemplateRetireSnapshot;
} catch {
  snapshot = null;
}

/**
 * 有意不搬的两个角色：`migrate-assistant-roles.sql` 已把复合职位拆成 base role + tag，
 * 它们不在任何模版的角色名单里，模板行是发不出去的死键。
 */
const INTENTIONALLY_DROPPED = ["副导演", "助理舞台监督"];

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("grant_template 表已消失", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'grant_template'
    `);
    expect(rows).toHaveLength(0);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("production_role_permission 无孤儿 role_id", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_role_permission prp
      LEFT JOIN production_role pr ON pr.id = prp.role_id
      WHERE pr.id IS NULL LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("存量演出仍持有已 seed 的角色权限行（模板源删除不回收实例行）", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM production_role_permission",
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("戏剧类模版一键不差地重现了迁移前的通用模板", () => {
    const generic = snapshot!.generic;
    const names = new Set(THEATRE_TEMPLATE.roles.names);

    // 基线：'*' 行 == 模版 baseline
    expect([...THEATRE_TEMPLATE.roles.baseline].sort())
      .toEqual([...(generic["*"] ?? [])].sort());

    for (const [roleName, keys] of Object.entries(generic)) {
      if (roleName === "*") continue;
      if (!names.has(roleName)) {
        // 名单外的角色只允许是显式登记过的那两个，多一个都要红
        expect(INTENTIONALLY_DROPPED).toContain(roleName);
        continue;
      }
      // 模版给该角色的最终键集 = 基线 ∪ 自己的键，正是旧 templateKeysForRole 的语义
      // （那条 SQL 取 role_name IN ($1, '*')）
      const expected = [...new Set([...(generic["*"] ?? []), ...keys])].sort();
      expect(roleKeys(THEATRE_TEMPLATE.roles, roleName).sort()).toEqual(expected);
    }
  });

  it.skipIf(!snapshot)("零行角色拿到的正是基线", () => {
    const generic = snapshot!.generic;
    const zeroRow = THEATRE_TEMPLATE.roles.names.filter((n) => !generic[n]);
    expect(zeroRow.length).toBeGreaterThan(0);
    for (const name of zeroRow) {
      expect(roleKeys(THEATRE_TEMPLATE.roles, name).sort())
        .toEqual([...(generic["*"] ?? [])].sort());
    }
  });

  it.skipIf(!snapshot)("没有未被搬走的 per-type 模板行", () => {
    // 线上当前为零行。若某天有了 type 专属模板又直接 DROP，就是静默丢配置——
    // 届时这条会红，提醒先把它搬进对应模版。
    expect(snapshot!.perType).toEqual([]);
  });
});
