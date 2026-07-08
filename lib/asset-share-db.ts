import { randomBytes } from "crypto";
import { getPool } from "./pg";

export type ShareTokenType = "time_limited" | "one_time";

export type ShareToken = {
  token: string;
  assetId: string;
  productionId: string;
  createdBy: string;
  createdAt: Date;
  label: string | null;
  expiresAt: Date | null;
  oneTime: boolean;
  usedAt: Date | null;
  revokedAt: Date | null;
};

type ShareTokenRow = {
  token: string;
  asset_id: string;
  production_id: string;
  created_by: string;
  created_at: Date;
  label: string | null;
  expires_at: Date | null;
  one_time: boolean;
  used_at: Date | null;
  revoked_at: Date | null;
};

function rowToToken(r: ShareTokenRow): ShareToken {
  return {
    token: r.token,
    assetId: r.asset_id,
    productionId: r.production_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    label: r.label,
    expiresAt: r.expires_at,
    oneTime: r.one_time,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
  };
}

// One-time tokens remain usable for 4 hours after first access to allow seeking.
const ONE_TIME_GRACE_MS = 4 * 60 * 60 * 1000;

export function isShareTokenValid(t: ShareToken): boolean {
  if (t.revokedAt) return false;
  if (t.expiresAt && new Date() > t.expiresAt) return false;
  if (t.oneTime && t.usedAt) {
    return Date.now() - t.usedAt.getTime() < ONE_TIME_GRACE_MS;
  }
  return true;
}

export async function createShareToken(params: {
  assetId: string;
  productionId: string;
  createdBy: string;
  label?: string | null;
  type: ShareTokenType;
  expiresInDays?: number | null; // null = no expiry (only for one_time)
}): Promise<ShareToken> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt =
    params.expiresInDays != null
      ? new Date(Date.now() + params.expiresInDays * 86400_000)
      : null;
  const oneTime = params.type === "one_time";

  const res = await getPool().query<ShareTokenRow>(
    `INSERT INTO asset_share_token
       (token, asset_id, production_id, created_by, label, expires_at, one_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [token, params.assetId, params.productionId, params.createdBy, params.label ?? null, expiresAt, oneTime],
  );
  return rowToToken(res.rows[0]);
}

export async function getShareToken(token: string): Promise<ShareToken | null> {
  const res = await getPool().query<ShareTokenRow>(
    `SELECT * FROM asset_share_token WHERE token = $1`,
    [token],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

/** Mark a one-time token as used (idempotent — only sets used_at once). */
export async function consumeShareToken(token: string): Promise<void> {
  await getPool().query(
    `UPDATE asset_share_token SET used_at = NOW()
     WHERE token = $1 AND one_time = TRUE AND used_at IS NULL`,
    [token],
  );
}

export async function listShareTokens(assetId: string): Promise<ShareToken[]> {
  const res = await getPool().query<ShareTokenRow>(
    `SELECT * FROM asset_share_token WHERE asset_id = $1 ORDER BY created_at DESC`,
    [assetId],
  );
  return res.rows.map(rowToToken);
}

export async function revokeShareToken(token: string, assetId: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE asset_share_token SET revoked_at = NOW()
     WHERE token = $1 AND asset_id = $2 AND revoked_at IS NULL`,
    [token, assetId],
  );
  return (res.rowCount ?? 0) > 0;
}
