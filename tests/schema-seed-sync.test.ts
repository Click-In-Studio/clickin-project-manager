import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * schema.sql 与 seed 迁移文件的防漂移。
 *
 * AGENTS.md：「db/schema.sql 始终是生产状态的完整快照」。模板 seed 因此有两份
 * 拷贝——`db/migrate-role-template-seed.sql`（存量库执行）与 schema.sql 里的同一段
 * （新库建库时执行）。没有任何机制拴住这两份：改了一处忘了另一处，新库与存量库
 * 的模板就会静默分叉，而这正是本次事故的成因之一（线上手工配了 69 行，仓库
 * 一无所知，新建演出的创作组开箱即残）。
 *
 * 这条测试拴住它们：seed 文件里的每一对 (role_name, permission_key) 都必须在
 * schema.sql 里出现。反向不要求相等——schema.sql 还含历次批次的 seed。
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

describe("schema.sql 是 seed 的完整快照", () => {
  const schema = readFileSync("db/schema.sql", "utf8");
  const schemaPairs = extractTemplatePairs(schema);

  it.each(SEED_FILES)("%s 的模板行都在 schema.sql 里", (file) => {
    const sql = readFileSync(file, "utf8");
    const pairs = extractTemplatePairs(sql);
    // 迁移文件里可能只有 DELETE 没有 INSERT，那种情况下无对可查
    const missing = [...pairs].filter((p) => !schemaPairs.has(p));
    expect(missing).toEqual([]);
  });

  it("被迁移清除的错配键不该留在 schema.sql 里", () => {
    // migrate-scene-field-gates.sql 删掉了 node:scene/*/meta@edit；
    // schema.sql 作为「迁移后的完整状态」不该再 seed 它
    expect(schema).not.toContain("'node:scene/*/meta@edit'");
  });

  it("seed 文件解析出的对不为空（防止正则失配导致空断言通过）", () => {
    const pairs = extractTemplatePairs(readFileSync("db/migrate-role-template-seed.sql", "utf8"));
    expect(pairs.size).toBe(69);
  });
});
