import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type Snapshot } from "./align_asset_share_levels.snapshot";

const snapshot: Snapshot | null = existsSync(SNAPSHOT_PATH)
  ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) : null;
const sql = readFileSync("db/migrations/20260928090936_align_asset_share_levels.sql", "utf8");
const up = sql.split("-- migrate:up")[1].split("-- migrate:down")[0];

describe("schema：资产旧分享只做 expand", () => {
  it("保留旧 publication 行，down 明确不可逆", () => {
    expect(up).not.toMatch(/DELETE[\s\S]+publication/i);
    expect(sql).toContain("RAISE EXCEPTION 'irreversible'");
  });
});

describe("integrity / invariance：旧资产读者", () => {
  it.skipIf(!snapshot)("实例与通配旧读票展开为预览和下载三行，旧行与有效期保留", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{
      resource_id: string;
      resource_sub: string;
      permission_level: string;
      grant_source: string;
      is_revoked: boolean;
      expires_at: Date | null;
    }>(
      `SELECT resource_id,resource_sub,permission_level,grant_source,is_revoked,expires_at
       FROM production_member_grant
       WHERE production_id=$1 AND user_id=$2 AND resource_type='asset'
       ORDER BY resource_id,resource_sub,grant_source`,
      [s.prodId, s.readerId],
    );

    for (const resourceId of [s.assetId, "*"]) {
      const added = rows.filter(row => row.resource_id === resourceId && row.grant_source === "migrated");
      expect(added.map(row => `${row.resource_sub}@${row.permission_level}`).sort()).toEqual([
        "*@view", "file@view", "meta@view",
      ]);
      if (resourceId === s.assetId) {
        for (const row of added) expect(row.expires_at?.toISOString()).toBe(s.expiresAt);
      } else {
        for (const row of added) expect(row.expires_at).toBeNull();
      }
    }

    const legacy = rows.filter(row => row.resource_sub === "publication" && !row.is_revoked);
    expect(legacy).toHaveLength(2);
    const expiredConflict = rows.find(row =>
      row.resource_id === s.assetId && row.resource_sub === "meta" && row.grant_source === "direct");
    expect(expiredConflict?.is_revoked).toBe(true);
  });

  it.skipIf(!snapshot)("除过期目标冲突行外，迁移前授权均保持；重跑不增行", async () => {
    const s = snapshot!;
    const current = await getPool().query<{ id: string; is_revoked: boolean }>(
      "SELECT id::text,is_revoked FROM production_member_grant WHERE production_id=$1 AND user_id=$2",
      [s.prodId, s.readerId],
    );
    const byId = new Map(current.rows.map(row => [row.id, row.is_revoked]));
    for (const old of s.before) {
      const wasExpiredConflict = old.resource_sub === "meta" && old.permission_level === "view";
      expect(byId.get(String(old.id))).toBe(wasExpiredConflict ? true : old.is_revoked);
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const before = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM production_member_grant WHERE production_id=$1", [s.prodId],
      );
      await client.query(up);
      const after = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM production_member_grant WHERE production_id=$1", [s.prodId],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
