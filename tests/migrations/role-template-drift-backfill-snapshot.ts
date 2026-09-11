/**
 * Pre-migration snapshot for migrate-role-template-drift-backfill invariance tests.
 *
 * 无谓词，setup 无条件建厂+迁移：数据回填在空库（CI）测不出"未迁移形态"，数据
 * 谓词恒 false 会让 invariance 在最需要它的 PR CI 里整段跳过；本迁移按角色名与
 * 演出类型 scoped 且幂等，重放对已迁移库无副作用（沿用 asset-upload-zone 的口径）。
 *
 * createPreMigrationData 造三个演出，覆盖迁移的三段与两条排除：
 *   legacy (type 空 → 回落戏剧模版)
 *     作曲       零键     → ① 基线 + ② 挂载上传 + ③ 戏剧角色键 全都该拿到
 *     舞台监督   零键     → ① + ③（event / task 那几枚）
 *     制作助理   零键     → ① + ③（phase 写面）
 *     极限写歌   零键     → 只该拿 ①（模版名单外的自建角色没有 ③）
 *     制作人     持通配   → 一枚都不该补（node:*\/*@* 已覆盖一切）
 *     道具设计   弃用     → 一枚都不该补
 *   film (type='film')      导演 → 一枚都不该补（影视基线刻意收紧，①③ 都排除）
 *   album (type='album')    作曲 → ①② 该有，③ 不该有（同名不同级）
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const ROLE_DRIFT_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "role-template-drift-backfill-migration-snapshot.json",
);

/** ② 段：作曲 / 编曲 的挂载与上传（不限演出类型）。 */
export const MOUNT_UPLOAD_KEYS = [
  "node:scene/*/mounts@create",
  "node:script/*/mounts@create",
  "node:asset/*@create",
] as const;

/** ① 段里此前缺失的那四枚（基线演进未回填的账）。 */
export const BASELINE_DRIFT_KEYS = [
  "node:finance/*/categories@view",
  "node:finance/*/expenses@create",
  "node:material/*@view",
  "node:phase/*@view",
] as const;

export const WILDCARD_KEY = "node:*/*@*";

export type RoleDriftSnapshot = {
  legacyProdId: string;
  composerRoleId: string;
  stageManagerRoleId: string;
  assistantRoleId: string;
  customRoleId: string;
  wildcardRoleId: string;
  deprecatedRoleId: string;
  filmProdId: string;
  filmRoleId: string;
  albumProdId: string;
  albumComposerRoleId: string;
  /** 幂等验证：global-setup 里第二次执行迁移 SQL 的总插入行数（应为 0）。 */
  secondRunInsertedRows?: number;
};

export async function createRoleDriftPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<RoleDriftSnapshot> {
  const makeProd = async (type: string | null): Promise<string> => {
    const prodId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
    await pool.query(
      "INSERT INTO production (id, name, owner_id, type) VALUES ($1, $2, $3, $4)",
      [prodId, faker.company.name(), testUserId, type],
    );
    // 主本随建（script-view 迁移的整体性断言要求每个演出都有主本；本块排在那支
    // 迁移之后，裸 production 不会再被它回填）
    const viewId = `sv_${faker.string.alphanumeric(10).toLowerCase()}`;
    await pool.query(
      "INSERT INTO script_view (id, production_id, name) VALUES ($1, $2, '标准本')",
      [viewId, prodId],
    );
    await pool.query("UPDATE production SET master_view_id = $1 WHERE id = $2", [viewId, prodId]);
    return prodId;
  };
  const makeRole = async (prodId: string, name: string, deprecated = false): Promise<string> => {
    const roleId = `role${faker.string.alphanumeric(8).toLowerCase()}`;
    await pool.query(
      "INSERT INTO production_role (id, production_id, name, is_deprecated) VALUES ($1, $2, $3, $4)",
      [roleId, prodId, name, deprecated],
    );
    return roleId;
  };

  const legacyProdId = await makeProd(null);
  const composerRoleId = await makeRole(legacyProdId, "作曲");
  const stageManagerRoleId = await makeRole(legacyProdId, "舞台监督");
  const assistantRoleId = await makeRole(legacyProdId, "制作助理");
  const customRoleId = await makeRole(legacyProdId, "极限写歌");
  const deprecatedRoleId = await makeRole(legacyProdId, "道具设计", true);
  const wildcardRoleId = await makeRole(legacyProdId, "制作人");
  await pool.query(
    "INSERT INTO production_role_permission (role_id, permission_key) VALUES ($1, $2)",
    [wildcardRoleId, WILDCARD_KEY],
  );

  const filmProdId = await makeProd("film");
  const filmRoleId = await makeRole(filmProdId, "导演");

  const albumProdId = await makeProd("album");
  const albumComposerRoleId = await makeRole(albumProdId, "作曲");

  return {
    legacyProdId, composerRoleId, stageManagerRoleId, assistantRoleId,
    customRoleId, wildcardRoleId, deprecatedRoleId,
    filmProdId, filmRoleId,
    albumProdId, albumComposerRoleId,
  };
}
