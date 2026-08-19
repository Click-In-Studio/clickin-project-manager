/**
 * 权限判定链 — permission（免审批区间）与 grant（访问权）二分（总表 §0.8）。
 *
 * permission = 资格，三张演出内表（六步链的 2-5 步资格源）：
 *   production_dept_permission   dept 区间（第 3 步；含 dept 树祖先，伞语义）
 *   production_role_permission   role 区间（第 4 步）
 *   production_member_permission 个人 override（granted=false 第 2 步拒绝区间 /
 *                                granted=true 第 5 步个人区间）
 * grant = 访问权，单表 production_member_grant（第 1 步；终局更名 production_member_grant）。
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
import type { Pool, PoolClient } from "pg";
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

// 含通配位（type/verb 可为 *）的宽松键形——区间键语法（批G）
const WILDCARD_KEY_RE = /^node:([a-z_]+|\*)\/([^/@]+)(?:\/([^@]+))?@(view|create|edit|delete|\*)$/;

/** 键串是否命中治理键（SENSITIVE/ROOT 手写三态清单）。
 *  返回 null = 键非法。通配 type（node:*）不判治理——RESERVED_TYPES 保证
 *  通配候选不生成 production/producer，不穿透治理域；通配 verb 按四动词逐一判。 */
export function isGovernanceNodeKey(key: string): boolean | null {
  const m = WILDCARD_KEY_RE.exec(key);
  if (!m) return null;
  const [, type, , subRaw, verb] = m;
  const sub = subRaw ?? "*";
  if (type === "*") return false;
  const verbs = verb === "*" ? ["view", "create", "edit", "delete"] : [verb];
  return verbs.some(v => isRootNode(type, sub, v) || isSensitiveNode(type, sub, v));
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
/** 类型通配不覆盖的治理敏感类型（与 RESERVED_SUBS 对偶，批G 通配区间）：
 *  制作人主通配 node:* 不穿透治理域——SENSITIVE 三态由显式节点串表达。 */
export const RESERVED_TYPES: readonly string[] = ["production", "producer"];

export function nodeKeyCandidates(n: NodeKeyParts): string[] {
  const ids = n.resourceId === "*" ? ["*"] : [n.resourceId, "*"];
  const subs = n.resourceSub === "*" || isReservedSub(n.resourceSub)
    ? [n.resourceSub]
    : [n.resourceSub, "*"];
  // 批G 通配区间：type / verb 位通配（仅区间键语法；动词闭集不变，'*' 是区间表达）。
  // RESERVED_TYPES 不生成 type 通配候选（治理域必须显式指名类型）。
  const types = RESERVED_TYPES.includes(n.resourceType)
    ? [n.resourceType]
    : [n.resourceType, "*"];
  const verbs: string[] = [n.verb, "*"];
  const out: string[] = [];
  for (const type of types) {
    for (const id of type === "*" ? ["*"] : ids) {
      for (const sub of subs) {
        for (const verb of verbs) {
          out.push(`node:${type}/${id}${sub === "*" ? "" : `/${sub}`}@${verb}`);
        }
      }
    }
  }
  return [...new Set(out)];
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
  if (resourceType === "production") {
    // 基线原则（2026-08-13 用户定谳）：权限越基线，修改该权限越敏感。
    // 边界修正：基线性由**信息敏感度**决定，非动词决定——
    //   meta/mounts/archival 的 view=基线（项目信息成员可见），修改动作 sensitive；
    //   integrations **整面** sensitive（配置含密钥，查看即敏感）。
    if (resourceSub === "integrations") return true;
    // 治理账本与越隐私审查（管理后台 v3 追加批）：整面 sensitive（查看即敏感）
    if (resourceSub === "grants" || resourceSub === "asset_review") return true;
    if (verb === "view") return false;
    return resourceSub.startsWith("meta") || resourceSub === "archival";
  }
  if (resourceType === "member" && resourceSub.startsWith("imports")) return true;
  return false;
}

/** 六步链的四个资格探针。SQL 版逐节点精确查（canAccessNode），内存版一次拉全量
 *  后逐节点匹配（canAccessNodesBatch）——六步顺序只写一遍，两条路径不会漂移。 */
type AccessProbe = {
  grantRow: (node: NodeKeyParts) => Promise<boolean> | boolean;
  override: (candidates: string[]) => Promise<"deny" | "allow" | null> | ("deny" | "allow" | null);
  dept: (candidates: string[]) => Promise<boolean> | boolean;
  role: (candidates: string[]) => Promise<boolean> | boolean;
};

async function decideNode(
  ctx: { isAdmin: boolean; isOwner: boolean },
  node: NodeKeyParts,
  probe: AccessProbe,
): Promise<NodeAccessResult> {
  const { resourceType, resourceSub, verb } = node;
  // 1. grant（admin/owner 旁路）
  if (ctx.isAdmin || ctx.isOwner) return { allowed: true };
  if (await probe.grantRow(node)) return { allowed: true };
  // ROOT：owner-only（第 1 步旁路已处理 owner），此处一律无入口
  if (isRootNode(resourceType, resourceSub, verb)) {
    return { allowed: false, reason: "no_entry" };
  }
  const candidates = nodeKeyCandidates(node);
  const sensitive = isSensitiveNode(resourceType, resourceSub, verb);
  // 2/5. 个人 override（deny 短路一切区间）
  const override = await probe.override(candidates);
  if (override === "deny") return { allowed: false, reason: "needs_approval" };
  // 3. dept 区间（sensitive：区间=审批入口资格，不自确认）
  if (await probe.dept(candidates)) {
    return sensitive
      ? { allowed: false, reason: "needs_approval" }
      : { allowed: false, reason: "needs_self_confirm", source: "dept" };
  }
  // 4. role 区间
  if (await probe.role(candidates)) {
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

export async function canAccessNode(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<NodeAccessResult> {
  return decideNode(ctx, { resourceType, resourceId, resourceSub, verb }, {
    grantRow: (n) => hasGrant(ctx.userId, productionId, n.resourceType, n.resourceId, n.resourceSub, n.verb),
    override: (c) => memberOverrideHit(ctx.userId, productionId, c),
    dept: (c) => deptZoneHit(ctx.userId, productionId, c),
    role: (c) => roleZoneHit(ctx.userId, productionId, c),
  });
}

/**
 * 批量版六步链：四次查询拉全量资格源，逐节点在内存里判定。
 *
 * 激活面目录（PAGE_PERMISSION_SCOPES 并集）有 40+ 键，逐键跑 canAccessNode
 * 等于 160+ 次串行往返——每次进演出页面都要付这个代价。批量版把它压成常数
 * 4 次，与键数无关。
 */
export async function canAccessNodesBatch(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  nodes: NodeKeyParts[],
): Promise<NodeAccessResult[]> {
  if (nodes.length === 0) return [];
  // admin/owner 全通过，不必拉任何资格源
  if (ctx.isAdmin || ctx.isOwner) return nodes.map(() => ({ allowed: true }));

  const pool = getPool();
  const [grantRes, overrideRes, deptRes, roleRes] = await Promise.all([
    pool.query<{ resource_type: string; resource_id: string; resource_sub: string; permission_level: string }>(
      `SELECT resource_type, resource_id, resource_sub, permission_level
       FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND NOT is_revoked
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [productionId, ctx.userId],
    ),
    pool.query<{ permission: string; granted: boolean }>(
      `SELECT permission, granted FROM production_member_permission
       WHERE production_id = $1 AND user_id = $2`,
      [productionId, ctx.userId],
    ),
    pool.query<{ permission_key: string }>(
      `WITH RECURSIVE chain AS (
         SELECT pd.id, pd.parent_id
         FROM production_dept_member pdm
         JOIN production_dept pd ON pd.id = pdm.dept_id
         WHERE pdm.production_id = $1 AND pdm.user_id = $2
         UNION
         SELECT pd2.id, pd2.parent_id
         FROM production_dept pd2 JOIN chain c ON pd2.id = c.parent_id
       )
       SELECT DISTINCT pdp.permission_key FROM production_dept_permission pdp
       JOIN chain ON chain.id = pdp.dept_id
       WHERE pdp.production_id = $1`,
      [productionId, ctx.userId],
    ),
    pool.query<{ permission_key: string }>(
      `SELECT DISTINCT prp.permission_key
       FROM production_member_role pmr
       JOIN production_role_permission prp ON prp.role_id = pmr.role_id
       WHERE pmr.production_id = $1 AND pmr.user_id = $2`,
      [productionId, ctx.userId],
    ),
  ]);

  const rows = grantRes.rows;
  const deptKeys = new Set(deptRes.rows.map((r) => r.permission_key));
  const roleKeys = new Set(roleRes.rows.map((r) => r.permission_key));
  const overrides = new Map(overrideRes.rows.map((r) => [r.permission, r.granted]));

  const probe: AccessProbe = {
    // hasGrant 的行匹配语义：type 精确 × id ∈ {id,'*'} × sub ∈ {sub,'*'}（保留段
    // 不被 '*' 覆盖）× level = verb
    grantRow: (n) => rows.some((r) =>
      r.resource_type === n.resourceType
      && (r.resource_id === n.resourceId || r.resource_id === "*")
      && (isReservedSub(n.resourceSub)
        ? r.resource_sub === n.resourceSub
        : r.resource_sub === n.resourceSub || r.resource_sub === "*")
      && r.permission_level === n.verb),
    override: (candidates) => {
      let sawAllow = false;
      for (const key of candidates) {
        const granted = overrides.get(key);
        if (granted === undefined) continue;
        if (!granted) return "deny";   // deny 优先于 allow
        sawAllow = true;
      }
      return sawAllow ? "allow" : null;
    },
    dept: (candidates) => candidates.some((k) => deptKeys.has(k)),
    role: (candidates) => candidates.some((k) => roleKeys.has(k)),
  };

  const out: NodeAccessResult[] = [];
  for (const n of nodes) out.push(await decideNode(ctx, n, probe));
  return out;
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

/** self-confirm 激活：把用户区间内的节点落成 production_member_grant 个人行（防伪造，幂等）。 */
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
      `INSERT INTO production_member_grant
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
  db: Pool | PoolClient = getPool(),
): Promise<string[]> {
  const { rows } = await db.query<{ permission_key: string }>(
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

/** 把全局模板键 seed 进指定角色的 production_role_permission（幂等）。
 *  `db` 供项目模版在自己的事务里调用（`lib/template-seeders/roles.ts`）。 */
export async function seedRoleFromTemplate(
  roleId: string,
  roleName: string,
  productionType: string | null,
  db: Pool | PoolClient = getPool(),
): Promise<void> {
  const keys = await templateKeysForRole(roleName, productionType, db);
  if (keys.length === 0) return;
  await db.query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING`,
    [roleId, keys],
  );
}
