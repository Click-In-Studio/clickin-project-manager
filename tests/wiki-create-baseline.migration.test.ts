/**
 * Migration tests for migrate-wiki-create-baseline.sql（wiki 创建资格基线回填）.
 *
 * 背景：grant_template 运行时零读取，W3 只 seed 模板未回填存量 role 区间——
 * 存量剧组普通成员没有 node:wiki/*@create 资格。
 *
 * Layers: 1 schema（词汇行守卫） 2 integrity（键行无孤儿 role）
 *         3 invariance（工厂存量 role 迁移后持有基线键）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  WIKI_CREATE_BASELINE_SNAPSHOT_PATH,
  type WikiCreateBaselineSnapshot,
} from "./wiki-create-baseline-snapshot";

let snapshot: WikiCreateBaselineSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(WIKI_CREATE_BASELINE_SNAPSHOT_PATH, "utf8")) as WikiCreateBaselineSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("wiki create verb exists in resource_permission_level (FK precondition)", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_permission_level WHERE resource_type = 'wiki' AND permission_level = 'create'`,
    );
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no wiki-create baseline row points at a missing role", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production_role_permission prp
      LEFT JOIN production_role r ON r.id = prp.role_id
      WHERE prp.permission_key = 'node:wiki/*@create' AND r.id IS NULL
    `);
    expect(rows).toHaveLength(0);
  });

  // 注：不做"全库所有 role 均有基线"的全局断言——其他测试的工厂会裸造 role
  //（不经 seedRoleFromTemplate），并发期间存在合法的无键 role。覆盖交给 invariance。
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("factory legacy role gains node:wiki/*@create", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_role_permission WHERE role_id = $1 AND permission_key = 'node:wiki/*@create'`,
      [s.roleId],
    );
    expect(rows).toHaveLength(1);
  });
});
