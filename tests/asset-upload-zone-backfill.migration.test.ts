/**
 * Migration tests for migrate-asset-upload-zone-backfill.sql（素材上传资格区间回填）.
 *
 * 背景：批D 把上传门从裸门收紧到 node:asset/*@create，只映射了旧 asset:create
 * 原子键——裸门时代无人持有，存量项目 dept/role 区间也无此键，全员（除 owner）
 * 上传闭死且无从自我确认。回填给「区间全空」项目的非弃用 role 补区间行。
 *
 * Layers: 1 schema（词汇行守卫） 2 integrity（键行无孤儿 role）
 *         3 invariance（存量 role 得键；弃用 role / 区间已持键项目不受影响）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  ASSET_UPLOAD_ZONE_SNAPSHOT_PATH,
  ASSET_UPLOAD_ZONE_KEY,
  type AssetUploadZoneSnapshot,
} from "./asset-upload-zone-backfill-snapshot";

let snapshot: AssetUploadZoneSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(ASSET_UPLOAD_ZONE_SNAPSHOT_PATH, "utf8")) as AssetUploadZoneSnapshot;
} catch {
  snapshot = null;
}

async function roleHasKey(roleId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    "SELECT 1 FROM production_role_permission WHERE role_id = $1 AND permission_key = $2",
    [roleId, ASSET_UPLOAD_ZONE_KEY],
  );
  return rows.length > 0;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("asset create verb exists in resource_permission_level (vocabulary guard)", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_permission_level WHERE resource_type = 'asset' AND permission_level = 'create'`,
    );
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no upload-zone row points at a missing role", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_role_permission prp
       LEFT JOIN production_role r ON r.id = prp.role_id
       WHERE prp.permission_key = $1 AND r.id IS NULL`,
      [ASSET_UPLOAD_ZONE_KEY],
    );
    expect(rows).toHaveLength(0);
  });

  // 注：不做"存量项目全部 role 均持键"的全局断言——其他测试的工厂会裸造
  // 无区间的 production/role，并发期间存在合法的无键形态。覆盖交给 invariance。
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("legacy production: active role gains the upload zone key", async () => {
    expect(await roleHasKey(snapshot!.legacyRoleId)).toBe(true);
  });

  it.skipIf(!snapshot)("legacy role holds exactly one zone row for the key", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM production_role_permission WHERE role_id = $1 AND permission_key = $2",
      [snapshot!.legacyRoleId, ASSET_UPLOAD_ZONE_KEY],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it.skipIf(!snapshot)("re-running the migration inserts zero rows (idempotent)", () => {
    // global-setup 紧接首跑重放了一次迁移 SQL，各语句插入行数之和记进快照。
    expect(snapshot!.secondRunInsertedRows).toBe(0);
  });

  it.skipIf(!snapshot)("legacy production: deprecated role is NOT backfilled", async () => {
    expect(await roleHasKey(snapshot!.legacyDeprecatedRoleId)).toBe(false);
  });

  it.skipIf(!snapshot)("production whose role zone already holds the key: keyless role untouched", async () => {
    expect(await roleHasKey(snapshot!.roleCtlKeylessRoleId)).toBe(false);
  });

  it.skipIf(!snapshot)("production whose dept zone already holds the key: keyless role untouched", async () => {
    expect(await roleHasKey(snapshot!.deptCtlKeylessRoleId)).toBe(false);
  });
});
