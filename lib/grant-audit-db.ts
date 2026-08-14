import { getPool } from "./pg";

// 管理后台·权限审计：production_member_grant 全历史流水（只读账本）+ 强制撤销。

export type GrantLedgerRow = {
  id: string;
  userId: string;
  userName: string;
  resourceType: string;
  resourceId: string;
  resourceSub: string;
  permissionLevel: string;
  grantSource: string;
  confirmedBy: string | null;
  confirmedByName: string | null;
  approvalId: string | null;
  isRevoked: boolean;
  revokedReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** 派生状态：active / revoked / expired */
  status: "active" | "revoked" | "expired";
};

export type GrantLedgerFilters = {
  userId?: string;
  resourceType?: string;
  grantSource?: string;
  status?: "active" | "revoked" | "expired";
  limit?: number;
  offset?: number;
};

export async function listGrantLedger(
  productionId: string,
  filters: GrantLedgerFilters = {},
): Promise<{ rows: GrantLedgerRow[]; total: number }> {
  const conds: string[] = ["g.production_id = $1"];
  const vals: unknown[] = [productionId];
  if (filters.userId) conds.push(`g.user_id = $${vals.push(filters.userId)}`);
  if (filters.resourceType) conds.push(`g.resource_type = $${vals.push(filters.resourceType)}`);
  if (filters.grantSource) conds.push(`g.grant_source = $${vals.push(filters.grantSource)}`);
  if (filters.status === "active") {
    conds.push("NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())");
  } else if (filters.status === "revoked") {
    conds.push("g.is_revoked");
  } else if (filters.status === "expired") {
    conds.push("NOT g.is_revoked AND g.expires_at IS NOT NULL AND g.expires_at <= NOW()");
  }
  const where = conds.join(" AND ");
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const [rowsRes, countRes] = await Promise.all([
    getPool().query<{
      id: string; user_id: string; user_name: string | null;
      resource_type: string; resource_id: string; resource_sub: string; permission_level: string;
      grant_source: string; confirmed_by: string | null; confirmed_by_name: string | null;
      approval_id: string | null; is_revoked: boolean; revoked_reason: string | null;
      expires_at: Date | null; created_at: Date;
    }>(
      `SELECT g.id, g.user_id, up.name AS user_name,
              g.resource_type, g.resource_id, g.resource_sub, g.permission_level,
              g.grant_source, g.confirmed_by, cb.name AS confirmed_by_name,
              g.approval_id, g.is_revoked, g.revoked_reason, g.expires_at, g.created_at
       FROM production_member_grant g
       LEFT JOIN user_profile up ON up.user_id = g.user_id
       LEFT JOIN user_profile cb ON cb.user_id = g.confirmed_by
       WHERE ${where}
       ORDER BY g.created_at DESC, g.id
       LIMIT ${limit} OFFSET ${offset}`,
      vals,
    ),
    getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM production_member_grant g WHERE ${where}`,
      vals,
    ),
  ]);

  const now = Date.now();
  return {
    total: Number(countRes.rows[0]?.n ?? 0),
    rows: rowsRes.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name ?? "",
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      resourceSub: r.resource_sub,
      permissionLevel: r.permission_level,
      grantSource: r.grant_source,
      confirmedBy: r.confirmed_by,
      confirmedByName: r.confirmed_by_name,
      approvalId: r.approval_id,
      isRevoked: r.is_revoked,
      revokedReason: r.revoked_reason,
      expiresAt: r.expires_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      status: r.is_revoked
        ? "revoked"
        : r.expires_at && r.expires_at.getTime() <= now
          ? "expired"
          : "active",
    })),
  };
}

/** 强制撤销一条 grant（manual）。返回 false = 不存在或已撤销。 */
export async function revokeGrantById(productionId: string, grantId: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE production_member_grant
     SET is_revoked = true, revoked_reason = 'manual'
     WHERE id = $1 AND production_id = $2 AND NOT is_revoked
     RETURNING id`,
    [grantId, productionId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ─── 治理域授权（管理员设置页）：production/producer 域 grant 行直发 ─────────
// SENSITIVE 节点的 override allow 只是审批入口资格（六步链第 5 步不自确认），
// 真正的门票是 grant 行——owner 在管理面直发（grant_source='direct'）。

export type GovernanceGrantRow = {
  id: string;
  userId: string;
  userName: string;
  resourceType: string;
  resourceSub: string;
  permissionLevel: string;
  createdAt: string;
};

export async function listGovernanceGrants(productionId: string): Promise<GovernanceGrantRow[]> {
  const { rows } = await getPool().query<{
    id: string; user_id: string; user_name: string | null;
    resource_type: string; resource_sub: string; permission_level: string; created_at: Date;
  }>(
    `SELECT g.id, g.user_id, up.name AS user_name,
            g.resource_type, g.resource_sub, g.permission_level, g.created_at
     FROM production_member_grant g
     LEFT JOIN user_profile up ON up.user_id = g.user_id
     WHERE g.production_id = $1 AND g.resource_type IN ('production', 'producer')
       AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())
     ORDER BY up.name NULLS LAST, g.created_at`,
    [productionId],
  );
  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name ?? "",
    resourceType: r.resource_type,
    resourceSub: r.resource_sub,
    permissionLevel: r.permission_level,
    createdAt: r.created_at.toISOString(),
  }));
}

/** owner 直发 grant 行。同键活跃行已存在则幂等返回该行 id。 */
export async function createDirectGrant(
  productionId: string,
  userId: string,
  node: { resourceType: string; resourceId: string; resourceSub: string; verb: string },
  confirmedBy: string,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'direct', $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [productionId, userId, node.resourceType, node.resourceId, node.resourceSub, node.verb, confirmedBy],
  );
  if (rows[0]) return rows[0].id;
  const existing = await getPool().query<{ id: string }>(
    `SELECT id FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2 AND resource_type = $3
       AND resource_id = $4 AND resource_sub = $5 AND permission_level = $6
       AND NOT is_revoked LIMIT 1`,
    [productionId, userId, node.resourceType, node.resourceId, node.resourceSub, node.verb],
  );
  return existing.rows[0]?.id ?? "";
}
