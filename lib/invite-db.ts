import { getPool } from "./pg";
import { addProductionMember, setMemberRoles } from "./db";

// #156 邀请制数据层：开放链接 + 定向邮件邀请（production_invite 一表两用）。
// 接受 = 事务内校验（撤销/过期/次数/定向邮箱匹配）→ 入组 → 预配角色/部门 → 计数。

export type InviteRow = {
  token: string;
  productionId: string;
  email: string | null;
  presetRoles: string[];
  presetDeptIds: string[];
  createdBy: string;
  createdByName: string;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  createdAt: string;
  /** 派生：active / revoked / expired / exhausted */
  status: "active" | "revoked" | "expired" | "exhausted";
};

function deriveStatus(r: { revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number }): InviteRow["status"] {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && r.expires_at.getTime() <= Date.now()) return "expired";
  if (r.max_uses !== null && r.used_count >= r.max_uses) return "exhausted";
  return "active";
}

export async function createInvite(params: {
  productionId: string;
  email?: string | null;
  presetRoles?: string[];
  presetDeptIds?: string[];
  createdBy: string;
  expiresInDays?: number | null;
  maxUses?: number | null;
}): Promise<{ token: string }> {
  const { rows } = await getPool().query<{ token: string }>(
    `INSERT INTO production_invite
       (production_id, email, preset_roles, preset_dept_ids, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5,
       CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $6::int) END,
       $7)
     RETURNING token`,
    [
      params.productionId,
      params.email?.trim().toLowerCase() || null,
      params.presetRoles ?? [],
      params.presetDeptIds ?? [],
      params.createdBy,
      params.expiresInDays ?? null,
      params.maxUses ?? null,
    ],
  );
  return { token: rows[0].token };
}

export async function listInvites(productionId: string): Promise<InviteRow[]> {
  const { rows } = await getPool().query<{
    token: string; production_id: string; email: string | null;
    preset_roles: string[]; preset_dept_ids: string[];
    created_by: string; created_by_name: string | null;
    expires_at: Date | null; max_uses: number | null; used_count: number;
    revoked_at: Date | null; created_at: Date;
  }>(
    `SELECT i.token, i.production_id, i.email, i.preset_roles, i.preset_dept_ids,
            i.created_by, up.name AS created_by_name,
            i.expires_at, i.max_uses, i.used_count, i.revoked_at, i.created_at
     FROM production_invite i
     LEFT JOIN user_profile up ON up.user_id = i.created_by
     WHERE i.production_id = $1
     ORDER BY i.created_at DESC`,
    [productionId],
  );
  return rows.map(r => ({
    token: r.token,
    productionId: r.production_id,
    email: r.email,
    presetRoles: r.preset_roles,
    presetDeptIds: r.preset_dept_ids,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? "",
    expiresAt: r.expires_at?.toISOString() ?? null,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    status: deriveStatus(r),
  }));
}

export async function revokeInvite(productionId: string, token: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE production_invite SET revoked_at = NOW()
     WHERE token = $1 AND production_id = $2 AND revoked_at IS NULL
     RETURNING token`,
    [token, productionId],
  );
  return (res.rowCount ?? 0) > 0;
}

export type InviteInfo = {
  productionId: string;
  productionName: string;
  email: string | null;
  status: InviteRow["status"];
};

/** 接受页展示用：项目名+状态（不泄露 preset 细节）。null = token 不存在。 */
export async function getInviteInfo(token: string): Promise<InviteInfo | null> {
  const { rows } = await getPool().query<{
    production_id: string; production_name: string; email: string | null;
    revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number;
  }>(
    `SELECT i.production_id, p.name AS production_name, i.email,
            i.revoked_at, i.expires_at, i.max_uses, i.used_count
     FROM production_invite i JOIN production p ON p.id = i.production_id
     WHERE i.token = $1`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    productionId: r.production_id,
    productionName: r.production_name,
    email: r.email,
    status: deriveStatus(r),
  };
}

export type AcceptResult =
  | { ok: true; productionId: string; alreadyMember: boolean }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" | "email_mismatch" };

export async function acceptInvite(token: string, userId: string): Promise<AcceptResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      production_id: string; email: string | null; preset_roles: string[]; preset_dept_ids: string[];
      revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number;
    }>(
      `SELECT production_id, email, preset_roles, preset_dept_ids,
              revoked_at, expires_at, max_uses, used_count
       FROM production_invite WHERE token = $1 FOR UPDATE`,
      [token],
    );
    const inv = rows[0];
    if (!inv) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    const status = deriveStatus(inv);
    if (status !== "active") { await client.query("ROLLBACK"); return { ok: false, reason: status }; }

    if (inv.email) {
      const match = await client.query(
        `SELECT 1 FROM user_platform_identity
         WHERE user_id = $1 AND platform_id = 'email' AND LOWER(platform_user_id) = $2`,
        [userId, inv.email],
      );
      if (match.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "email_mismatch" };
      }
    }

    const existing = await client.query(
      "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
      [inv.production_id, userId],
    );
    const alreadyMember = existing.rows.length > 0;
    await client.query(
      `UPDATE production_invite SET used_count = used_count + 1 WHERE token = $1`,
      [token],
    );
    await client.query("COMMIT");

    // 入组与预配走既有写点（addProductionMember/setMemberRoles/dept 行——
    // 角色=区间资格、部门=区间归属，均无自动 grant 写点，不涉 §0.9 账本）
    if (!alreadyMember) {
      await addProductionMember(inv.production_id, userId);
      if (inv.preset_roles.length) {
        await setMemberRoles(inv.production_id, userId, inv.preset_roles);
      }
      for (const deptId of inv.preset_dept_ids) {
        await pool.query(
          `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
           SELECT $1, $2, $3, false
           WHERE EXISTS (SELECT 1 FROM production_dept WHERE id = $2 AND production_id = $1)
           ON CONFLICT DO NOTHING`,
          [inv.production_id, deptId, userId],
        );
      }
    }
    return { ok: true, productionId: inv.production_id, alreadyMember };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
