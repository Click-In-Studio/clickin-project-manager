import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { SCENE_CHAR_TAG_REST_SNAPSHOT_PATH, type SceneCharTagRestSnapshot } from "./scene-char-tag-rest-snapshot";

// 批E PR-E1 三层迁移测试（schema / integrity / invariance）

let snapshot: SceneCharTagRestSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SCENE_CHAR_TAG_REST_SNAPSHOT_PATH, "utf8")) as SceneCharTagRestSnapshot;
} catch {
  snapshot = null;
}

describe("schema verification", () => {
  it("scene 词汇只余四动词（mount/manage 退役）", async () => {
    const { rows } = await getPool().query<{ permission_level: string }>(
      `SELECT permission_level FROM resource_permission_level
       WHERE resource_type = 'scene' ORDER BY permission_level`,
    );
    expect(rows.map(r => r.permission_level)).toEqual(["create", "delete", "edit", "view"]);
  });

  it("character / tag_group 词汇四动词在位", async () => {
    const { rows } = await getPool().query<{ resource_type: string; n: string }>(
      `SELECT resource_type, COUNT(*) AS n FROM resource_permission_level
       WHERE resource_type IN ('character', 'tag_group') GROUP BY 1 ORDER BY 1`,
    );
    expect(rows.map(r => `${r.resource_type}:${r.n}`)).toEqual(["character:4", "tag_group:4"]);
  });
});

describe("integrity verification", () => {
  it("atomic / 三张 permission 表零 E1 原子键", async () => {
    const like = "permission_key LIKE 'scene:%' OR permission_key LIKE 'character:%' OR permission_key LIKE 'tag_group:%' OR permission_key LIKE 'tag_option:%'";
    const [a, r, d] = await Promise.all([
      getPool().query(`SELECT 1 FROM production_member_grant WHERE false`)  /* 终局：atomic 已 DROP */,
      getPool().query(`SELECT 1 FROM production_role_permission WHERE ${like} LIMIT 1`),
      getPool().query(`SELECT 1 FROM production_dept_permission WHERE ${like} LIMIT 1`),
    ]);
    const m = await getPool().query(
      `SELECT 1 FROM production_member_permission
       WHERE permission LIKE 'scene:%' OR permission LIKE 'character:%'
          OR permission LIKE 'tag_group:%' OR permission LIKE 'tag_option:%' LIMIT 1`,
    );
    expect(a.rows).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
    expect(d.rows).toHaveLength(0);
    expect(m.rows).toHaveLength(0);
  });

  it("RG scene 零 mount/manage 老级别行；无 grants 段行（结构型判据）", async () => {
    const old = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE resource_type = 'scene'
       AND permission_level IN ('mount', 'manage') LIMIT 1`,
    );
    const grants = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE resource_type IN ('scene', 'character', 'tag_group')
       AND resource_sub LIKE 'grants%' LIMIT 1`,
    );
    expect(old.rows).toHaveLength(0);
    expect(grants.rows).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("scene:rename 万能代理 → 11 节点行集（结构域全写权保真）", async () => {
    const { rows } = await getPool().query<{ resource_type: string; resource_sub: string; permission_level: string }>(
      `SELECT resource_type, resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_id = '*' AND NOT is_revoked`,
      [snapshot!.renameUserId],
    );
    const triples = rows.map(r => `${r.resource_type}/${r.resource_sub}@${r.permission_level}`);
    for (const need of [
      "scene/meta/name@edit", "scene/*@create", "scene/*@delete", "scene/*@edit",
      "character/*@create", "character/*@delete", "character/*@edit",
      "tag_group/*@create", "tag_group/*@delete", "tag_group/*@edit",
      "tag_group/options@create", "tag_group/options@delete",
    ]) {
      expect(triples).toContain(need);
    }
  });

  it.skipIf(!snapshot)("scene:view / character:view → 三态面行（meta + 内容面）", async () => {
    const { rows } = await getPool().query<{ resource_type: string; resource_sub: string }>(
      `SELECT resource_type, resource_sub FROM production_member_grant
       WHERE user_id = $1 AND permission_level = 'view' AND NOT is_revoked`,
      [snapshot!.viewUserId],
    );
    const pairs = rows.map(r => `${r.resource_type}/${r.resource_sub}`);
    for (const need of ["scene/meta", "scene/synopsis", "character/meta", "character/biography", "character/members"]) {
      expect(pairs).toContain(need);
    }
  });

  it.skipIf(!snapshot)("RG scene manage → 内容行集（无 grants，持有者判据）", async () => {
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'scene' AND resource_id = $2 AND NOT is_revoked`,
      [snapshot!.manageUserId, snapshot!.sceneId],
    );
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    expect(pairs).toContain("*@edit");
    expect(pairs).toContain("*@delete");
    expect(pairs).toContain("mounts@create");
    expect(pairs.some(p => p.startsWith("grants"))).toBe(false);
  });

  it.skipIf(!snapshot)("role 键 → 节点串（含 scene:rename 展开与细键）", async () => {
    const { rows } = await getPool().query<{ permission_key: string }>(
      "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
      [snapshot!.roleId],
    );
    const keys = rows.map(r => r.permission_key);
    expect(keys).toContain("node:scene/*@edit");
    expect(keys).toContain("node:character/*@create");
    expect(keys).toContain("node:tag_group/*/options/name@edit");
    expect(keys).toContain("node:character/*/members@edit");
    expect(keys.some(k => !k.startsWith("node:"))).toBe(false);
  });
});
