import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { isGovernanceNodeKey } from "@/lib/grant-template";
import { resolveTemplate } from "@/lib/production-template";
import { roleKeys as templateRoleKeys } from "@/lib/template-seeders/roles";
import { makeProduction, cleanupProduction } from "./factories";

/**
 * 角色模板 seed 对齐（2026-08-17）。
 *
 * 线上 grant_template 有 69 行从没进过 db/——历次线上清理手工配的。后果是
 * **新建演出的创作组开箱即残**：编剧连剧本的 blocks@edit 都没有，
 * 激活面修好了也没有区间可激活。这组测试盯的就是「新建演出的角色能不能
 * 开箱即用」，而不只是模板表里有没有那几行。
 */

let prodId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

/** 演出创建时角色就该 seed 好——这里查的是真实路径的产物，不是手工补的。 */
async function roleKeys(name: string): Promise<string[]> {
  const { rows } = await getPool().query<{ permission_key: string }>(
    `SELECT prp.permission_key
     FROM production_role pr
     JOIN production_role_permission prp ON prp.role_id = pr.id
     WHERE pr.production_id = $1 AND pr.name = $2`,
    [prodId, name],
  );
  return rows.map(r => r.permission_key);
}

describe("invariance verification", () => {
  // 不变量：模板行 → 演出创建 → 角色区间，这条链的产物必须能让人干活
  it("编剧拿得到剧本写权限与场次字段权限", async () => {
    const keys = await roleKeys("编剧");
    for (const need of [
      "node:script/*/blocks@view",
      "node:script/*/blocks@edit",
      "node:script/*/rehearsal_marks@create",
      "node:script/*/mounts@create",
      "node:scene/*@create",
      "node:scene/*@delete",
      "node:scene/*/meta/name@edit",       // 构作编辑 + 紧凑排版的同一把钥匙
      "node:scene/*/synopsis@edit",
      "node:character/*@edit",
      "node:tag_group/*@create",
    ]) {
      expect(keys).toContain(need);
    }
  });

  it("戏剧构作拿得到场次字段权限", async () => {
    const keys = await roleKeys("戏剧构作");
    for (const need of [
      "node:scene/*/meta/name@edit",
      "node:scene/*/meta/type@edit",
      "node:scene/*/meta/expected_duration@edit",
      "node:scene/*/synopsis@edit",
      "node:scene/*@edit",
      "node:character/*@edit",
    ]) {
      expect(keys).toContain(need);
    }
  });

  it("导演 / 作曲各拿到自己那一列的字段权限，不越界", async () => {
    const director = await roleKeys("导演");
    expect(director).toContain("node:scene/*/action_line@edit");
    expect(director).toContain("node:scene/*/music@edit");
    // 导演不改场次名 / 不建删场次——那是编剧与构作的活
    expect(director).not.toContain("node:scene/*/meta/name@edit");
    expect(director).not.toContain("node:scene/*@delete");

    const composer = await roleKeys("作曲");
    expect(composer).toContain("node:scene/*/music@edit");
    expect(composer).not.toContain("node:scene/*/synopsis@edit");
  });

  it("制作助理拿得到公告 / 里程碑管理权", async () => {
    const keys = await roleKeys("制作助理");
    for (const need of [
      "node:announcement/*@create",
      "node:announcement/*@edit",
      "node:announcement/*@delete",
      "node:milestone/*@create",
      "node:task/*@view",
    ]) {
      expect(keys).toContain(need);
    }
  });

  it("全员基线（'*' 模板）随任何角色一起落地", async () => {
    const keys = await roleKeys("音响设计");
    for (const need of [
      "node:script/*/blocks@view",
      "node:scene/*/meta@view",
      "node:character/*/meta@view",
      "node:asset/*/meta@view",
      "node:member/*/meta@view",
      "node:announcement/*@view",
    ]) {
      expect(keys).toContain(need);
    }
  });
});

// 原 integrity 层「重复执行不产生重复行」随 grant_template 退役（#163）：那支迁移的
// 目标表已不存在，幂等性无从谈起。模版侧的等价保障在 production-template.test.ts
// 「幂等：重复应用同一模版不产生重复行」。

// 模板源已从 grant_template 表搬进项目模版常量（#163），这两条改查常量。
describe("schema verification", () => {
  const template = resolveTemplate(null);

  it("错配键 node:scene/*/meta@edit 不会随模板复活", () => {
    for (const role of ["编剧", "戏剧构作"]) {
      expect(templateRoleKeys(template.roles, role)).not.toContain("node:scene/*/meta@edit");
    }
  });

  it("模板键全是合法节点串或通配区间键（无遗留原子键）", () => {
    const all = [
      ...template.roles.baseline,
      ...Object.values(template.roles.permissions).flat(),
      ...Object.values(template.deptPermissions).flat(),
    ];
    expect(all.filter(k => isGovernanceNodeKey(k) === null)).toEqual([]);
  });
});
