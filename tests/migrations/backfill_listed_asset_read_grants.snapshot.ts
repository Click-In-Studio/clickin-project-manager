import path from "node:path";
import os from "node:os";
import type { Pool } from "pg";
import type { MigrationHookContext } from "../_support/global-setup";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { createAsset } from "@/lib/asset/db";

export const SNAPSHOT_PATH = path.join(os.tmpdir(), "clickin-backfill-listed-asset-read.json");
export type Snapshot = { prodId: string; listedId: string; hiddenId: string; reader: string; before: Record<string, unknown>[] };

/** 无条件造旧能力票，覆盖可列出与私有资产；不能依赖测试库现有数据。 */
export async function createPreMigrationData({ pool, testUser, testOwner }: MigrationHookContext): Promise<Snapshot> {
  const { prodId } = await makeProduction(testOwner);
  const listedId = (await createAsset({
    productionId: prodId, uploaderUserId: testUser, assetType: "reference",
    fileName: "列出的旧资产.pdf", mimeType: "application/pdf", storageType: "r2", listable: true,
  })).asset.id;
  const hiddenId = (await createAsset({
    productionId: prodId, uploaderUserId: testUser, assetType: "reference",
    fileName: "私有的旧资产.pdf", mimeType: "application/pdf", storageType: "r2", listable: false,
  })).asset.id;
  await pool.query(
    `INSERT INTO production_member_grant
      (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
     VALUES ($1,$2,'asset','*','meta','view','approval')`, [prodId, testUser],
  );
  const before = (await pool.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(g) AS row FROM production_member_grant g
     WHERE production_id=$1 ORDER BY id`, [prodId],
  )).rows.map(r => r.row);
  return { prodId, listedId, hiddenId, reader: testUser, before };
}

export async function cleanup(_pool: Pool, snapshot: Snapshot) {
  await cleanupProduction(snapshot.prodId).catch(() => {});
}
