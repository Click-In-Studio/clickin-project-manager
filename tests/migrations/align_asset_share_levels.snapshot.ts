import path from "node:path";
import os from "node:os";
import type { Pool } from "pg";
import type { MigrationHookContext } from "../_support/global-setup";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { createAsset } from "@/lib/asset/db";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "clickin-align-asset-share-levels.json");

export type Snapshot = {
  prodId: string;
  readerId: string;
  assetId: string;
  expiresAt: string;
  before: Record<string, unknown>[];
};

/** 无条件造旧 publication@view 与一个已过期冲突行，覆盖 expand 和唯一索引清障。 */
export async function createPreMigrationData(
  { pool, testUser, testOwner }: MigrationHookContext,
): Promise<Snapshot> {
  const { prodId } = await makeProduction(testOwner);
  await pool.query(
    "INSERT INTO production_member (production_id,user_id,roles) VALUES ($1,$2,'{}') ON CONFLICT DO NOTHING",
    [prodId, testUser],
  );
  const assetId = (await createAsset({
    productionId: prodId,
    uploaderUserId: testOwner,
    assetType: "reference",
    fileName: "旧分享资产.pdf",
    mimeType: "application/pdf",
    storageType: "r2",
  })).asset.id;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,expires_at)
     VALUES ($1,$2,'asset',$3,'publication','view','approval',$4),
            ($1,$2,'asset','*','publication','view','direct',NULL),
            ($1,$2,'asset',$3,'meta','view','direct',now() - interval '1 day')`,
    [prodId, testUser, assetId, expiresAt],
  );
  const before = (await pool.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(g) AS row FROM production_member_grant g
     WHERE production_id=$1 AND user_id=$2 ORDER BY id`,
    [prodId, testUser],
  )).rows.map(row => row.row);
  return { prodId, readerId: testUser, assetId, expiresAt, before };
}

export async function cleanup(_pool: Pool, snapshot: Snapshot) {
  await cleanupProduction(snapshot.prodId).catch(() => {});
}
