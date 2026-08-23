/**
 * Migration tests for migrate-version-retire.sql（版本退役 Phase B 收尾，PR #300）。
 *
 *   1. Schema     — asset_version_rel 表、asset.is_universal、
 *                   version.name/description/tags/status、version_status 枚举全部消失
 *   2. Integrity  — version 保留列完好（active_version_id 仍指向存在的行、
 *                   parent_version_id 链可用）、asset_file 无孤儿、迁移可重复执行
 *   3. Invariance — **资产文件解析不丢**：迁移前被版本 pin 住旧文件的资产，
 *                   迁移后 latest-wins 解析到最新文件且不为 null。这是本迁移
 *                   唯一的业务风险面——化石列本身零读者，没有数据要迁。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { resolveAssetFile } from "@/lib/asset-db";
import { getVersion, getActiveVersionId } from "@/lib/db";
import { makeProduction, cleanupProduction, makeLegacyVersion } from "./factories";
import {
  VERSION_RETIRE_SNAPSHOT_PATH,
  type VersionRetireSnapshot,
} from "./version-retire-snapshot";

let snapshot: VersionRetireSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(VERSION_RETIRE_SNAPSHOT_PATH, "utf8"),
  ) as VersionRetireSnapshot;
} catch {
  snapshot = null;
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("asset_version_rel 表已消失", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'asset_version_rel'
    `);
    expect(rows).toHaveLength(0);
  });

  it("version 化石列（name/description/tags/status）已消失，保留列健在", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'version'
    `);
    const cols = rows.map((r) => r.column_name);
    for (const dead of ["name", "description", "tags", "status"]) {
      expect(cols, `version.${dead} 应已删除`).not.toContain(dead);
    }
    for (const alive of ["id", "production_id", "parent_version_id", "created_at", "script_config", "marker_structure_revision"]) {
      expect(cols, `version.${alive} 不应被误删`).toContain(alive);
    }
  });

  it("asset.is_universal 已消失", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'asset' AND column_name = 'is_universal'
    `);
    expect(rows).toHaveLength(0);
  });

  it("version_status 枚举类型已消失", async () => {
    const { rows } = await getPool().query(
      "SELECT 1 FROM pg_type WHERE typname = 'version_status'",
    );
    expect(rows).toHaveLength(0);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("active_version_id 全库无悬空指向", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM production p
      LEFT JOIN version v ON v.id = p.active_version_id
      WHERE p.active_version_id IS NOT NULL AND v.id IS NULL
      LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  it("asset_file 无孤儿 asset_id", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM asset_file af
      LEFT JOIN asset a ON a.id = af.asset_id
      WHERE a.id IS NULL LIMIT 1
    `);
    expect(rows).toHaveLength(0);
  });

  // 保留列（线性链）在瘦身后仍然可用：工厂造演出 + 遗留链，血统指针不受迁移影响。
  it("瘦身后的 version 表仍支撑线性链与 head 解析，且迁移可重复执行", async () => {
    const { prodId, versionId } = await makeProduction();
    try {
      const headId = await makeLegacyVersion(prodId, versionId);
      expect(await getActiveVersionId(prodId)).toBe(headId);
      expect((await getVersion(headId))?.parentVersionId).toBe(versionId);

      // 幂等：IF EXISTS 全套，可重放
      await getPool().query(readFileSync("db/migrate-version-retire.sql", "utf8"));
      expect((await getVersion(headId))?.parentVersionId).toBe(versionId);
    } finally {
      await cleanupProduction(prodId).catch(() => {});
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("迁移前被版本 pin 旧文件的资产，迁移后 latest-wins 解析到最新文件", async () => {
    const file = await resolveAssetFile(snapshot!.assetId);
    expect(file).not.toBeNull();
    // pin 行消失后语义切换为 latest-wins——解析到最新文件，而不是丢文件或旧 pin
    expect(file!.id).toBe(snapshot!.latestFileId);
  });

  it.skipIf(!snapshot)("工厂演出的 version 行与 head 指针在列瘦身后原样存活", async () => {
    expect(await getActiveVersionId(snapshot!.prodId)).toBe(snapshot!.versionId);
    const v = await getVersion(snapshot!.versionId);
    expect(v).not.toBeNull();
    expect(v!.productionId).toBe(snapshot!.prodId);
  });
});
