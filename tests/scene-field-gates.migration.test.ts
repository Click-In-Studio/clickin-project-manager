import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import {
  SCENE_FIELD_GATES_SNAPSHOT_PATH,
  type SceneFieldGatesSnapshot,
} from "./scene-field-gates-snapshot";

// scene 字段门对齐 三层迁移测试（schema / integrity / invariance）

let snapshot: SceneFieldGatesSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(SCENE_FIELD_GATES_SNAPSHOT_PATH, "utf8"),
  ) as SceneFieldGatesSnapshot;
} catch {
  snapshot = null;
}

const FIELD_KEYS = [
  "node:scene/*/meta/name@edit",
  "node:scene/*/meta/type@edit",
  "node:scene/*/meta/expected_duration@edit",
  "node:scene/*@edit",
];

describe("schema verification", () => {
  it("编剧 / 戏剧构作模板持有四枚字段级键", async () => {
    const { rows } = await getPool().query<{ role_name: string; permission_key: string }>(
      `SELECT role_name, permission_key FROM grant_template
       WHERE role_name IN ('编剧', '戏剧构作') AND permission_key = ANY($1)`,
      [FIELD_KEYS],
    );
    for (const role of ["编剧", "戏剧构作"]) {
      const keys = rows.filter(r => r.role_name === role).map(r => r.permission_key).sort();
      expect(keys).toEqual([...FIELD_KEYS].sort());
    }
  });

  it("空转的 node:scene/*/meta@edit 在四张表里绝迹", async () => {
    const [t, r, d, m] = await Promise.all([
      getPool().query("SELECT 1 FROM grant_template WHERE permission_key = 'node:scene/*/meta@edit' LIMIT 1"),
      getPool().query("SELECT 1 FROM production_role_permission WHERE permission_key = 'node:scene/*/meta@edit' LIMIT 1"),
      getPool().query("SELECT 1 FROM production_dept_permission WHERE permission_key = 'node:scene/*/meta@edit' LIMIT 1"),
      getPool().query("SELECT 1 FROM production_member_permission WHERE permission = 'node:scene/*/meta@edit' LIMIT 1"),
    ]);
    expect(t.rows).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
    expect(d.rows).toHaveLength(0);
    expect(m.rows).toHaveLength(0);
  });
});

describe("integrity verification", () => {
  it("模板键与激活面同源：dramaturgy scope 覆盖全部四枚字段键", () => {
    for (const key of FIELD_KEYS) {
      expect(PAGE_PERMISSION_SCOPES.dramaturgy.has(key)).toBe(true);
    }
  });

  it("全库 scene 区间键都是判定端认得的形态（无裸 meta@edit 式父段写键）", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT DISTINCT permission_key FROM production_role_permission
       WHERE permission_key LIKE 'node:scene/%@edit'
       UNION
       SELECT DISTINCT permission_key FROM grant_template
       WHERE permission_key LIKE 'node:scene/%@edit'`,
    );
    // 判定端只查这些 sub：字段级 sub + 结构面 '*'。父段 'meta' 没有任何门。
    const allowed = new Set([
      "node:scene/*@edit",
      "node:scene/*/meta/name@edit",
      "node:scene/*/meta/type@edit",
      "node:scene/*/meta/expected_duration@edit",
      "node:scene/*/synopsis@edit",
      "node:scene/*/action_line@edit",
      "node:scene/*/music@edit",
      "node:scene/*/stage_notes@edit",
      // 历史空转键（批E-1 由 scene:renumber 迁来）：场次号自 marker 顺序派生，
      // 没有改号入口故无门。与 meta@edit 的「错配」不同，它是「功能未实现」，
      // 不在本次范围内清理。
      "node:scene/*/meta/number@edit",
    ]);
    const stray = rows.map(r => r.permission_key).filter(k => !allowed.has(k));
    expect(stray).toEqual([]);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("编剧 / 戏剧构作角色区间：补齐四枚字段键", async () => {
    for (const roleId of [snapshot!.playwrightRoleId, snapshot!.dramaturgRoleId]) {
      const { rows } = await getPool().query<{ permission_key: string }>(
        "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
        [roleId],
      );
      const keys = rows.map(r => r.permission_key);
      for (const key of FIELD_KEYS) expect(keys).toContain(key);
      expect(keys).not.toContain("node:scene/*/meta@edit");
    }
  });

  it.skipIf(!snapshot)("迁移前既有的无关键原样存续（只补不覆盖）", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
      [snapshot!.playwrightRoleId],
    );
    expect(rows.map(r => r.permission_key)).toContain("node:scene/*/synopsis@edit");
  });

  it.skipIf(!snapshot)("名单外角色（导演）不被补字段键", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
      [snapshot!.directorRoleId],
    );
    const keys = rows.map(r => r.permission_key);
    // 原有键存续；本迁移的四枚一个都不该落到它头上
    // （不断言全等——global-setup 里后续迁移会给全部角色补 wiki 等基线键）
    expect(keys).toContain("node:scene/*/music@edit");
    for (const key of FIELD_KEYS) expect(keys).not.toContain(key);
  });
});
