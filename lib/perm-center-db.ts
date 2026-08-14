import { getPool } from "./pg";
import { parseNodeKey } from "./grant-template";

// 管理后台·权限中心数据层：部门权限行（production_dept_permission 区间）
// 与权限键词汇（resource_permission_level + 全库在用键的 sub 面）。

/** 全项目部门权限行：dept_id → permission_key[]。 */
export async function listDeptPermissionRows(productionId: string): Promise<Record<string, string[]>> {
  const res = await getPool().query<{ dept_id: string; permission_key: string }>(
    `SELECT dept_id, permission_key FROM production_dept_permission
     WHERE production_id = $1 ORDER BY permission_key`,
    [productionId],
  );
  const out: Record<string, string[]> = {};
  for (const r of res.rows) {
    (out[r.dept_id] ??= []).push(r.permission_key);
  }
  return out;
}

/** 全量替换一个部门的权限行（多退少补，事务）。 */
export async function setDeptPermissionRows(
  productionId: string,
  deptId: string,
  keys: string[],
): Promise<void> {
  const uniq = [...new Set(keys)];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM production_dept_permission
       WHERE production_id = $1 AND dept_id = $2 AND permission_key <> ALL($3::text[])`,
      [productionId, deptId, uniq],
    );
    for (const key of uniq) {
      await client.query(
        `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
         VALUES ($1, $2, $3) ON CONFLICT (dept_id, permission_key) DO NOTHING`,
        [productionId, deptId, key],
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

export type PermissionVocabulary = {
  /** resource_type → 合法动词（词汇表序） */
  verbs: Record<string, string[]>;
  /** resource_type → 全库在用的 sub 面（含保留段），供 picker 提示 */
  subs: Record<string, string[]>;
};

/** 权限键词汇：动词=resource_permission_level 闭集；sub 面从模版层+
 *  三区间表在用键聚合（提示性，picker 仍允许自由输入）。 */
export async function getPermissionVocabulary(productionId: string): Promise<PermissionVocabulary> {
  const pool = getPool();
  const [levelRes, keysRes] = await Promise.all([
    pool.query<{ resource_type: string; permission_level: string }>(
      `SELECT resource_type, permission_level FROM resource_permission_level
       ORDER BY resource_type, sort_order`,
    ),
    pool.query<{ permission_key: string }>(
      `SELECT DISTINCT permission_key FROM grant_template
       UNION
       SELECT DISTINCT prp.permission_key FROM production_role_permission prp
       JOIN production_role pr ON pr.id = prp.role_id WHERE pr.production_id = $1
       UNION
       SELECT DISTINCT permission_key FROM production_dept_permission WHERE production_id = $1
       UNION
       SELECT DISTINCT permission FROM production_member_permission WHERE production_id = $1`,
      [productionId],
    ),
  ]);

  const verbs: Record<string, string[]> = {};
  for (const r of levelRes.rows) {
    (verbs[r.resource_type] ??= []).push(r.permission_level);
  }

  const subSets: Record<string, Set<string>> = {};
  for (const r of keysRes.rows) {
    const parsed = parseNodeKey(r.permission_key);
    if (!parsed || !(parsed.resourceType in verbs)) continue;
    (subSets[parsed.resourceType] ??= new Set()).add(parsed.resourceSub);
  }
  const subs: Record<string, string[]> = {};
  for (const [type, set] of Object.entries(subSets)) {
    subs[type] = [...set].sort();
  }
  return { verbs, subs };
}
