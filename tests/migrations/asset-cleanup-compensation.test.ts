import { readFileSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import { getPool } from "@/lib/pg";
import { createPreMigrationData, cleanup, type Snapshot } from "./revoke_orphan_asset_grants.snapshot";

const up = readFileSync("db/migrations/20260926041043_revoke_orphan_asset_grants.sql", "utf8")
  .split("-- migrate:up")[1].split("-- migrate:down")[0];
const query = readFileSync("scripts/admin/snapshot-asset-orphan-cleanup.sql", "utf8").split("-- snapshot-query")[1];
const restore = readFileSync("scripts/admin/restore-asset-orphan-cleanup.sql", "utf8").split("-- compensation-body")[1];
let fixture: Snapshot;
beforeAll(async () => {
  const user = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
  fixture = await createPreMigrationData({ pool:getPool(),faker,testUser:user,testOwner:user });
});
afterAll(async () => { if (fixture) await cleanup(getPool(),fixture); });

it("快照摘要可驱动迁移，补偿精确还原；中途变更会拒绝补偿", async () => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const { rows } = await client.query<{ snapshot: { digest:string; targets:{ id:string }[]; unchanged_digest:string } }>(query);
    const backup = rows[0].snapshot;
    expect(backup.targets.length).toBeGreaterThan(0);
    await client.query("SELECT set_config('clickin.asset_cleanup_digest',$1,true)", [backup.digest]);
    await client.query(up);
    await client.query("SELECT set_config('clickin.asset_cleanup_excluded_ids',$1,true)",
      [JSON.stringify(backup.targets.map(r => r.id))]);
    const after = (await client.query(query)).rows[0].snapshot;
    expect(after.count).toBe(0);
    expect(after.unchanged_digest).toBe(backup.unchanged_digest);
    await client.query("SELECT set_config('clickin.asset_cleanup_snapshot',$1,true)", [JSON.stringify(backup)]);
    await client.query("SAVEPOINT changed_after_cleanup");
    await client.query("UPDATE production_member_grant SET revoked_reason='role_change' WHERE id=$1", [fixture.changedIds[0]]);
    await expect(client.query(restore)).rejects.toThrow("refusing compensation");
    await client.query("ROLLBACK TO SAVEPOINT changed_after_cleanup");
    await client.query(restore);
    const restored = (await client.query(query)).rows[0].snapshot;
    expect(restored.digest).toBe(backup.digest);
    expect(restored.targets).toEqual(backup.targets);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
