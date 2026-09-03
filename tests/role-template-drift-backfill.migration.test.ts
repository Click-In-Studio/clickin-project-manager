/**
 * Migration tests for migrate-role-template-drift-backfill.sql
 * （把存量演出的角色区间对齐当前模版，只加不删）。
 *
 * 背景：线上 11 个演出实查出 18 枚缺键——基线演进的四枚、作曲/编曲的挂载与上传
 * 三枚、以及 8 个模版建制之前的演出里设计族缺 cue_list@create、舞台监督缺 event
 * 与 task 那七枚、制作助理缺 phase 写面三枚。
 *
 * Layers: 1 schema（三枚新键的词汇行守卫）
 *         2 integrity（回填行无孤儿 role；本批键都在激活面目录里）
 *         3 invariance（三段各自命中；两条排除生效；类型 scope 生效；重放插 0 行）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { parseNodeKey } from "@/lib/grant-template";
import { PAGE_PERMISSION_SCOPES } from "@/lib/page-permission-scopes";
import {
  ROLE_DRIFT_SNAPSHOT_PATH,
  MOUNT_UPLOAD_KEYS,
  BASELINE_DRIFT_KEYS,
  WILDCARD_KEY,
  type RoleDriftSnapshot,
} from "./role-template-drift-backfill-snapshot";

let snapshot: RoleDriftSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(ROLE_DRIFT_SNAPSHOT_PATH, "utf8")) as RoleDriftSnapshot;
} catch {
  snapshot = null;
}

async function roleKeys(roleId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ permission_key: string }>(
    "SELECT permission_key FROM production_role_permission WHERE role_id = $1",
    [roleId],
  );
  return rows.map(r => r.permission_key);
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it.each(MOUNT_UPLOAD_KEYS)("%s 的词汇行存在（type × verb）", async (key) => {
    const parsed = parseNodeKey(key);
    expect(parsed).not.toBeNull();
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_permission_level
       WHERE resource_type = $1 AND permission_level = $2`,
      [parsed!.resourceType, parsed!.verb],
    );
    expect(rows).toHaveLength(1);
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("回填的键行没有指向已消失的 role", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_role_permission prp
       LEFT JOIN production_role r ON r.id = prp.role_id
       WHERE prp.permission_key = ANY($1::text[]) AND r.id IS NULL`,
      [[...MOUNT_UPLOAD_KEYS, ...BASELINE_DRIFT_KEYS]],
    );
    expect(rows).toHaveLength(0);
  });

  it("本批键都在激活面目录里（否则区间永远变不成 grant 行）", () => {
    const activatable = new Set<string>([
      ...PAGE_PERMISSION_SCOPES.base,
      ...PAGE_PERMISSION_SCOPES.dramaturgy,
      ...PAGE_PERMISSION_SCOPES.script,
      ...PAGE_PERMISSION_SCOPES.assets,
    ]);
    for (const key of [...MOUNT_UPLOAD_KEYS, ...BASELINE_DRIFT_KEYS]) {
      expect(activatable).toContain(key);
    }
  });

  // 注：不做「全库角色均已对齐」的全局断言——并发跑的其他测试会裸造无区间的
  // production/role，存在合法的无键形态。覆盖交给 invariance。
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  // ① 基线段
  it.skipIf(!snapshot)("存量演出：零键角色拿到基线漂移的四枚", async () => {
    const keys = await roleKeys(snapshot!.composerRoleId);
    for (const key of BASELINE_DRIFT_KEYS) expect(keys).toContain(key);
  });

  it.skipIf(!snapshot)("模版名单外的自建角色也拿到基线（基线合并进每个角色）", async () => {
    const keys = await roleKeys(snapshot!.customRoleId);
    for (const key of BASELINE_DRIFT_KEYS) expect(keys).toContain(key);
  });

  it.skipIf(!snapshot)("但自建角色拿不到戏剧模版的角色键（③ 按角色名 join）", async () => {
    const keys = await roleKeys(snapshot!.customRoleId);
    expect(keys).not.toContain("node:cue_list/*@create");
    expect(keys).not.toContain("node:scene/*/music@edit");
  });

  // ② 挂载与上传段
  it.skipIf(!snapshot)("作曲拿到挂载两枚 + 上传一枚", async () => {
    const keys = await roleKeys(snapshot!.composerRoleId);
    for (const key of MOUNT_UPLOAD_KEYS) expect(keys).toContain(key);
  });

  // ③ 戏剧角色键段
  it.skipIf(!snapshot)("舞台监督拿到 event / task 那几枚", async () => {
    const keys = await roleKeys(snapshot!.stageManagerRoleId);
    for (const key of [
      "node:event/*@create", "node:event/*/call_sheet@view", "node:event/*/chat@create",
      "node:event/*/publication@view", "node:event/*/reports@view",
      "node:task/*@view", "node:task/*@delete", "node:cue_list/*@create",
    ]) expect(keys).toContain(key);
  });

  it.skipIf(!snapshot)("制作助理拿到 phase 写面三枚", async () => {
    const keys = await roleKeys(snapshot!.assistantRoleId);
    for (const key of ["node:phase/*@create", "node:phase/*@edit", "node:phase/*@delete"]) {
      expect(keys).toContain(key);
    }
  });

  // 两条排除
  it.skipIf(!snapshot)("持通配全集的角色一枚都不补（补字面键纯噪音）", async () => {
    expect(await roleKeys(snapshot!.wildcardRoleId)).toEqual([WILDCARD_KEY]);
  });

  it.skipIf(!snapshot)("弃用角色一枚都不补", async () => {
    expect(await roleKeys(snapshot!.deprecatedRoleId)).toHaveLength(0);
  });

  // 演出类型 scope
  it.skipIf(!snapshot)("影视类演出一枚都不补——它的基线是刻意收紧的", async () => {
    expect(await roleKeys(snapshot!.filmRoleId)).toHaveLength(0);
  });

  it.skipIf(!snapshot)("音乐类演出：拿到基线与挂载上传，但拿不到戏剧的角色键", async () => {
    const keys = await roleKeys(snapshot!.albumComposerRoleId);
    for (const key of BASELINE_DRIFT_KEYS) expect(keys).toContain(key);
    for (const key of MOUNT_UPLOAD_KEYS) expect(keys).toContain(key);
    // 同名不同级：戏剧的作曲有建 cue 表的资格，音乐类那套模版没有这个概念
    expect(keys).not.toContain("node:cue_list/*@create");
  });

  it.skipIf(!snapshot)("重放迁移插入零行（幂等）", () => {
    // global-setup 紧接首跑重放了一次迁移 SQL，各语句插入行数之和记进快照。
    expect(snapshot!.secondRunInsertedRows).toBe(0);
  });
});
