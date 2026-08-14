import { getPool } from "./pg";
import type { Pool, PoolClient } from "pg";

// ─── Cue 表权限模版体系（§3.5，2026-08-13 用户设计定稿）───────────────────────
//
// dept_cue_list_template：类型 × 权限声明——一张表统一"谁能建"（can_create）与
// "谁受益什么"（permissions 纯相对键数组）。
// **本基建之后 cue 模版即完全可配置**：声明行是普通数据（部门模版自动附带 +
// 管理面手动增删改），未来可开放项目自定义 cue 模版类型——新增类型零代码，
// 只需声明行 + CUE_LIST_TEMPLATES 展示配置。
// 相对键实例化：'@view' → node:cue_list/<id>@view；'cues@create' →
// node:cue_list/<id>/cues@create；'grants@edit' → node:cue_list/<id>/grants@edit。

export type DeptCueTemplate = {
  productionId: string;
  deptId: string;
  template: string;
  canCreate: boolean;
  permissions: string[];
};

export function instantiateRelKey(cueListId: string, rel: string): string {
  // '@verb' → 实例本体；'sub@verb' → 实例子面
  if (rel.startsWith("@")) return `node:cue_list/${cueListId}${rel}`;
  const [sub, verb] = rel.split("@");
  return `node:cue_list/${cueListId}/${sub}@${verb}`;
}

/** creator 是否可经声明表以该模版建表（can_create 门；区间兜底由调用方 OR）。 */
export async function canCreateViaTemplate(
  userId: string,
  productionId: string,
  template: string,
  db: Pool | PoolClient = getPool(),
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dept_cue_list_template t
       JOIN production_dept_member pdm
         ON pdm.dept_id = t.dept_id AND pdm.production_id = t.production_id
       WHERE t.production_id = $1 AND t.template = $2 AND t.can_create
         AND pdm.user_id = $3
     ) AS ok`,
    [productionId, template, userId],
  );
  return rows[0]?.ok ?? false;
}

/** 建表定式（C-1 进化）：∀ (dept, template) 声明行 → permissions 实例化写入
 *  production_dept_permission（区间非 grant：自确认进入/伞语义下传/退出 recompute 撤销）。 */
export async function applyCueTemplateGrants(
  client: Pool | PoolClient,
  productionId: string,
  cueListId: string,
  template: string,
): Promise<void> {
  await client.query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     SELECT t.production_id, t.dept_id,
            CASE WHEN rel LIKE '@%'
                 THEN 'node:cue_list/' || $2 || rel
                 ELSE 'node:cue_list/' || $2 || '/' || rel
            END
     FROM dept_cue_list_template t
     CROSS JOIN LATERAL unnest(t.permissions) AS rel
     WHERE t.production_id = $1 AND t.template = $3
     ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [productionId, cueListId, template],
  );
}

/** 声明变更传播：对存量同模版表补发（增改行后调用）。撤销声明的收键单独走
 *  removeCueTemplateGrants。 */
export async function propagateTemplateToExisting(
  productionId: string,
  deptId: string,
  template: string,
): Promise<number> {
  const pool = getPool();
  const decl = await pool.query<{ permissions: string[] }>(
    "SELECT permissions FROM dept_cue_list_template WHERE dept_id = $1 AND template = $2",
    [deptId, template],
  );
  if (decl.rows.length === 0) return 0;
  // 单条 INSERT...SELECT：原子（review finding——循环逐行写入非原子）
  const res = await pool.query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     SELECT $1, $2,
            CASE WHEN r.rel LIKE '@%'
                 THEN 'node:cue_list/' || cl.id || r.rel
                 ELSE 'node:cue_list/' || cl.id || '/' || r.rel
            END
     FROM cue_list cl
     CROSS JOIN (
       SELECT unnest(permissions) AS rel
       FROM dept_cue_list_template WHERE dept_id = $2 AND template = $3
     ) r
     WHERE cl.production_id = $1 AND cl.template = $3
     ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [productionId, deptId, template],
  );
  return res.rowCount ?? 0;
}

/** 撤销声明：收走该 (dept, template) 对存量表的实例区间键；
 *  已自确认的行由 recompute 存续判定自然处理（零新机制）。 */
export async function removeCueTemplateGrants(
  productionId: string,
  deptId: string,
  template: string,
): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM production_dept_permission pdp
     USING cue_list cl
     WHERE pdp.dept_id = $2 AND pdp.production_id = $1
       AND cl.production_id = $1 AND cl.template = $3
       AND pdp.permission_key LIKE 'node:cue_list/' || cl.id || '%'`,
    [productionId, deptId, template],
  );
  return res.rowCount ?? 0;
}

/** 用户可建的 cue 模版清单（声明表 can_create 路径；区间兜底由调用方并集）。 */
export async function listCreatableTemplates(
  userId: string,
  productionId: string,
): Promise<string[]> {
  const { rows } = await getPool().query<{ template: string }>(
    `SELECT DISTINCT t.template
     FROM dept_cue_list_template t
     JOIN production_dept_member pdm
       ON pdm.dept_id = t.dept_id AND pdm.production_id = t.production_id
     WHERE t.production_id = $1 AND t.can_create AND pdm.user_id = $2
     ORDER BY 1`,
    [productionId, userId],
  );
  return rows.map(r => r.template);
}

// ─── 管理面：声明行 CRUD（权限模版页）────────────────────────────────────────

/** 全项目声明行（管理面列表用）。 */
export async function listDeptCueTemplates(productionId: string): Promise<DeptCueTemplate[]> {
  const { rows } = await getPool().query<{
    production_id: string; dept_id: string; template: string; can_create: boolean; permissions: string[];
  }>(
    `SELECT production_id, dept_id, template, can_create, permissions
     FROM dept_cue_list_template WHERE production_id = $1
     ORDER BY template, dept_id`,
    [productionId],
  );
  return rows.map(r => ({
    productionId: r.production_id,
    deptId: r.dept_id,
    template: r.template,
    canCreate: r.can_create,
    permissions: r.permissions,
  }));
}

/** UPSERT 声明行并对存量同模版表重算实例区间键（先收旧键再按新键补发，
 *  保证减键即时生效；已自确认 grant 由 recompute 存续判定处理）。 */
export async function upsertDeptCueTemplate(
  productionId: string,
  deptId: string,
  template: string,
  canCreate: boolean,
  permissions: string[],
): Promise<void> {
  const uniq = [...new Set(permissions)];
  await getPool().query(
    `INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dept_id, template)
     DO UPDATE SET can_create = EXCLUDED.can_create, permissions = EXCLUDED.permissions`,
    [productionId, deptId, template, canCreate, uniq],
  );
  await removeCueTemplateGrants(productionId, deptId, template);
  await propagateTemplateToExisting(productionId, deptId, template);
}

/** 删除声明行并收走其对存量表的实例区间键。 */
export async function deleteDeptCueTemplate(
  productionId: string,
  deptId: string,
  template: string,
): Promise<void> {
  await getPool().query(
    "DELETE FROM dept_cue_list_template WHERE production_id = $1 AND dept_id = $2 AND template = $3",
    [productionId, deptId, template],
  );
  await removeCueTemplateGrants(productionId, deptId, template);
}
