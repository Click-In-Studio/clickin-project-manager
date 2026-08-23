import { getPool } from "./pg";
import { addProductionMember, setMemberRoles } from "./db";
import { seatsFullForNewMember } from "./plan";

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
  /** 已注册用户定向 */
  targetUserId?: string | null;
  /** 未注册飞书用户定向（接受时校验登录身份的 open_id） */
  feishuOpenId?: string | null;
  presetRoles?: string[];
  presetDeptIds?: string[];
  createdBy: string;
  expiresInDays?: number | null;
  maxUses?: number | null;
}): Promise<{ token: string }> {
  const { rows } = await getPool().query<{ token: string }>(
    `INSERT INTO production_invite
       (production_id, email, target_user_id, feishu_open_id, preset_roles, preset_dept_ids, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $8::int) END,
       $9)
     RETURNING token`,
    [
      params.productionId,
      params.email?.trim().toLowerCase() || null,
      params.targetUserId ?? null,
      params.feishuOpenId ?? null,
      params.presetRoles ?? [],
      params.presetDeptIds ?? [],
      params.createdBy,
      params.expiresInDays ?? null,
      params.maxUses ?? null,
    ],
  );
  return { token: rows[0].token };
}

export type ClaimEntry = { name: string; presetRoles: string[]; presetDeptIds: string[] };

/** 批量认领链接：一个 token + 名单（每行独立预配，按名字认领一次）。 */
export async function createClaimInvite(params: {
  productionId: string;
  createdBy: string;
  entries: ClaimEntry[];
  expiresInDays?: number | null;
}): Promise<{ token: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ token: string }>(
      `INSERT INTO production_invite (production_id, kind, created_by, expires_at)
       VALUES ($1, 'claim', $2,
         CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $3::int) END)
       RETURNING token`,
      [params.productionId, params.createdBy, params.expiresInDays ?? 30],
    );
    const token = rows[0].token;
    for (const e of params.entries) {
      await client.query(
        `INSERT INTO production_invite_claim (token, name, preset_roles, preset_dept_ids)
         VALUES ($1, $2, $3, $4) ON CONFLICT (token, name) DO NOTHING`,
        [token, e.name.trim(), e.presetRoles, e.presetDeptIds],
      );
    }
    await client.query("COMMIT");
    return { token };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
  kind: "standard" | "claim";
  email: string | null;
  status: InviteRow["status"];
  /** claim 链接：未认领名单（id+name） */
  unclaimed: { id: string; name: string }[];
};

/** 接受页展示用：项目名+状态（不泄露 preset 细节）。null = token 不存在。 */
export async function getInviteInfo(token: string): Promise<InviteInfo | null> {
  const { rows } = await getPool().query<{
    production_id: string; production_name: string; kind: string; email: string | null;
    revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number;
  }>(
    `SELECT i.production_id, p.name AS production_name, i.kind, i.email,
            i.revoked_at, i.expires_at, i.max_uses, i.used_count
     FROM production_invite i JOIN production p ON p.id = i.production_id
     WHERE i.token = $1`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  let unclaimed: { id: string; name: string }[] = [];
  if (r.kind === "claim") {
    const c = await getPool().query<{ id: string; name: string }>(
      `SELECT id, name FROM production_invite_claim
       WHERE token = $1 AND claimed_at IS NULL ORDER BY name`,
      [token],
    );
    unclaimed = c.rows;
  }
  return {
    productionId: r.production_id,
    productionName: r.production_name,
    kind: r.kind === "claim" ? "claim" : "standard",
    email: r.email,
    status: deriveStatus(r),
    unclaimed,
  };
}

export type AcceptResult =
  | { ok: true; productionId: string; alreadyMember: boolean }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" | "email_mismatch" | "target_mismatch" | "needs_claim" | "seats_full" };

export async function acceptInvite(token: string, userId: string): Promise<AcceptResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      production_id: string; kind: string; email: string | null;
      target_user_id: string | null; feishu_open_id: string | null;
      preset_roles: string[]; preset_dept_ids: string[];
      revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number;
    }>(
      `SELECT production_id, kind, email, target_user_id, feishu_open_id, preset_roles, preset_dept_ids,
              revoked_at, expires_at, max_uses, used_count
       FROM production_invite WHERE token = $1 FOR UPDATE`,
      [token],
    );
    const inv = rows[0];
    if (!inv) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (inv.kind === "claim") { await client.query("ROLLBACK"); return { ok: false, reason: "needs_claim" }; }
    const status = deriveStatus(inv);
    if (status !== "active") { await client.query("ROLLBACK"); return { ok: false, reason: status }; }

    if (inv.target_user_id && inv.target_user_id !== userId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "target_mismatch" };
    }
    if (inv.feishu_open_id) {
      const fu = await client.query(
        "SELECT 1 FROM feishu_user WHERE user_id = $1 AND open_id = $2",
        [userId, inv.feishu_open_id],
      );
      if (fu.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "target_mismatch" };
      }
    }
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
    // 档位人数上限（#280）：与 FOR UPDATE 同事务判，并发接受不会超编。
    if (!alreadyMember && (await seatsFullForNewMember(client, inv.production_id))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "seats_full" };
    }
    await client.query(
      `UPDATE production_invite SET used_count = used_count + 1 WHERE token = $1`,
      [token],
    );
    await client.query("COMMIT");

    // 入组与预配走既有写点（addProductionMember/setMemberRoles/dept 行——
    // 角色=区间资格、部门=区间归属，均无自动 grant 写点，不涉 §0.9 账本）
    if (!alreadyMember) {
      await joinWithPresets(inv.production_id, userId, inv.preset_roles, inv.preset_dept_ids);
    }
    return { ok: true, productionId: inv.production_id, alreadyMember };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function joinWithPresets(
  productionId: string,
  userId: string,
  presetRoles: string[],
  presetDeptIds: string[],
): Promise<void> {
  const pool = getPool();
  await addProductionMember(productionId, userId);
  if (presetRoles.length) {
    await setMemberRoles(productionId, userId, presetRoles);
  }
  for (const deptId of presetDeptIds) {
    await pool.query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
       SELECT $1, $2, $3, false
       WHERE EXISTS (SELECT 1 FROM production_dept WHERE id = $2 AND production_id = $1)
       ON CONFLICT DO NOTHING`,
      [productionId, deptId, userId],
    );
  }
}

export type ClaimResult =
  | { ok: true; productionId: string; alreadyMember: boolean }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" | "claim_taken" | "seats_full" };

/** 认领批量链接名额：按 claim 行入组+该行预配，一名一次。 */
export async function claimInvite(token: string, claimId: string, userId: string): Promise<ClaimResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = (await client.query<{
      production_id: string; kind: string;
      revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; used_count: number;
    }>(
      `SELECT production_id, kind, revoked_at, expires_at, max_uses, used_count
       FROM production_invite WHERE token = $1 FOR UPDATE`,
      [token],
    )).rows[0];
    if (!inv || inv.kind !== "claim") { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    const status = deriveStatus(inv);
    if (status !== "active") { await client.query("ROLLBACK"); return { ok: false, reason: status }; }

    const claim = (await client.query<{
      id: string; preset_roles: string[]; preset_dept_ids: string[]; claimed_at: Date | null;
    }>(
      `SELECT id, preset_roles, preset_dept_ids, claimed_at
       FROM production_invite_claim WHERE id = $1 AND token = $2 FOR UPDATE`,
      [claimId, token],
    )).rows[0];
    if (!claim) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (claim.claimed_at) { await client.query("ROLLBACK"); return { ok: false, reason: "claim_taken" }; }

    const existing = await client.query(
      "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
      [inv.production_id, userId],
    );
    const alreadyMember = existing.rows.length > 0;
    // 档位人数上限（#280）：与 FOR UPDATE 同事务判，并发认领不会超编。
    if (!alreadyMember && (await seatsFullForNewMember(client, inv.production_id))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "seats_full" };
    }

    await client.query(
      "UPDATE production_invite_claim SET claimed_by = $2, claimed_at = NOW() WHERE id = $1",
      [claimId, userId],
    );
    await client.query(
      "UPDATE production_invite SET used_count = used_count + 1 WHERE token = $1",
      [token],
    );
    await client.query("COMMIT");

    if (!alreadyMember) {
      await joinWithPresets(inv.production_id, userId, claim.preset_roles, claim.preset_dept_ids);
    }
    return { ok: true, productionId: inv.production_id, alreadyMember };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
