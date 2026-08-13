import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { isReservedSub } from "@/lib/grant-check";
import { SCRIPT_REST_SNAPSHOT_PATH, type ScriptRestSnapshot } from "./script-rest-snapshot";

// 批E PR-E2 三层迁移测试（schema / integrity / invariance）

let snapshot: ScriptRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SCRIPT_REST_SNAPSHOT_PATH, "utf8")) as ScriptRestSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("script / dramaturgy 词汇四动词在位", async () => {
    const { rows } = await getPool().query<{ resource_type: string; n: string }>(
      `SELECT resource_type, COUNT(*) AS n FROM resource_permission_level
       WHERE resource_type IN ('script', 'dramaturgy') GROUP BY 1 ORDER BY 1`,
    );
    expect(rows.map(r => `${r.resource_type}:${r.n}`)).toEqual(["dramaturgy:4", "script:4"]);
  });

  it("imports 是保留段（批量破坏性，'*' 通配不覆盖）", () => {
    expect(isReservedSub("imports")).toBe(true);
    expect(isReservedSub("imports/x")).toBe(true);
  });
});

describe("integrity verification", () => {
  it("atomic / 三张 permission 表零 E2 原子键", async () => {
    const like = "permission_key LIKE 'script:%' OR permission_key LIKE 'rehearsal_mark:%' OR permission_key = 'dramaturgy:import'";
    const [a, r, d] = await Promise.all([
      getPool().query(`SELECT 1 FROM atomic_permission_grant WHERE ${like} LIMIT 1`),
      getPool().query(`SELECT 1 FROM production_role_permission WHERE ${like} LIMIT 1`),
      getPool().query(`SELECT 1 FROM production_dept_permission WHERE ${like} LIMIT 1`),
    ]);
    const m = await getPool().query(
      `SELECT 1 FROM production_member_permission
       WHERE permission LIKE 'script:%' OR permission LIKE 'rehearsal_mark:%'
          OR permission = 'dramaturgy:import' LIMIT 1`,
    );
    expect(a.rows).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
    expect(d.rows).toHaveLength(0);
    expect(m.rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("script:edit bundle → 12 行集（blocks 全家 + marks + mounts）", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM resource_grant
       WHERE user_id = $1 AND resource_type = 'script' AND NOT is_revoked`,
      [snapshot!.editUserId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    for (const need of ["blocks@create", "blocks@delete", "blocks@edit",
                        "blocks/character@edit", "blocks/type@edit", "blocks/tags@edit",
                        "blocks/position@edit", "mounts@create",
                        "rehearsal_marks@create", "rehearsal_marks@edit",
                        "rehearsal_marks@delete", "rehearsal_marks/position@edit"]) {
      expect(pairs).toContain(need);
    }
    // bundle 不含 imports（保留段不在 edit 蕴含内）
    expect(pairs.some(p => p.startsWith("imports"))).toBe(false);
  });

  it.skipIf(!snapshot)("script:annotate bundle → 只有 marks 4 行", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM resource_grant
       WHERE user_id = $1 AND resource_type = 'script' AND NOT is_revoked`,
      [snapshot!.annotateUserId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`).sort();
    expect(pairs).toEqual(["rehearsal_marks/position@edit", "rehearsal_marks@create",
                           "rehearsal_marks@delete", "rehearsal_marks@edit"]);
  });

  it.skipIf(!snapshot)("import 键 → imports@create 保留段行（script + dramaturgy 两域）", async () => {
    const { rows } = await getPool().query<{ resource_type: string; resource_sub: string }>(
      `SELECT resource_type, resource_sub FROM resource_grant
       WHERE user_id = $1 AND permission_level = 'create' AND NOT is_revoked`,
      [snapshot!.importUserId],
    );
    const pairs = rows.map(r => `${r.resource_type}/${r.resource_sub}`);
    expect(pairs).toContain("script/imports");
    expect(pairs).toContain("dramaturgy/imports");
  });

  it.skipIf(!snapshot)("role 键 → 节点串（view 三态/comment/manage 展开/mark move）", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
      [snapshot!.roleId],
    );
    const keys = rows.map(r => r.permission_key);
    expect(keys).toContain("node:script/*/blocks@view");
    expect(keys).toContain("node:script/*/comments@create");
    expect(keys).toContain("node:script/*/blocks@edit");            // manage 展开
    expect(keys).toContain("node:script/*/rehearsal_marks/position@edit");
    expect(keys.some(k => !k.startsWith("node:"))).toBe(false);
  });
});
