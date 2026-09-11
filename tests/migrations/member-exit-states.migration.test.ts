/**
 * 成员退出状态机收窄（#141）——三层迁移测试。
 *
 * 层 1 schema：status 只余三态、status_source 值域与跨列不变式在位、审计表成型
 * 层 2 完整性：全库零 pending_exit/disputed 残留；非 active 行必带成因
 * 层 3 invariance：五态时代的残留行归一到 suspended 且**授权行一条没撤**
 *   —— 归一方向是冻结不是撤销，这是本迁移唯一不可逆的地方
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { MEMBER_EXIT_SNAPSHOT_PATH, type MemberExitSnapshot } from "./member-exit-snapshot";

let snapshot: MemberExitSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(MEMBER_EXIT_SNAPSHOT_PATH, "utf8")) as MemberExitSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("status 只余 active / suspended / exited", async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'production_member'::regclass
          AND conname = 'production_member_status_check'`,
    );
    expect(rows).toHaveLength(1);
    for (const dead of ["pending_exit", "disputed"]) {
      expect(rows[0].def).not.toContain(dead);
    }
    for (const live of ["active", "suspended", "exited"]) {
      expect(rows[0].def).toContain(live);
    }
  });

  it("status_source 三列在位且可空", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'production_member'
          AND column_name IN ('status_source', 'status_changed_at', 'status_changed_by')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "status_changed_at",
      "status_changed_by",
      "status_source",
    ]);
    expect(rows.every((r) => r.is_nullable === "YES")).toBe(true);
  });

  it("跨列不变式在位：active ⇔ status_source IS NULL", async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'production_member'::regclass
          AND conname = 'production_member_status_source_check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("status_source IS NULL");
  });

  it("成因值域只认 self / admin", async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'production_member'::regclass
          AND conname = 'production_member_status_source_value_check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("self");
    expect(rows[0].def).toContain("admin");
  });

  it("审计表成型：表态行不许带 to_status", async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'production_member_status_audit'::regclass
          AND conname = 'pmsa_stance_has_no_target'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("to_status IS NULL");
  });
});

describe("integrity verification", () => {
  it("全库零 pending_exit / disputed 残留", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member
        WHERE status IN ('pending_exit', 'disputed') LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it("非 active 成员必带成因，active 成员必不带", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member
        WHERE (status = 'active') <> (status_source IS NULL) LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it("审计表零孤儿：每行的 (production_id, user_id) 都指向真实成员行", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_status_audit a
        WHERE NOT EXISTS (
          SELECT 1 FROM production_member pm
           WHERE pm.production_id = a.production_id AND pm.user_id = a.user_id
        ) LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("pending_exit / disputed 双双归一到 suspended，成员行未消失", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{
      user_id: string;
      status: string;
      status_source: string | null;
      has_ts: boolean;
    }>(
      `SELECT user_id::text AS user_id, status, status_source,
              status_changed_at IS NOT NULL AS has_ts
         FROM production_member
        WHERE production_id = $1 AND user_id = ANY($2::uuid[])
        ORDER BY user_id`,
      [s.prodId, [s.pendingExitUserId, s.disputedUserId]],
    );

    // 迁移不删人：两条都还在
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe("suspended");
      expect(r.status_source).toBe("self");
      expect(r.has_ts).toBe(true);
    }
  });

  it.skipIf(!snapshot)("归一是冻结不是撤销：两人的授权行一条没撤", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ id: string; is_revoked: boolean }>(
      `SELECT id::text AS id, is_revoked FROM production_member_grant
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [s.grantIds],
    );
    expect(rows).toHaveLength(s.grantIds.length);
    expect(rows.every((r) => r.is_revoked === false)).toBe(true);
  });

  it.skipIf(!snapshot)("suspended 成员拿不到权限上下文（访问闸门已生效）", async () => {
    const s = snapshot!;
    const { getProductionPermissionContext } = await import("@/lib/db");
    // 成员行还在、授权行还在，但 status <> 'active' → 不是 member，也不是 owner
    const access = await getProductionPermissionContext(s.pendingExitUserId, false, s.prodId);
    expect(access).toBeNull();
  });
});
