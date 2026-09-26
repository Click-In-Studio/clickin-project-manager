import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type Snapshot, type GrantRow } from "./revoke_orphan_asset_grants.snapshot";

const snapshot: Snapshot | null = existsSync(SNAPSHOT_PATH)
  ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) : null;
const sql = readFileSync("db/migrations/20260926041043_revoke_orphan_asset_grants.sql", "utf8");
const up = sql.split("-- migrate:up")[1].split("-- migrate:down")[0];

describe("schema：沿用现有撤销和审计字段，无结构变更", () => {
  it("manual 撤销原因合法，数据迁移不伪造 down", async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid='production_member_grant'::regclass AND contype='c'`,
    );
    expect(rows.some(r => r.def.includes("manual"))).toBe(true);
    expect(sql).toContain("RAISE EXCEPTION 'irreversible'");
  });
});

describe("integrity / invariance：迁移前夹具", () => {
  it.skipIf(!snapshot)("仅目标孤儿改为撤销，原始元数据、活资产、通配及其它域不变", async () => {
    const { rows } = await getPool().query<{ row: GrantRow }>(
      "SELECT to_jsonb(g) AS row FROM production_member_grant g WHERE production_id=$1 ORDER BY id", [snapshot!.prodId],
    );
    expect(snapshot!.changedIds.length).toBeGreaterThan(0);
    expect(rows.map(r => r.row)).toEqual(snapshot!.before.map(r => snapshot!.changedIds.includes(r.id)
      ? { ...r, is_revoked: true, revoked_reason: "manual" } : r));
  });
  it.skipIf(!snapshot)("重跑幂等；目标账本行没有物理删除", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(up);
      const { rows } = await client.query<{ row: GrantRow }>(
        "SELECT to_jsonb(g) AS row FROM production_member_grant g WHERE production_id=$1 ORDER BY id", [snapshot!.prodId],
      );
      // migration 固定 UTC；用数据库按同一时区重序列化预期，保留微秒精度。
      const expected = await client.query<{ row: GrantRow }>(
        `SELECT to_jsonb(g) AS row FROM jsonb_populate_recordset(NULL::production_member_grant,$1::jsonb) g ORDER BY id`,
        [JSON.stringify(snapshot!.before.map(r => snapshot!.changedIds.includes(r.id)
          ? { ...r, is_revoked: true, revoked_reason: "manual" } : r))],
      );
      expect(rows.map(r => r.row)).toEqual(expected.rows.map(r => r.row));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("线上摘要不匹配时整笔拒绝执行", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('clickin.asset_cleanup_digest','wrong-digest',true)");
      await expect(client.query(up)).rejects.toThrow("candidates changed since snapshot");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
