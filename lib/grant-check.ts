/**
 * Grant Check — 权限REST化的核心行检查器（批0 基建）。
 *
 * 模型（见 MindWeave《权限REST化-Migration总表》§0）：
 *   权限 = 树上节点 + 动词：production_id根 / resource_type / resource_id / resource_sub @ verb
 *   动词闭集 view/create/edit/delete；权限非线性——本模块不做任何等级比较，
 *   一行 grant 只命中它自己的 (节点, 动词)，蕴含由授权时发多行表达。
 *
 * 双入口契约：资源访问 = 行入口 ∪ 免审批区间入口，两边权限等级表达一致。
 *   - 行入口：本模块（resource_grant 表）
 *   - 区间入口：resource-grant-db.ts 的 checkResourceFreeApprovalZone（dept 面），
 *     其词汇（dept.permissions[] 键）随各批迁移与动词词汇同步更换
 *
 * 通配语义：
 *   - resource_id = '*'：全实例；对 create 动词读作集合本身（实例 create 无定义，无歧义）
 *   - resource_sub = '*'：整棵子树，但**不覆盖保留段**（grants/publication 必须显式授予）
 *   - 显式保留段通配行（如 resource_sub='grants' + resource_id='*'）是合法的管理员通配
 */
import { getPool } from "./pg";

export type GrantVerb = "view" | "create" | "edit" | "delete";

/** 保留段：'*' 通配 sub 不覆盖，任何授权必须显式指到这些段（或其子路径）。 */
export const RESERVED_SUBS: readonly string[] = ["grants", "publication"];

export function isReservedSub(sub: string): boolean {
  return RESERVED_SUBS.some((r) => sub === r || sub.startsWith(`${r}/`));
}

/**
 * 用户在指定树节点上是否持有指定动词的有效 grant 行。
 *
 * 命中条件（全部精确，无等级比较）：
 *   resource_id ∈ { 具体 id, '*' } × resource_sub ∈ { 具体 sub, '*'（保留段除外） }
 *   × permission_level = verb × 未撤销 × 未过期
 */
export async function hasGrant(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<boolean> {
  const subMatch = isReservedSub(resourceSub)
    ? "rg.resource_sub = $5"
    : "rg.resource_sub IN ($5, '*')";
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM resource_grant rg
       WHERE rg.production_id = $1
         AND rg.user_id = $2
         AND rg.resource_type = $3
         AND rg.resource_id IN ($4, '*')
         AND ${subMatch}
         AND rg.permission_level = $6
         AND NOT rg.is_revoked
         AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ) AS ok`,
    [productionId, userId, resourceType, resourceId, resourceSub, verb],
  );
  return rows[0]?.ok ?? false;
}

/** 路由布尔门：admin/owner 旁路 + 个人行。三态判定用 grant-template 的 canAccessNode。 */
export async function hasEffectiveGrant(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  resourceType: string,
  resourceId: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<boolean> {
  if (ctx.isAdmin || ctx.isOwner) return true;
  return hasGrant(ctx.userId, productionId, resourceType, resourceId, resourceSub, verb);
}

/** 路由布尔门（域级）：admin/owner 旁路 + 任一实例行。 */
export async function hasAnyEffectiveGrant(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
  resourceType: string,
  subs: readonly string[],
  verb: GrantVerb,
): Promise<boolean> {
  if (ctx.isAdmin || ctx.isOwner) return true;
  return hasAnyGrant(ctx.userId, productionId, resourceType, subs, verb);
}

/**
 * 域级可见性：用户对某类型是否持有任一实例的指定动词行（不限实例）。
 * 用于全项目级通道（如 cue-stream SSE）的粗粒度门。
 */
export async function hasAnyGrant(
  userId: string,
  productionId: string,
  resourceType: string,
  subs: readonly string[],
  verb: GrantVerb,
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM resource_grant rg
       WHERE rg.production_id = $1
         AND rg.user_id = $2
         AND rg.resource_type = $3
         AND rg.resource_sub = ANY($4)
         AND rg.permission_level = $5
         AND NOT rg.is_revoked
         AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
     ) AS ok`,
    [productionId, userId, resourceType, [...subs, "*"], verb],
  );
  return rows[0]?.ok ?? false;
}

/**
 * 目录/列表查询的行入口：用户对某类型某 sub 节点持有 verb 的实例集合。
 * 返回 { wildcard: true } 表示持有通配行（可见全量）；否则给出具体实例 id 列表。
 * 典型用途：目录页 = listGrantedResourceIds(user, prod, 'cue_list', 'meta', 'view')。
 */
export async function listGrantedResourceIds(
  userId: string,
  productionId: string,
  resourceType: string,
  resourceSub: string,
  verb: GrantVerb,
): Promise<{ wildcard: boolean; ids: string[] }> {
  const subMatch = isReservedSub(resourceSub)
    ? "resource_sub = $4"
    : "resource_sub IN ($4, '*')";
  const { rows } = await getPool().query<{ resource_id: string }>(
    `SELECT DISTINCT resource_id FROM resource_grant
     WHERE production_id = $1
       AND user_id = $2
       AND resource_type = $3
       AND ${subMatch}
       AND permission_level = $5
       AND NOT is_revoked
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [productionId, userId, resourceType, resourceSub, verb],
  );
  const ids = rows.map((r) => r.resource_id);
  if (ids.includes("*")) return { wildcard: true, ids: [] };
  return { wildcard: false, ids };
}
