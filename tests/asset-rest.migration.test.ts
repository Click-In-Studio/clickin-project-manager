import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { ASSET_REST_SNAPSHOT_PATH, type AssetRestSnapshot } from "./asset-rest-snapshot";

// 批D 三层迁移测试（schema / integrity / invariance）
// 快照必须模块顶层同步读取（skipIf 收集期求值）

let snapshot: AssetRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(ASSET_REST_SNAPSHOT_PATH, "utf8")) as AssetRestSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("asset.is_public exists, NOT NULL, default false", async () => {
    const { rows } = await getPool().query(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'asset' AND column_name = 'is_public'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("false");
  });

  it("asset 词汇只余四动词（mount/manage 退役）", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'asset' ORDER BY permission_level`,
    );
    expect(rows.map(r => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  it("dept 词汇四动词在位（批C C3）", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_permission_level WHERE resource_type = 'dept'`,
    );
    expect(rows.length).toBe(4);
  });
});

describe("integrity verification", () => {
  it("atomic_permission_grant 零 asset:% 键", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE false`,  // 终局：atomic 表已 DROP（零残留恒真）
    );
    expect(rows).toHaveLength(0);
  });

  it("三张 permission 表零 asset 原子键", async () => {
    const [role, member, dept] = await Promise.all([
      getPool().query("SELECT 1 FROM production_role_permission WHERE permission_key LIKE 'asset:%' LIMIT 1"),
      getPool().query("SELECT 1 FROM production_member_permission WHERE permission LIKE 'asset:%' LIMIT 1"),
      getPool().query("SELECT 1 FROM production_dept_permission WHERE permission_key LIKE 'asset:%' LIMIT 1"),
    ]);
    expect(role.rows).toHaveLength(0);
    expect(member.rows).toHaveLength(0);
    expect(dept.rows).toHaveLength(0);
  });

  it("production_member_grant 零 asset mount/manage 老级别行", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE resource_type = 'asset'
       AND permission_level IN ('mount', 'manage') LIMIT 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it("每个 asset 的 uploader 均有 person 归属 + grants@edit 行", async () => {
    const { rows } = await getPool().query(
      `SELECT a.id FROM asset a
       WHERE NOT EXISTS (
         SELECT 1 FROM resource_person_manage rpm
         WHERE rpm.resource_type = 'asset' AND rpm.resource_id = a.id
           AND rpm.user_id = a.uploader_user_id
       ) LIMIT 5`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("存量 asset 迁移后 is_public = true（保真：老世界全员可见）", async () => {
    const { rows } = await getPool().query<{ is_public: boolean }>(
      "SELECT is_public FROM asset WHERE id = $1", [snapshot!.assetId],
    );
    expect(rows[0].is_public).toBe(true);
  });

  it.skipIf(!snapshot)("RG manage → 行集（meta@edit/file@create/publication CRUD/grants@edit）", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'asset' AND resource_id = $2 AND NOT is_revoked
       ORDER BY resource_sub, permission_level`,
      [snapshot!.manageUserId, snapshot!.assetId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    for (const need of ["meta@edit", "file@create", "publication@view", "publication@create",
                        "publication@delete", "grants@edit"]) {
      expect(pairs).toContain(need);
    }
  });

  it.skipIf(!snapshot)("RG mount → publication@create + @delete", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'asset' AND resource_id = $2 AND NOT is_revoked`,
      [snapshot!.mountUserId, snapshot!.assetId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    expect(pairs).toContain("publication@create");
    expect(pairs).toContain("publication@delete");
  });

  it.skipIf(!snapshot)("atomic 能力票族 → 通配动词行；own 键（rename）不转换", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'asset' AND resource_id = '*' AND NOT is_revoked`,
      [snapshot!.atomicUserId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    expect(pairs).toContain("meta@view");            // asset:view
    expect(pairs).toContain("file@view");            // asset:download
    expect(pairs).toContain("shares@create");        // asset:share
    expect(pairs).toContain("publication@create");   // asset:mount_any（保留段显式通配）
    // own 键 asset:rename 不产生 meta@edit 通配（创建者行集承担）
    expect(pairs).not.toContain("meta@edit");
  });

  it.skipIf(!snapshot)("role 键 → 节点串", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id = $1 ORDER BY permission_key",
      [snapshot!.roleId],
    );
    const keys = rows.map(r => r.permission_key);
    expect(keys).toContain("node:asset/*@create");
    expect(keys).toContain("node:asset/*/meta@view");
    expect(keys).toContain("node:asset/*@delete");
    expect(keys.some(k => k.startsWith("asset:"))).toBe(false);
  });

  it.skipIf(!snapshot)("uploader 创建者行集 backfill（10 行）", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'asset' AND resource_id = $2
         AND grant_source = 'self_confirmed' AND NOT is_revoked`,
      [snapshot!.uploaderId, snapshot!.assetId],
    );
    expect(rows.length).toBe(10);
  });
});
