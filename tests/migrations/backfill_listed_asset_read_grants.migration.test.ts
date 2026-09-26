import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type Snapshot } from "./backfill_listed_asset_read_grants.snapshot";

const snapshot: Snapshot | null = existsSync(SNAPSHOT_PATH)
  ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) : null;
const sql = readFileSync("db/migrations/20260926045257_backfill_listed_asset_read_grants.sql", "utf8");
const up = sql.split("-- migrate:up")[1].split("-- migrate:down")[0];

describe("schema：只补实例授权，不改变 grant 结构", () => {
  it("迁移可逆性和目标行形状", () => {
    expect(sql).toContain("RAISE EXCEPTION 'irreversible'");
    expect(up).toContain("'asset', asset_id, '*', 'view', 'migrated'");
  });
});

describe("integrity / invariance：存量旧读者", () => {
  it.skipIf(!snapshot)("仅可列出父链上的旧读者获得实例正文票，历史行原样保留", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(g) AS row FROM production_member_grant g
       WHERE production_id=$1 ORDER BY id`, [s.prodId],
    );
    const after = rows.map(r => r.row);
    for (const row of s.before) expect(after).toContainEqual(row);
    const added = after.filter(r => !s.before.some(old => old.id === r.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      user_id: s.reader, resource_type: "asset", resource_id: s.listedId,
      resource_sub: "*", permission_level: "view", grant_source: "migrated", is_revoked: false,
    });
    expect(added.some(r => r.resource_id === s.hiddenId)).toBe(false);
  });

  it.skipIf(!snapshot)("重跑幂等，不增加授权行", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const before = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM production_member_grant WHERE production_id=$1", [snapshot!.prodId]);
      await client.query(up);
      const after = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM production_member_grant WHERE production_id=$1", [snapshot!.prodId]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
