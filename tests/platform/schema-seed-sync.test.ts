import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { PRODUCTION_TEMPLATES } from "@/lib/production-template";
import { THEATRE_TEMPLATE } from "@/lib/templates/theatre";

/**
 * 模板 seed 的防漂移棘轮。
 *
 * 原形态盯的是「schema.sql 与 seed 迁移文件的两份拷贝不许分叉」。grant_template
 * 退役后（#163）模板只剩一个源——项目模版常量，两份拷贝的问题消失，但**历史 seed
 * 文件里配过的东西有没有在收编时掉进缝里**这个问题还在，而且更要紧：那 69 行手工
 * 配置正是从这里回到仓库的（线上有、仓库无 → 新建演出的创作组开箱即残）。
 *
 * 所以棘轮转向：seed 文件里的每一对 (role_name, permission_key)，都必须在戏剧类
 * 模版里找得到。反向不要求相等——模版还含历次批次的 seed 与后续新增。
 */

const SEED_FILES = [
  "db/migrate-role-template-seed.sql",
  "db/migrate-scene-field-gates.sql",
];

/** 抽出 grant_template 的 (role, key) 对，覆盖 VALUES 与 CROSS JOIN 两种写法。 */
function extractTemplatePairs(sql: string): Set<string> {
  const pairs = new Set<string>();

  // 形态一：INSERT ... VALUES ('角色', 'node:...')
  for (const m of sql.matchAll(/\('([^']+)',\s*'(node:[^']+)'\)/g)) {
    pairs.add(`${m[1]}|${m[2]}`);
  }

  // 形态二：FROM (VALUES ('角色'), ...) AS r(name), (VALUES ('node:...'), ...) AS k(key)
  //         —— 角色列表 × 键列表的笛卡尔积
  for (const m of sql.matchAll(
    /FROM\s*\(VALUES([\s\S]*?)\)\s*AS\s+r\(name\),\s*\(VALUES([\s\S]*?)\)\s*AS\s+k\(key\)/g,
  )) {
    const roles = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const keys = [...m[2].matchAll(/'(node:[^']+)'/g)].map((x) => x[1]);
    for (const role of roles) for (const key of keys) pairs.add(`${role}|${key}`);
  }

  return pairs;
}

/** 有意不搬的两个角色：复合职位已由 migrate-assistant-roles.sql 拆成 base role + tag，
 *  它们不在任何模版的角色名单里，模板行是发不出去的死键。 */
const INTENTIONALLY_DROPPED = ["副导演", "助理舞台监督"];

describe("项目模版收下了历史 seed 的全部模板行", () => {
  const templatePairs = new Set<string>();
  for (const role of THEATRE_TEMPLATE.roles.names) {
    for (const key of THEATRE_TEMPLATE.roles.permissions[role] ?? []) templatePairs.add(`${role}|${key}`);
  }
  for (const key of THEATRE_TEMPLATE.roles.baseline) templatePairs.add(`*|${key}`);

  it.each(SEED_FILES)("%s 的模板行都在戏剧类模版里", (file) => {
    const sql = readFileSync(file, "utf8");
    const pairs = extractTemplatePairs(sql);
    // 迁移文件里可能只有 DELETE 没有 INSERT，那种情况下无对可查
    const missing = [...pairs].filter(
      (p) => !templatePairs.has(p) && !INTENTIONALLY_DROPPED.includes(p.split("|")[0]),
    );
    expect(missing).toEqual([]);
  });

  it("被迁移清除的错配键不该在任何模版里复活", () => {
    // migrate-scene-field-gates.sql 删掉了 node:scene/*/meta@edit
    const all = Object.values(PRODUCTION_TEMPLATES).flatMap((t) => [
      ...t.roles.baseline,
      ...Object.values(t.roles.permissions).flat(),
      ...Object.values(t.deptPermissions).flat(),
    ]);
    expect(all).not.toContain("node:scene/*/meta@edit");
  });

  it("seed 文件解析出的对不为空（防止正则失配导致空断言通过）", () => {
    const pairs = extractTemplatePairs(readFileSync("db/migrate-role-template-seed.sql", "utf8"));
    expect(pairs.size).toBe(69);
  });
});
