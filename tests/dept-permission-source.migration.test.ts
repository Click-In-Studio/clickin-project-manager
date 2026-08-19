/**
 * Migration tests for migrate-dept-permission-source.sql（#274）。
 *
 *   1. Schema    — source 列存在、NOT NULL、默认 'manual'、CHECK 词汇是三值闭集
 *   2. Integrity — 全库无非法 source 值；每一行都有确定归属（不存在 NULL）
 *   3. Invariance— 工厂四行分别回填成 template / resource / manual / manual，
 *                  其中第四行（无声明无归属的实例键）保持 manual 是这支迁移的考点
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  DEPT_PERMISSION_SOURCE_SNAPSHOT_PATH,
  type DeptPermissionSourceSnapshot,
} from "./dept-permission-source-snapshot";

let snapshot: DeptPermissionSourceSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(DEPT_PERMISSION_SOURCE_SNAPSHOT_PATH, "utf8"),
  ) as DeptPermissionSourceSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("source 列存在，NOT NULL，默认 manual", async () => {
    const { rows } = await getPool().query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'production_dept_permission' AND column_name = 'source'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("manual");
  });

  it("CHECK 把取值锁成三值闭集", async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'production_dept_permission_source_check'
    `);
    expect(rows).toHaveLength(1);
    for (const v of ["manual", "template", "resource"]) expect(rows[0].def).toContain(v);
    // 词汇之外的值必须写不进去（棘轮：将来加通道要同时改 CHECK 与词汇注释）
    await expect(pool.query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
       SELECT production_id, id, 'node:asset/*@view', 'whatever' FROM production_dept LIMIT 1`,
    )).rejects.toThrow();
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("全库无非法 / 空 source 值", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_dept_permission
       WHERE source IS NULL OR source NOT IN ('manual', 'template', 'resource') LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("四种行各自回填到正确的 source", async () => {
    const { rows } = await getPool().query<{ permission_key: string; source: string }>(
      "SELECT permission_key, source FROM production_dept_permission WHERE dept_id = $1",
      [snapshot!.deptId],
    );
    const got = Object.fromEntries(rows.map(r => [r.permission_key, r.source]));
    expect(got).toEqual(snapshot!.expected);
  });

  it.skipIf(!snapshot)("无声明无归属的实例键保持 manual——键形推断会在这里翻车", async () => {
    const manualInstance = Object.entries(snapshot!.expected)
      .find(([k, v]) => v === "manual" && !k.includes("/*"))?.[0];
    expect(manualInstance).toBeDefined();
    const { rows } = await getPool().query<{ source: string }>(
      "SELECT source FROM production_dept_permission WHERE dept_id = $1 AND permission_key = $2",
      [snapshot!.deptId, manualInstance],
    );
    expect(rows[0].source).toBe("manual");
  });
});
