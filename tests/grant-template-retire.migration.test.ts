/**
 * Migration tests for migrate-retire-grant-template.sql（#163 项目模版收编）。
 *
 *   1. Schema     — grant_template 表已消失
 *   2. Integrity  — 已 seed 进各演出的 production_role_permission 行不受影响
 *                   （本迁移只删模板源，不碰实例行），且无孤儿 role_id
 *   3. Invariance — **收编等价性**：迁移前表里那份模板给出的每一枚资格，都必须仍被
 *                   模版覆盖（按判定端的键形匹配，不是字符串相等——见 stillCovered）。
 *                   这是这支迁移唯一真正的风险面：DROP 本身不会丢业务数据，丢的是
 *                   「以后新建演出还能不能拿到同一份权限」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "./factories";
import {
  GRANT_TEMPLATE_RETIRE_SNAPSHOT_PATH,
  type GrantTemplateRetireSnapshot,
} from "./grant-template-retire-snapshot";
import { THEATRE_TEMPLATE } from "@/lib/templates/theatre";
import { roleKeys } from "@/lib/template-seeders/roles";
import { parseNodeKey, nodeKeyCandidates } from "@/lib/grant-template";

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

/**
 * 迁移前的某枚键，是否仍被模版给出的键集覆盖。
 *
 * **不是字符串相等**：判定端认的是「能命中该节点的任一键形」（`nodeKeyCandidates`，
 * 含通配区间）。制作人就是活例子——迁移前表里既有 G-1 的通配五行，又残留着七枚
 * 早该被收敛掉的枚举行（`migrate-producer-wildcard.sql` DELETE 了它们，但当时
 * schema.sql 的 seed 仍在，故任何从 schema.sql 新建的库都会重新长出来，而 G-1 的
 * 重放判据「已有通配主行」又让迁移不再执行）。模版只带通配五行是**终局形态**，
 * 那七枚枚举行被制作人的通配主行完全覆盖，资格一点没少。
 *
 * 本 PR 顺手清了病根：schema.sql 里的 grant_template seed 全部随表退役。
 */
function stillCovered(templateKeys: readonly string[], key: string): boolean {
  if (templateKeys.includes(key)) return true;
  const node = parseNodeKey(key);
  // 通配键（如 node:*/*@*）parseNodeKey 认不了，只能按字面比——它本身就是最宽的形态
  if (!node) return false;
  return nodeKeyCandidates(node).some((c) => templateKeys.includes(c));
}

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

  // 模板源删除不回收实例行。用工厂造自己的演出——不能对全库 count 下断言
  // （AGENTS.md：不依赖预加载数据；干净库里那个数就是 0，断言会假红）。
  it("已 seed 的角色权限行不受迁移影响，且迁移可重复执行", async () => {
    const { prodId } = await makeProduction();
    try {
      const count = async () => Number((await getPool().query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM production_role_permission prp
         JOIN production_role pr ON pr.id = prp.role_id
         WHERE pr.production_id = $1`,
        [prodId],
      )).rows[0].n);

      const before = await count();
      expect(before).toBeGreaterThan(0);

      // 幂等：DROP TABLE IF EXISTS 可重放，且重放不碰实例行
      await getPool().query(readFileSync("db/migrate-retire-grant-template.sql", "utf8"));
      expect(await count()).toBe(before);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("戏剧类模版覆盖了迁移前通用模板的每一枚键（资格不缩小）", () => {
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
      const got = roleKeys(THEATRE_TEMPLATE.roles, roleName);
      const lost = [...new Set([...(generic["*"] ?? []), ...keys])]
        .filter((k) => !stillCovered(got, k));
      expect(lost, `${roleName} 丢了资格`).toEqual([]);
    }
  });

  // 迁移前表里没有模板行的角色分两种：本来就零行的（执行族 / 卡司族），以及**本次新增**
  // 的（编舞）。两者都只要求「至少拿到基线」——新增角色比基线多给是设计，不是回归。
  it.skipIf(!snapshot)("迁移前无模板行的角色，至少拿到基线", () => {
    const generic = snapshot!.generic;
    const noRow = THEATRE_TEMPLATE.roles.names.filter((n) => !generic[n]);
    expect(noRow.length).toBeGreaterThan(0);
    for (const name of noRow) {
      const got = roleKeys(THEATRE_TEMPLATE.roles, name);
      const missing = (generic["*"] ?? []).filter((k) => !stillCovered(got, k));
      expect(missing, `${name} 少了基线键`).toEqual([]);
    }
  });

  it.skipIf(!snapshot)("没有未被搬走的 per-type 模板行", () => {
    // 线上当前为零行。若某天有了 type 专属模板又直接 DROP，就是静默丢配置——
    // 届时这条会红，提醒先把它搬进对应模版。
    expect(snapshot!.perType).toEqual([]);
  });
});
