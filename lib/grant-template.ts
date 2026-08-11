/**
 * Grant Template — 行集模板解析（总表 §0.7 三层管线的"模板/资格"层）。
 *
 * 模板行只是资格：生效需 self-confirm 写 resource_grant 个人行（激活层），
 * 存续由 recomputeAndRevokeGrants 按"资格仍在"判定（存续层）。
 *
 * 解析规则：
 *   - holder = 我的角色（production_member_role）∪ 我的部门及其全部祖先（伞语义）
 *   - 覆盖：某 holder 在演出级（production_id 非空）有任何行 → 只用演出级行；
 *     否则回落全局行（role 按名字匹配；member base 全局 holder_name='*'，
 *     演出级对应 holder_id='*'）
 *   - 节点匹配与 lib/grant-check.ts 同构：(id|'*')×(sub|'*')，保留段不被通配覆盖
 */
import { getPool } from "./pg";
import { hasGrant, isReservedSub, type GrantVerb } from "./grant-check";

export type TemplateRow = {
  resourceType: string;
  resourceId: string;
  resourceSub: string;
  verb: GrantVerb;
};

type RawRow = {
  production_id: string | null;
  holder_type: string;
  holder_id: string | null;
  holder_name: string | null;
  resource_type: string;
  resource_id: string;
  resource_sub: string;
  verb: GrantVerb;
};

/** 用户在该演出的全部生效模板行（覆盖语义已应用）。 */
export async function getUserTemplateRows(
  userId: string,
  productionId: string,
): Promise<TemplateRow[]> {
  const pool = getPool();

  const [rolesRes, deptsRes] = await Promise.all([
    pool.query<{ role_id: string; role_name: string }>(
      `SELECT pmr.role_id, pr.name AS role_name
       FROM production_member_role pmr
       JOIN production_role pr ON pr.id = pmr.role_id
       WHERE pmr.production_id = $1 AND pmr.user_id = $2`,
      [productionId, userId],
    ),
    // 我的部门 + 全部祖先（伞语义：父组模板行覆盖子部门成员）
    pool.query<{ dept_id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT pd.id, pd.parent_id
         FROM production_dept_member pdm
         JOIN production_dept pd ON pd.id = pdm.dept_id
         WHERE pdm.production_id = $1 AND pdm.user_id = $2
         UNION
         SELECT pd2.id, pd2.parent_id
         FROM production_dept pd2
         JOIN chain c ON pd2.id = c.parent_id
       )
       SELECT id AS dept_id FROM chain`,
      [productionId, userId],
    ),
  ]);

  const roleIds = rolesRes.rows.map((r) => r.role_id);
  const roleNames = rolesRes.rows.map((r) => r.role_name);
  const deptIds = deptsRes.rows.map((r) => r.dept_id);

  const { rows } = await pool.query<RawRow>(
    `SELECT production_id, holder_type, holder_id, holder_name,
            resource_type, resource_id, resource_sub, verb
     FROM grant_template
     WHERE
       -- 演出级 role 行（含 member base holder_id='*'）
       (production_id = $1 AND holder_type = 'role' AND holder_id = ANY($2 || ARRAY['*']))
       -- 全局 role 行（通用模板；per-type 模板未启用）
       OR (production_id IS NULL AND production_type IS NULL AND holder_type = 'role'
           AND holder_name = ANY($3 || ARRAY['*']))
       -- 演出级 dept 行（本部门及祖先）
       OR (production_id = $1 AND holder_type = 'dept' AND holder_id = ANY($4))`,
    [productionId, roleIds, roleNames, deptIds],
  );

  // 覆盖语义：holder 有演出级行 → 丢弃其全局行。
  // 全局行的 holder 标识是名字；对应的演出级标识是 role_id（member base 为 '*'）。
  const roleIdByName = new Map(rolesRes.rows.map((r) => [r.role_name, r.role_id]));
  const prodHolders = new Set(
    rows.filter((r) => r.production_id !== null).map((r) => `${r.holder_type}:${r.holder_id}`),
  );

  const effective: TemplateRow[] = [];
  for (const r of rows) {
    if (r.production_id === null) {
      const prodEquivalent = r.holder_name === "*" ? "*" : roleIdByName.get(r.holder_name!) ?? null;
      if (prodEquivalent !== null && prodHolders.has(`role:${prodEquivalent}`)) continue; // 被演出级覆盖
    }
    effective.push({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      resourceSub: r.resource_sub,
      verb: r.verb,
    });
  }
  return effective;
}

/** 节点匹配（与 hasGrant 同构：精确 + '*'，保留段必须显式）。 */
export function templateMatchesNode(
  row: TemplateRow,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): boolean {
  if (row.resourceType !== resourceType || row.verb !== verb) return false;
  if (row.resourceId !== resourceId && row.resourceId !== "*") return false;
  if (row.resourceSub === resourceSub) return true;
  return row.resourceSub === "*" && !isReservedSub(resourceSub);
}

/** 用户对指定节点是否有模板资格（未激活也算——资格≠生效）。 */
export async function hasTemplateEligibility(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<boolean> {
  const rows = await getUserTemplateRows(userId, productionId);
  return rows.some((r) => templateMatchesNode(r, resourceType, resourceId, resourceSub, verb));
}

// ─── 节点字符串键 ──────────────────────────────────────────────────────────────
// 激活面（my-permissions / PageActivationGate）用字符串键承载树节点，与原子键
// 同走一条 pending/confirm 管道：`node:<type>/<id>/<sub...>@<verb>`。

export type NodeKeyParts = {
  resourceType: string;
  resourceId: string;
  resourceSub: string;
  verb: GrantVerb;
};

const NODE_KEY_RE = /^node:([a-z_]+)\/([^/@]+)(?:\/([^@]+))?@(view|create|edit|delete)$/;

export function parseNodeKey(key: string): NodeKeyParts | null {
  const m = NODE_KEY_RE.exec(key);
  if (!m) return null;
  return { resourceType: m[1], resourceId: m[2], resourceSub: m[3] ?? "*", verb: m[4] as GrantVerb };
}

export function formatNodeKey(n: NodeKeyParts): string {
  const sub = n.resourceSub === "*" ? "" : `/${n.resourceSub}`;
  return `node:${n.resourceType}/${n.resourceId}${sub}@${n.verb}`;
}

// ─── 路由面组合判定 ────────────────────────────────────────────────────────────
// 与 canAccess() 同构的三态：生效（admin/owner 旁路或个人行）→ 可自我确认
// （模板资格未激活）→ 走申请流。最小权限模型：模板从不直接授权。

export type NodeAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "needs_self_confirm" | "needs_approval" };

export async function canAccessNode(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<NodeAccessResult> {
  if (ctx.isAdmin || ctx.isOwner) return { allowed: true };
  if (await hasGrant(ctx.userId, productionId, resourceType, resourceId, resourceSub, verb)) {
    return { allowed: true };
  }
  if (await hasTemplateEligibility(ctx.userId, productionId, resourceType, resourceId, resourceSub, verb)) {
    return { allowed: false, reason: "needs_self_confirm" };
  }
  return { allowed: false, reason: "needs_approval" };
}

/** self-confirm 激活：把用户持有模板资格的行落成 resource_grant 个人行。
 *  只落用户实际有资格的行（防伪造）；幂等。返回实际写入数。 */
export async function selfConfirmTemplateNodes(
  userId: string,
  productionId: string,
  nodes: Array<{ resourceType: string; resourceId: string; resourceSub: string; verb: GrantVerb }>,
): Promise<number> {
  const templates = await getUserTemplateRows(userId, productionId);
  let written = 0;
  for (const n of nodes) {
    const eligible = templates.some((t) =>
      templateMatchesNode(t, n.resourceType, n.resourceId, n.resourceSub, n.verb),
    );
    if (!eligible) continue;
    const res = await getPool().query(
      `INSERT INTO resource_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'self_confirmed', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false
       DO NOTHING`,
      [productionId, userId, n.resourceType, n.resourceId, n.resourceSub, n.verb],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}
