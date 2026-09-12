import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  CUE_DOMAIN_REST_SNAPSHOT_PATH,
  type CueDomainRestSnapshot,
} from "./cue-domain-rest-snapshot";
import { resolveTemplate } from "@/lib/production-template";

// 批A cue 域 REST 化迁移三层测试（migrate-cue-domain-rest.sql）。
// invariance 层依赖 global-setup 在 PRE 库上创建的工厂快照（本地已迁移环境跳过）。
// 快照必须在模块顶层同步加载——it.skipIf 在收集期求值，beforeAll 太晚。

let snapshot: CueDomainRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(CUE_DOMAIN_REST_SNAPSHOT_PATH, "utf8")) as CueDomainRestSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("cue_list vocabulary is exactly the four verbs", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'cue_list' ORDER BY permission_level`,
    );
    expect(rows.map((r) => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  // 原「grant_template 是纯全局模板」一条：那张表已退役（#163），模板职责移交
  // 项目模版常量。这里改验它确实没了，别让残表活回来。
  it("grant_template 已退役（模板职责在项目模版常量里）", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'grant_template'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("production_dept_permission table exists", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'production_dept_permission'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("integrity verification", () => {
  it("no cue_list grant rows with retired levels remain (revoked included)", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE resource_type = 'cue_list' AND permission_level IN ('mount', 'manage') LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it("no cue-domain atomic keys remain in any permission/grant table", async () => {
    for (const [table, col] of [
      // atomic_permission_grant 已 DROP（批G G-2 终局）——零残留恒真
      ["production_role_permission", "permission_key"],
      ["production_member_permission", "permission"],
    ] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table}
         WHERE ${col} LIKE 'cue_list:%' OR ${col} LIKE 'cue:%' LIMIT 1`,
      );
      expect(rows, `${table} 不应残留 cue 原子键`).toHaveLength(0);
    }
    // dept 数组伪键断言已随 migrate-merge-event-department 退役（permissions 列 DROP=恒零残留）。
  });

  it("global template seeds exist (member base + collection create)", async () => {
    const base = resolveTemplate(null).roles.baseline.filter((k) => k.startsWith("node:cue_list"));
    expect(base.length).toBeGreaterThanOrEqual(3);
  });
});

describe("invariance verification", () => {
  async function rowsFor(userId: string, resourceId: string) {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = 'cue_list' AND resource_id = $3 AND NOT is_revoked`,
      [snapshot!.productionId, userId, resourceId],
    );
    return rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
  }

  it.skipIf(!snapshot)("manage row expands to the full verb row-set", async () => {
    expect(await rowsFor(snapshot!.manageUserId, snapshot!.cueListId)).toEqual(
      ["*@delete", "*@edit", "*@view", "cues@create", "cues@delete", "grants@edit"].sort(),
    );
  });

  it.skipIf(!snapshot)("edit row keeps and gains view + cues create/delete", async () => {
    expect(await rowsFor(snapshot!.editUserId, snapshot!.cueListId)).toEqual(
      ["*@edit", "*@view", "cues@create", "cues@delete"].sort(),
    );
  });

  it.skipIf(!snapshot)("atomic activations convert to wildcard verb rows", async () => {
    expect(await rowsFor(snapshot!.atomicUserId, "*")).toEqual(
      // cue_list:view → meta+cues view；cue:comment → comments create；rename_any → meta/name edit
      ["cues/comments@create", "cues@view", "meta/name@edit", "meta@view"].sort(),
    );
  });

  it.skipIf(!snapshot)("role cue keys convert to node-key strings in the same table; base write keys drop", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
      [snapshot!.roleId],
    );
    const got = rows.map((r) => r.permission_key).sort();
    // cue_list:view → meta+cues view；cue_list:create → 集合 create；
    // cue_list:delete（base 写键）→ 无转换（创建者自动行集承担）
    expect(got).toEqual([
      "node:cue_list/*/meta@view",
      "node:cue_list/*/cues@view",
      "node:cue_list/*@create",
    ].sort());
  });

  it.skipIf(!snapshot)("dept pseudo-key × rdm converts to instance-level dept permission rows", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      `SELECT permission_key FROM production_dept_permission WHERE dept_id = $1`,
      [snapshot!.deptId],
    );
    const got = rows.map((r) => r.permission_key).sort();
    const id = snapshot!.cueListId;
    expect(got).toEqual([
      `node:cue_list/${id}@view`,
      `node:cue_list/${id}@edit`,
      `node:cue_list/${id}/cues@create`,
      `node:cue_list/${id}/cues@delete`,
    ].sort());
    // 数组里的非 cue 伪键保留
    const { rows: pd } = await getPool().query<{ permissions: string[] }>(
      `SELECT permissions FROM production_dept WHERE id = $1`, [snapshot!.deptId],
    );
    expect(pd[0].permissions).toContain("event:edit");
    expect(pd[0].permissions).not.toContain("cue_list:edit");
  });
});
