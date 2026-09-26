import path from "node:path";
import os from "node:os";
import type { Pool } from "pg";
import type { MigrationHookContext } from "../_support/global-setup";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { createAsset } from "@/lib/asset/db";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "clickin-revoke-orphan-asset-grants.json");
export type GrantRow = Record<string, unknown> & { id: string; is_revoked: boolean; revoked_reason: string | null };
export type Snapshot = { prodId: string; orphanId: string; liveId: string; before: GrantRow[]; changedIds: string[] };

/** 无条件造旧状态，不能依赖线上是否恰好有孤儿行。 */
export async function createPreMigrationData({ pool, testUser, testOwner }: MigrationHookContext): Promise<Snapshot> {
  const { prodId } = await makeProduction(testOwner);
  const create = (fileName: string) => createAsset({
    productionId: prodId, uploaderUserId: testUser, assetType: "reference",
    fileName, mimeType: "application/pdf", storageType: "r2", listable: true,
  });
  const orphanId = (await create("旧删除路径.pdf")).asset.id;
  const liveId = (await create("仍在用.pdf")).asset.id;
  // 裸删故意复刻修复前行为，不能调用已修复的 deleteAsset。
  await pool.query("DELETE FROM asset WHERE id=$1", [orphanId]);
  await pool.query(
    `UPDATE production_member_grant SET created_at='2026-09-01 00:00:00+00'
     WHERE production_id=$1 AND resource_id=$2`, [prodId, orphanId],
  );
  await pool.query(
    `UPDATE production_member_grant SET expires_at='2026-09-02 00:00:00+00'
     WHERE production_id=$1 AND resource_id=$2 AND resource_sub='meta' AND permission_level='edit'`, [prodId, orphanId],
  );
  await pool.query(
    `UPDATE production_member_grant SET is_revoked=true, revoked_reason='role_change'
     WHERE production_id=$1 AND resource_id=$2 AND resource_sub='file' AND permission_level='create'`, [prodId, orphanId],
  );
  // 通配、其它域、盘点后新孤儿都必须原样保留。
  await pool.query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,created_at)
     VALUES ($1,$2,'asset','*','meta','view','approval','2026-09-01'),
            ($1,$2,'wiki',$3,'meta','view','direct','2026-09-01'),
            ($1,$2,'asset',$4,'meta','view','auto','2026-10-01')`,
    [prodId, testUser, orphanId, `${orphanId}_later`],
  );
  const before = (await pool.query<{ row: GrantRow }>(
    "SELECT to_jsonb(g) AS row FROM production_member_grant g WHERE production_id=$1 ORDER BY id", [prodId],
  )).rows.map(r => r.row);
  const changedIds = before.filter(r => r.resource_type === "asset" && r.resource_id === orphanId
    && !r.is_revoked && r.expires_at === null).map(r => r.id);
  return { prodId, orphanId, liveId, before, changedIds };
}

export async function cleanup(_pool: Pool, snapshot: Snapshot) {
  await cleanupProduction(snapshot.prodId).catch(() => {});
}
