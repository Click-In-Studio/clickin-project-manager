/**
 * 权限判定链 — permission（免审批区间）与 grant（访问权）二分（总表 §0.8）。
 *
 * permission = 资格，三张演出内表（六步链的 2-5 步资格源）：
 *   production_dept_permission   dept 区间（第 3 步；含 dept 树祖先，伞语义）
 *   production_role_permission   role 区间（第 4 步）
 *   production_member_permission 个人 override（granted=false 第 2 步拒绝区间 /
 *                                granted=true 第 5 步个人区间）
 * grant = 访问权，单表 resource_grant（第 1 步；终局更名 production_member_grant）。
 *
 * 六步判定链（canAccessNode）：
 *   1. 有 grant 行 → 操作（admin/owner 旁路视作恒有）
 *   2. 个人拒绝区间 → 直接申请流（deny 不否决已有行——撤销走 sweep，判定只信行）
 *   3. dept 区间 → 可自我确认（写入 grant）
 *   4. role 区间 → 可自我确认
 *   5. 个人允许区间 → 可自我确认
 *   6. 申请流
 *
 * 词汇统一：permission 表的 permission_key 与激活面同格式——迁移期原子键与
 * 树节点串 `node:<type>/<id>[/<sub>]@<verb>` 同列共存；zone 键与 grant 键时刻一致。
 *
 * grant_template（全局模板）运行时零读取：仅在演出/角色创建时按 production_type
 * seed 进 production_role_permission，之后演出自治。
 */
import { getPool } from "./pg";
import { hasGrant, isReservedSub, type GrantVerb } from "./grant-check";

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

/**
 * 能命中指定节点的全部键形态（含通配组合）。zone 查询用
 * `permission_key = ANY(candidates)` 完成通配匹配，无需在 SQL 里解析。
 * 保留段（grants/publication）不被 sub 通配覆盖。
 */
export function nodeKeyCandidates(n: NodeKeyParts): string[] {
  const ids = n.resourceId === "*" ? ["*"] : [n.resourceId, "*"];
  const subs = n.resourceSub === "*" || isReservedSub(n.resourceSub)
    ? [n.resourceSub]
    : [n.resourceSub, "*"];
  const out: string[] = [];
  for (const id of ids) {
    for (const sub of subs) {
      out.push(formatNodeKey({ resourceType: n.resourceType, resourceId: id, resourceSub: sub, verb: n.verb }));
    }
  }
  return out;
}

// ─── 三层资格源查询 ────────────────────────────────────────────────────────────

/** dept 区间：本部门及全部祖先（伞语义）持有的匹配键。 */
async function deptZoneHit(
  userId: string, productionId: string, candidates: string[],
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       WITH RECURSIVE chain AS (
         SELECT pd.id, pd.parent_id
         FROM production_dept_member pdm
         JOIN production_dept pd ON pd.id = pdm.dept_id
         WHERE pdm.production_id = $1 AND pdm.user_id = $2
         UNION
         SELECT pd2.id, pd2.parent_id
         FROM production_dept pd2 JOIN chain c ON pd2.id = c.parent_id
       )
       SELECT 1 FROM production_dept_permission pdp
       JOIN chain ON chain.id = pdp.dept_id
       WHERE pdp.production_id = $1 AND pdp.permission_key = ANY($3)
     ) AS ok`,
    [productionId, userId, candidates],
  );
  return rows[0]?.ok ?? false;
}

/** role 区间：用户全部角色持有的匹配键。 */
async function roleZoneHit(
  userId: string, productionId: string, candidates: string[],
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM production_member_role pmr
       JOIN production_role_permission prp ON prp.role_id = pmr.role_id
       WHERE pmr.production_id = $1 AND pmr.user_id = $2
         AND prp.permission_key = ANY($3)
     ) AS ok`,
    [productionId, userId, candidates],
  );
  return rows[0]?.ok ?? false;
}

/** 个人 override：返回匹配键的 granted 值（deny 优先于 allow）。 */
async function memberOverrideHit(
  userId: string, productionId: string, candidates: string[],
): Promise<"deny" | "allow" | null> {
  const { rows } = await getPool().query<{ granted: boolean }>(
    `SELECT granted FROM production_member_permission
     WHERE production_id = $1 AND user_id = $2 AND permission = ANY($3)`,
    [productionId, userId, candidates],
  );
  if (rows.length === 0) return null;
  return rows.some((r) => !r.granted) ? "deny" : "allow";
}

// ─── 六步判定链 ────────────────────────────────────────────────────────────────

export type NodeAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "needs_self_confirm"; source: "dept" | "role" | "personal" }
  | { allowed: false; reason: "needs_approval" }
  // no_entry：SENSITIVE 无区间（连审批入口都没有）/ ROOT 非 owner
  | { allowed: false; reason: "no_entry" };


// ─── SENSITIVE / ROOT 节点（批F，用户定谳的三态语义）────────────────────────────
// SENSITIVE：区间行 = 审批流入口资格（有区间可申请、无区间连入口都没有），
// 区间命中也**永不自确认**——必须经 owner 审批流发行。
// ROOT：owner-only，连审批通道都没有。
export function isRootNode(resourceType: string, resourceSub: string, verb: string): boolean {
  return resourceType === "production"
    && ((resourceSub === "*" && verb === "delete")
      || resourceSub === "owner" || resourceSub === "restores");
}

export function isSensitiveNode(resourceType: string, resourceSub: string, verb: string): boolean {
  if (isRootNode(resourceType, resourceSub, verb)) return false;
  if (resourceType === "producer") return true;
  if (resourceType === "production")
    return resourceSub.startsWith("meta") || resourceSub === "archival" || resourceSub === "integrations";
  if (resourceType === "member" && resourceSub.startsWith("imports")) return true;
  return false;
}

export async function canAccessNode(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<NodeAccessResult> {
  // 1. grant（admin/owner 旁路）
  if (ctx.isAdmin || ctx.isOwner) return { allowed: true };
  if (await hasGrant(ctx.userId, productionId, resourceType, resourceId, resourceSub, verb)) {
    return { allowed: true };
  }
  // ROOT：owner-only（第 1 步旁路已处理 owner），此处一律无入口
  if (isRootNode(resourceType, resourceSub, verb)) {
    return { allowed: false, reason: "no_entry" };
  }
  const node: NodeKeyParts = { resourceType, resourceId, resourceSub, verb };
  const candidates = nodeKeyCandidates(node);
  const sensitive = isSensitiveNode(resourceType, resourceSub, verb);
  // 2/5. 个人 override（deny 短路一切区间）
  const override = await memberOverrideHit(ctx.userId, productionId, candidates);
  if (override === "deny") return { allowed: false, reason: "needs_approval" };
  // 3. dept 区间（sensitive：区间=审批入口资格，不自确认）
  if (await deptZoneHit(ctx.userId, productionId, candidates)) {
    return sensitive
      ? { allowed: false, reason: "needs_approval" }
      : { allowed: false, reason: "needs_self_confirm", source: "dept" };
  }
  // 4. role 区间
  if (await roleZoneHit(ctx.userId, productionId, candidates)) {
    return sensitive
      ? { allowed: false, reason: "needs_approval" }
      : { allowed: false, reason: "needs_self_confirm", source: "role" };
  }
  // 5. 个人允许区间
  if (override === "allow") {
    return sensitive
      ? { allowed: false, reason: "needs_approval" }
      : { allowed: false, reason: "needs_self_confirm", source: "personal" };
  }
  // 6. sensitive 无区间=连申请入口都没有；普通节点=申请流
  return sensitive
    ? { allowed: false, reason: "no_entry" }
    : { allowed: false, reason: "needs_approval" };
}

/** 节点是否在用户免审批区间内（deny 生效；不含已有 grant）。 */
export async function hasZoneEligibility(
  userId: string,
  productionId: string,
  node: NodeKeyParts,
): Promise<boolean> {
  const candidates = nodeKeyCandidates(node);
  const override = await memberOverrideHit(userId, productionId, candidates);
  if (override === "deny") return false;
  if (override === "allow") return true;
  if (await deptZoneHit(userId, productionId, candidates)) return true;
  return roleZoneHit(userId, productionId, candidates);
}

/** self-confirm 激活：把用户区间内的节点落成 resource_grant 个人行（防伪造，幂等）。 */
export async function selfConfirmTemplateNodes(
  userId: string,
  productionId: string,
  nodes: NodeKeyParts[],
): Promise<number> {
  let written = 0;
  for (const n of nodes) {
    // SENSITIVE 节点永不自确认（区间只是审批入口资格）
    if (isSensitiveNode(n.resourceType, n.resourceSub, n.verb)) continue;
    if (isRootNode(n.resourceType, n.resourceSub, n.verb)) continue;
    if (!(await hasZoneEligibility(userId, productionId, n))) continue;
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

// ─── 全局模板 seed（创建时注入，运行时零读取） ─────────────────────────────────

/**
 * 按角色名（含 '*' 成员基础）取全局模板键：production_type 专属行优先，
 * 无则回落通用（production_type IS NULL）。
 */
export async function templateKeysForRole(
  roleName: string,
  productionType: string | null,
): Promise<string[]> {
  const { rows } = await getPool().query<{ permission_key: string }>(
    `SELECT DISTINCT permission_key FROM grant_template
     WHERE role_name IN ($1, '*')
       AND (production_type = $2 OR (production_type IS NULL AND NOT EXISTS (
              SELECT 1 FROM grant_template t2
              WHERE t2.role_name = grant_template.role_name
                AND t2.permission_key = grant_template.permission_key
                AND t2.production_type = $2
            )))`,
    [roleName, productionType],
  );
  return rows.map((r) => r.permission_key);
}

/** 把全局模板键 seed 进指定角色的 production_role_permission（幂等）。 */
export async function seedRoleFromTemplate(
  roleId: string,
  roleName: string,
  productionType: string | null,
): Promise<void> {
  const keys = await templateKeysForRole(roleName, productionType);
  if (keys.length === 0) return;
  await getPool().query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING`,
    [roleId, keys],
  );
}
