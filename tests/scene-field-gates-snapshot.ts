/**
 * Pre-migration snapshot for migrate-scene-field-gates（scene 字段门对齐）.
 *
 * PRE 判据：grant_template 里「编剧」尚无 scene 的 meta/name@edit 字段键。
 *
 * 工厂造的是**迁移要动的两类行**：
 *   - 命中角色（编剧 / 戏剧构作）的 role 区间，含空转的 meta@edit 与一枚无关键
 *   - 不命中的角色（导演），用来证明迁移没有波及其他角色
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const SCENE_FIELD_GATES_SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  "scene-field-gates-migration-snapshot.json",
);

export type SceneFieldGatesSnapshot = {
  productionId: string;
  playwrightRoleId: string;   // 「编剧」——迁移应补四枚字段键、删 meta@edit
  dramaturgRoleId: string;    // 「戏剧构作」——同上
  directorRoleId: string;     // 「导演」——不在名单，应原样不动
};

export async function isSceneFieldGatesPreMigrationSchema(pool: Pool): Promise<boolean> {
  // grant_template 已退役（#163）：表没了就说明库早已越过这支迁移。
  const { rows: exists } = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'grant_template'`,
  );
  if (exists.length === 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM grant_template
     WHERE role_name = '编剧' AND permission_key = 'node:scene/*/meta/name@edit'`,
  );
  return rows.length === 0;
}

export async function createSceneFieldGatesPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<SceneFieldGatesSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)", [
    productionId, `字段门迁移工厂-${faker.string.alphanumeric(4)}`, testUserId,
  ]);

  const mkRole = async (name: string, keys: string[]): Promise<string> => {
    const roleId = `role_sfg_${faker.string.alphanumeric(8)}`;
    await pool.query(
      "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
      [roleId, productionId, name],
    );
    for (const key of keys) {
      await pool.query(
        `INSERT INTO production_role_permission (role_id, permission_key)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, key],
      );
    }
    return roleId;
  };

  // 空转的 meta@edit（迁移要删）+ 一枚必须原样存续的无关键
  const playwrightRoleId = await mkRole("编剧", [
    "node:scene/*/meta@edit",
    "node:scene/*/synopsis@edit",
  ]);
  const dramaturgRoleId = await mkRole("戏剧构作", [
    "node:scene/*/meta@edit",
  ]);
  // 名单外角色：迁移不该给它补任何字段键
  const directorRoleId = await mkRole("导演", [
    "node:scene/*/music@edit",
  ]);

  return { productionId, playwrightRoleId, dramaturgRoleId, directorRoleId };
}
