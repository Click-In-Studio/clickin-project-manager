/**
 * Pre-migration snapshot for migrate-scene-char-tag-rest invariance（批E PR-E1）.
 * PRE 判据：resource_permission_level 仍有 ('scene','manage') 行。
 */
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { faker } from "@faker-js/faker";

export const SCENE_CHAR_TAG_REST_SNAPSHOT_PATH = path.join(os.tmpdir(), "scene-char-tag-rest-migration-snapshot.json");

export type SceneCharTagRestSnapshot = {
  productionId: string;
  sceneId: string;
  renameUserId: string;   // scene:rename 万能代理持有者
  viewUserId: string;     // scene:view + character:view
  manageUserId: string;   // RG scene manage
  roleId: string;
};

export async function isSceneCharTagRestPreMigrationSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM resource_permission_level
     WHERE resource_type = 'scene' AND permission_level = 'manage'`,
  );
  return rows.length > 0;
}

async function makeUser(pool: Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO app_user (created_at) VALUES (NOW()) RETURNING id",
  );
  await pool.query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW())`,
    [`test-sct-${faker.string.alphanumeric(10)}`, rows[0].id, name],
  );
  return rows[0].id;
}

export async function createSceneCharTagRestPreMigrationData(
  pool: Pool,
  testUserId: string,
): Promise<SceneCharTagRestSnapshot> {
  const productionId = `t${faker.string.alphanumeric(7).toLowerCase()}`;
  await pool.query("INSERT INTO production (id, name) VALUES ($1, $2)", [
    productionId, `批E1迁移工厂-${faker.string.alphanumeric(4)}`,
  ]);
  const versionId = `${productionId}_v1`;
  await pool.query(
    "INSERT INTO version (id, production_id, name, created_at) VALUES ($1, $2, 'initial', NOW())",
    [versionId, productionId],
  );
  const sceneId = `sc_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO scene (id, production_id) VALUES ($1, $2)",
    [sceneId, productionId],
  );

  const renameUserId = await makeUser(pool, "批E1-rename");
  const viewUserId = await makeUser(pool, "批E1-view");
  const manageUserId = await makeUser(pool, "批E1-scene-manage");

  await pool.query(
    `INSERT INTO atomic_permission_grant
       (production_id, user_id, permission_key, grant_source, confirmed_by)
     VALUES ($1, $2, 'scene:rename',    'self_confirmed', $2),
            ($1, $3, 'scene:view',      'self_confirmed', $3),
            ($1, $3, 'character:view',  'self_confirmed', $3)`,
    [productionId, renameUserId, viewUserId],
  );

  await pool.query(
    `INSERT INTO resource_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'scene', $3, '*', 'manage', 'direct', $2)`,
    [productionId, manageUserId, sceneId],
  );

  const roleId = `role_sct_${faker.string.alphanumeric(8)}`;
  await pool.query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3)",
    [roleId, productionId, `批E1角色${faker.string.alphanumeric(4)}`],
  );
  await pool.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'scene:rename'), ($1, 'tag_option:rename'), ($1, 'character:set_members')`,
    [roleId],
  );

  return { productionId, sceneId, renameUserId, viewUserId, manageUserId, roleId };
}
