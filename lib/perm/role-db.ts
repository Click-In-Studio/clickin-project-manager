/**
 * 项目职位（production_role / production_role_permission 表）数据层：管理后台的
 * 职位 CRUD、权限键集合、复制职位，以及按名查职位（通讯录导入解析用）。
 *
 * ROLE_NAMES 默认名单是项目模版的一个 slot（production/production-template.ts），
 * 这里不认名单只认表；「制作人」等结构性职位的不可改不可删守卫在路由层与
 * member 侧（setMemberRoles）。
 */
import { getPool } from "../pg";

export type ProductionRole = {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
};

export async function listProductionRolesWithPermissions(productionId: string): Promise<ProductionRole[]> {
  const [rolesRes, permsRes] = await Promise.all([
    getPool().query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM production_role WHERE production_id = $1 ORDER BY name`,
      [productionId],
    ),
    getPool().query<{ role_id: string; permission_key: string }>(
      `SELECT prp.role_id, prp.permission_key
       FROM production_role_permission prp
       JOIN production_role pr ON pr.id = prp.role_id
       WHERE pr.production_id = $1`,
      [productionId],
    ),
  ]);
  const permMap = new Map<string, string[]>();
  for (const r of permsRes.rows) {
    const list = permMap.get(r.role_id) ?? [];
    list.push(r.permission_key);
    permMap.set(r.role_id, list);
  }
  return rolesRes.rows.map((r) => ({
    id: r.id, name: r.name,
    permissions: permMap.get(r.id) ?? [],
    createdAt: r.created_at.toISOString(),
  }));
}

let _roleSeq = 0;
function newRoleId(productionId: string) {
  return `r_${productionId.slice(0, 8)}_${Date.now().toString(36)}${(++_roleSeq).toString(36)}`;
}

export async function createProductionRole(productionId: string, name: string): Promise<ProductionRole> {
  const id = newRoleId(productionId);
  const res = await getPool().query<{ id: string; name: string; created_at: Date }>(
    `INSERT INTO production_role (id, production_id, name)
     VALUES ($1, $2, $3) RETURNING id, name, created_at`,
    [id, productionId, name],
  );
  const row = res.rows[0];
  // 自定义角色也获得基线键；名字命中本项目模版里的角色则一并 seed 那份。
  // 这仍是「创建时 seed」而非运行时读模版——判定端一行都不查模版。
  const prodType = (await getPool().query<{ type: string | null }>(
    "SELECT type FROM production WHERE id = $1", [productionId],
  )).rows[0]?.type ?? null;
  const { resolveTemplate } = await import("../production/production-template");
  const { roleKeys } = await import("../production/template-seeders/roles");
  const keys = roleKeys(resolveTemplate(prodType).roles, name);
  if (keys.length > 0) {
    await getPool().query(
      `INSERT INTO production_role_permission (role_id, permission_key)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [row.id, keys],
    );
  }
  const seeded = await getPool().query<{ permission_key: string }>(
    "SELECT permission_key FROM production_role_permission WHERE role_id = $1", [row.id],
  );
  return { id: row.id, name: row.name, permissions: seeded.rows.map((r) => r.permission_key), createdAt: row.created_at.toISOString() };
}

export async function renameProductionRole(roleId: string, productionId: string, name: string): Promise<void> {
  // 批G：制作人 role 身份不可变（改名后"防止移除"即名存实亡）
  const cur = await getPool().query<{ name: string }>(
    "SELECT name FROM production_role WHERE id = $1 AND production_id = $2", [roleId, productionId]);
  if (cur.rows[0]?.name === "制作人") throw new Error("制作人角色不可改名");

  await getPool().query(
    `UPDATE production_role SET name = $1 WHERE id = $2 AND production_id = $3`,
    [name, roleId, productionId],
  );
}

export async function deleteProductionRole(roleId: string, productionId: string): Promise<void> {
  // 批G：制作人 role 是结构性角色（通配区间宿主、seed/迁移按名匹配）——不可删除
  const res = await getPool().query(
    `DELETE FROM production_role WHERE id = $1 AND production_id = $2 AND name != '制作人'
     RETURNING id`,
    [roleId, productionId],
  );
  if (res.rows.length === 0) {
    const exists = await getPool().query(
      "SELECT 1 FROM production_role WHERE id = $1 AND production_id = $2", [roleId, productionId]);
    if (exists.rows.length > 0) throw new Error("制作人角色不可删除");
  }
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM production_role_permission WHERE role_id = $1`, [roleId]);
    if (permissions.length > 0) {
      await client.query(
        `INSERT INTO production_role_permission (role_id, permission_key)
         SELECT $1, unnest($2::text[])`,
        [roleId, permissions],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function copyProductionRole(productionId: string, sourceRoleId: string, newName: string): Promise<ProductionRole> {
  const pool = getPool();
  const newId = newRoleId(productionId);
  const sourcePerms = await pool.query<{ permission_key: string }>(
    `SELECT permission_key FROM production_role_permission WHERE role_id = $1`,
    [sourceRoleId],
  );
  const permissions = sourcePerms.rows.map((r) => r.permission_key);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ created_at: Date }>(
      `INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, $3) RETURNING created_at`,
      [newId, productionId, newName],
    );
    if (permissions.length > 0) {
      await client.query(
        `INSERT INTO production_role_permission (role_id, permission_key)
         SELECT $1, unnest($2::text[])`,
        [newId, permissions],
      );
    }
    await client.query("COMMIT");
    return { id: newId, name: newName, permissions, createdAt: res.rows[0].created_at.toISOString() };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}


/** Returns the set of role names defined for a production (from production_role table). */
export async function getProductionRoleNames(productionId: string): Promise<Set<string>> {
  const res = await getPool().query<{ name: string }>(
    `SELECT name FROM production_role WHERE production_id = $1`,
    [productionId],
  );
  return new Set(res.rows.map((r) => r.name));
}

/** Resolves role names to production_role IDs for the given production. */
export async function resolveRoleIdsByNames(productionId: string, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const res = await getPool().query<{ id: string }>(
    `SELECT id FROM production_role WHERE production_id = $1 AND name = ANY($2)`,
    [productionId, names]
  );
  return res.rows.map(r => r.id);
}
