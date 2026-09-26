import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getPool } from "../pg";

export const SHARE_SESSION_IDLE_MS = 30 * 60 * 1000;
export const SHARE_SESSION_MAX_MS = 8 * 60 * 60 * 1000;
export const SHARE_SESSION_COOKIE = "asset_share_session";
const SHARE_SESSION_TOUCH_MS = 5 * 60 * 1000;

export type AssetShareLink = {
  id: string;
  token: string;
  assetId: string;
  productionId: string;
  allowDownload: boolean;
  oneTime: boolean;
  note: string | null;
  expiresAt: Date;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  redeemedAt: Date | null;
  sessionSecretHash: string | null;
  sessionLastSeenAt: Date | null;
  sessionExpiresAt: Date | null;
};

type ShareLinkRow = {
  id: string;
  token: string;
  asset_id: string;
  production_id: string;
  allow_download: boolean;
  one_time: boolean;
  note: string | null;
  expires_at: Date;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  redeemed_at: Date | null;
  session_secret_hash: string | null;
  session_last_seen_at: Date | null;
  session_expires_at: Date | null;
};

function rowToLink(row: ShareLinkRow): AssetShareLink {
  return {
    id: row.id,
    token: row.token,
    assetId: row.asset_id,
    productionId: row.production_id,
    allowDownload: row.allow_download,
    oneTime: row.one_time,
    note: row.note,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    redeemedAt: row.redeemed_at,
    sessionSecretHash: row.session_secret_hash,
    sessionLastSeenAt: row.session_last_seen_at,
    sessionExpiresAt: row.session_expires_at,
  };
}

function newId(): string {
  return `asl_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function sameSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function linkStillOpen(link: AssetShareLink, now: number): boolean {
  return link.revokedAt === null && link.expiresAt.getTime() > now;
}

export async function createAssetShareLink(params: {
  assetId: string;
  productionId: string;
  createdBy: string;
  expiresInDays: number;
  allowDownload: boolean;
  oneTime: boolean;
  note?: string | null;
}): Promise<AssetShareLink> {
  const result = await getPool().query<ShareLinkRow>(
    `INSERT INTO asset_share_link
       (id, token, asset_id, production_id, allow_download, one_time, note, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 day', $9)
     RETURNING *`,
    [newId(), newSecret(), params.assetId, params.productionId, params.allowDownload,
     params.oneTime, params.note ?? null, params.expiresInDays, params.createdBy],
  );
  return rowToLink(result.rows[0]);
}

export async function listAssetShareLinks(
  productionId: string,
  assetId: string,
): Promise<AssetShareLink[]> {
  const result = await getPool().query<ShareLinkRow>(
    `SELECT * FROM asset_share_link
     WHERE production_id = $1 AND asset_id = $2
     ORDER BY created_at DESC`,
    [productionId, assetId],
  );
  return result.rows.map(rowToLink);
}

export async function revokeAssetShareLink(
  productionId: string,
  assetId: string,
  linkId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE asset_share_link SET revoked_at = now()
     WHERE id = $1 AND production_id = $2 AND asset_id = $3 AND revoked_at IS NULL`,
    [linkId, productionId, assetId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type ShareLinkAccess =
  | { kind: "valid"; link: AssetShareLink }
  | { kind: "requires_redemption"; link: AssetShareLink }
  | { kind: "invalid" };

/**
 * 解析公开链接。单次链接的“一次”是一次浏览器兑换，不是一次 HTTP 请求：同一
 * 页面随后发出的元数据、Range 与下载请求都凭 sessionSecret 进入同一会话。
 */
export async function getAssetShareLinkAccess(
  token: string,
  sessionSecret?: string,
): Promise<ShareLinkAccess> {
  const result = await getPool().query<ShareLinkRow>(
    "SELECT * FROM asset_share_link WHERE token = $1",
    [token],
  );
  if (!result.rows[0]) return { kind: "invalid" };

  const link = rowToLink(result.rows[0]);
  const now = Date.now();
  if (!linkStillOpen(link, now)) return { kind: "invalid" };
  if (!link.oneTime) return { kind: "valid", link };
  if (!link.redeemedAt) return { kind: "requires_redemption", link };

  if (!sessionSecret || !link.sessionSecretHash || !link.sessionLastSeenAt || !link.sessionExpiresAt) {
    return { kind: "invalid" };
  }
  if (!sameSecret(sessionSecret, link.sessionSecretHash)) return { kind: "invalid" };
  if (link.sessionExpiresAt.getTime() <= now) return { kind: "invalid" };
  if (link.sessionLastSeenAt.getTime() + SHARE_SESSION_IDLE_MS <= now) return { kind: "invalid" };

  return { kind: "valid", link };
}

/** 先完成链接与项目策略检查，再记录活动；策略关闭时不得偷偷续活会话。 */
export async function touchAssetShareSession(link: AssetShareLink): Promise<void> {
  if (!link.oneTime || !link.sessionLastSeenAt) return;
  if (link.sessionLastSeenAt.getTime() + SHARE_SESSION_TOUCH_MS > Date.now()) return;
  await getPool().query(
    `UPDATE asset_share_link SET session_last_seen_at = now()
     WHERE id = $1 AND session_last_seen_at = $2`,
    [link.id, link.sessionLastSeenAt],
  );
}

export type RedeemShareLinkResult =
  | { kind: "redeemed"; link: AssetShareLink; sessionSecret: string }
  | { kind: "already_redeemed" }
  | { kind: "invalid" };

/** 原子兑换：并发点击只有一个请求能取得浏览器会话。 */
export async function redeemOneTimeAssetShareLink(token: string): Promise<RedeemShareLinkResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<ShareLinkRow>(
      "SELECT * FROM asset_share_link WHERE token = $1 FOR UPDATE",
      [token],
    );
    if (!found.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "invalid" };
    }
    const current = rowToLink(found.rows[0]);
    if (!current.oneTime || !linkStillOpen(current, Date.now())) {
      await client.query("ROLLBACK");
      return { kind: "invalid" };
    }
    if (current.redeemedAt) {
      await client.query("ROLLBACK");
      return { kind: "already_redeemed" };
    }

    const sessionSecret = newSecret();
    const updated = await client.query<ShareLinkRow>(
      `UPDATE asset_share_link
       SET redeemed_at = now(),
           session_secret_hash = $2,
           session_last_seen_at = now(),
           session_expires_at = LEAST(expires_at, now() + $3 * interval '1 millisecond')
       WHERE id = $1
       RETURNING *`,
      [current.id, hashSecret(sessionSecret), SHARE_SESSION_MAX_MS],
    );
    await client.query("COMMIT");
    return { kind: "redeemed", link: rowToLink(updated.rows[0]), sessionSecret };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
