import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { parseSessionIdentity } from "@/lib/agent/tools/session-identity";
import { newAttachmentId, newAttachmentObjectId } from "@/lib/agent/runtime/ids";
import { deleteR2Object, putR2Object } from "@/lib/r2";

export const AGENT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const AGENT_ATTACHMENT_MAX_PER_MESSAGE = 8;
export const AGENT_ATTACHMENT_SESSION_MAX_BYTES = 1024 * 1024 * 1024;
export const AGENT_ATTACHMENT_USER_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const AGENT_ATTACHMENT_SESSION_MAX_COUNT = 128;
export const AGENT_ATTACHMENT_USER_MAX_COUNT = 512;

export type AgentAttachmentStatus = "pending" | "ready" | "released" | "deleting" | "expired" | "promoted";
export type AgentAttachment = {
  id: string; sessionId: string; r2Key: string; fileName: string; mimeType: string;
  mediaKind: string | null; fileSize: number; status: AgentAttachmentStatus;
  expiresAt?: string; absoluteExpiresAt?: string; releaseUntil?: string | null; promotedAssetId?: string | null;
};

type Row = {
  id: string; session_id: string; r2_key: string; file_name: string; mime_type: string;
  media_kind: string | null; file_size: string | number; status: AgentAttachmentStatus;
  expires_at: Date; absolute_expires_at: Date; release_until: Date | null; promoted_asset_id: string | null;
};
type UsageRow = { bytes: string | number; count: string | number };
const ACTIVE_OBJECT_STATUSES = "('reserved', 'present', 'delete_pending', 'deleting')";

function mapRow(row: Row): AgentAttachment {
  return {
    id: row.id, sessionId: row.session_id, r2Key: row.r2_key, fileName: row.file_name,
    mimeType: row.mime_type, mediaKind: row.media_kind, fileSize: Number(row.file_size), status: row.status,
    expiresAt: row.expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString(),
    releaseUntil: row.release_until?.toISOString() ?? null, promotedAssetId: row.promoted_asset_id,
  };
}

async function lockUserQuota(client: PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent-attachment-user:${userId}`]);
}

async function quotaUsage(client: PoolClient, userId: string, sessionId?: string): Promise<{ bytes: number; count: number }> {
  const params: unknown[] = [userId];
  const sessionWhere = sessionId ? ` AND session_id = $2` : "";
  if (sessionId) params.push(sessionId);
  const r = await client.query<UsageRow>(
    `SELECT COALESCE(sum(byte_size), 0) AS bytes, count(*) FILTER (WHERE kind = 'original') AS count
     FROM agent_attachment_object
     WHERE user_id = $1${sessionWhere} AND status IN ${ACTIVE_OBJECT_STATUSES}`, params,
  );
  return { bytes: Number(r.rows[0].bytes), count: Number(r.rows[0].count) };
}

export async function getAttachmentUsage(userId: string, sessionId: string) {
  const client = await getPool().connect();
  try {
    const [session, user] = await Promise.all([quotaUsage(client, userId, sessionId), quotaUsage(client, userId)]);
    return {
      session: { ...session, maxBytes: AGENT_ATTACHMENT_SESSION_MAX_BYTES, maxCount: AGENT_ATTACHMENT_SESSION_MAX_COUNT },
      user: { ...user, maxBytes: AGENT_ATTACHMENT_USER_MAX_BYTES, maxCount: AGENT_ATTACHMENT_USER_MAX_COUNT },
    };
  } finally { client.release(); }
}

/** 附件可能先于第一条消息上传，因此在这里按已签发 session key 建空会话。 */
export async function createPendingAttachment(input: {
  sessionId: string; userId: string; fileName: string; mimeType: string; mediaKind?: string | null; fileSize: number;
}): Promise<AgentAttachment> {
  const identity = parseSessionIdentity(input.sessionId);
  if (!identity || identity.userId !== input.userId) throw Object.assign(new Error("无权访问该会话"), { status: 403 });
  const id = newAttachmentId();
  const safeName = input.fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 240) || "attachment";
  const r2ObjectName = safeName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  const r2Key = `agent-attachments/${id}/${r2ObjectName}`;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO agent_session (id, user_id, production_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [input.sessionId, input.userId, identity.productionId ?? null],
    );
    const owner = await client.query<{ user_id: string; production_id: string | null }>(
      `SELECT user_id::text, production_id FROM agent_session WHERE id = $1 FOR UPDATE`, [input.sessionId],
    );
    if (owner.rows[0]?.user_id !== input.userId || owner.rows[0]?.production_id !== (identity.productionId ?? null)) {
      throw Object.assign(new Error("无权访问该会话"), { status: 403 });
    }
    await lockUserQuota(client, input.userId);
    const [sessionUsage, userUsage] = await Promise.all([
      quotaUsage(client, input.userId, input.sessionId), quotaUsage(client, input.userId),
    ]);
    if (sessionUsage.count >= AGENT_ATTACHMENT_SESSION_MAX_COUNT || sessionUsage.bytes + input.fileSize > AGENT_ATTACHMENT_SESSION_MAX_BYTES) {
      throw Object.assign(new Error("当前对话的临时附件已达到 1 GiB 或 128 个上限，请先释放不再需要的附件"), { status: 413 });
    }
    if (userUsage.count >= AGENT_ATTACHMENT_USER_MAX_COUNT || userUsage.bytes + input.fileSize > AGENT_ATTACHMENT_USER_MAX_BYTES) {
      throw Object.assign(new Error("你的临时附件已达到 5 GiB 或 512 个上限，请先释放不再需要的附件"), { status: 413 });
    }
    const inserted = await client.query<Row>(
      `INSERT INTO agent_session_attachment
         (id, session_id, r2_key, file_name, mime_type, media_kind, file_size, expires_at, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '2 hours',now() + interval '30 days') RETURNING *`,
      [id, input.sessionId, r2Key, safeName, input.mimeType, input.mediaKind ?? null, input.fileSize],
    );
    await client.query(
      `INSERT INTO agent_attachment_object
         (id, attachment_id, user_id, session_id, kind, r2_key, byte_size, status)
       VALUES ($1,$2,$3,$4,'original',$5,$6,'reserved')`,
      [newAttachmentObjectId(), id, input.userId, input.sessionId, r2Key, input.fileSize],
    );
    await client.query("COMMIT");
    return mapRow(inserted.rows[0]);
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function markAttachmentReady(attachmentId: string, sessionId: string, userId: string, verifiedSize: number): Promise<AgentAttachment | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockUserQuota(client, userId);
    const pending = await client.query<{ file_size: string | number }>(
      `SELECT a.file_size FROM agent_session_attachment a JOIN agent_session s ON s.id = a.session_id
       WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3 AND a.status = 'pending' FOR UPDATE OF a`,
      [attachmentId, sessionId, userId],
    );
    if (!pending.rows[0]) { await client.query("COMMIT"); return null; }
    const reservedBytes = Number(pending.rows[0].file_size);
    const [sessionUsage, userUsage] = await Promise.all([
      quotaUsage(client, userId, sessionId), quotaUsage(client, userId),
    ]);
    if (sessionUsage.bytes - reservedBytes + verifiedSize > AGENT_ATTACHMENT_SESSION_MAX_BYTES) {
      throw Object.assign(new Error("上传完成后的实际大小超过当前对话 1 GiB 临时附件上限"), { status: 413 });
    }
    if (userUsage.bytes - reservedBytes + verifiedSize > AGENT_ATTACHMENT_USER_MAX_BYTES) {
      throw Object.assign(new Error("上传完成后的实际大小超过个人 5 GiB 临时附件上限"), { status: 413 });
    }
    const r = await client.query<Row>(
      `UPDATE agent_session_attachment a
       SET status = 'ready', ready_at = now(), file_size = $4,
           expires_at = LEAST(now() + interval '24 hours', absolute_expires_at)
       FROM agent_session s
       WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3 AND a.status = 'pending'
       RETURNING a.*`, [attachmentId, sessionId, userId, verifiedSize],
    );
    if (r.rows[0]) await client.query(
      `UPDATE agent_attachment_object SET status = 'present', byte_size = $2
       WHERE attachment_id = $1 AND kind = 'original' AND status = 'reserved'`, [attachmentId, verifiedSize],
    );
    await client.query("COMMIT");
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function getAttachmentUploadRecord(attachmentId: string, sessionId: string, userId: string): Promise<Pick<AgentAttachment, "r2Key" | "fileSize"> | null> {
  const r = await getPool().query<{ r2_key: string; file_size: string | number }>(
    `SELECT a.r2_key, a.file_size FROM agent_session_attachment a JOIN agent_session s ON s.id = a.session_id
     WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3 AND a.status = 'pending'`,
    [attachmentId, sessionId, userId],
  );
  return r.rows[0] ? { r2Key: r.rows[0].r2_key, fileSize: Number(r.rows[0].file_size) } : null;
}

export async function getReadyAttachments(attachmentIds: string[], sessionId: string, userId: string): Promise<AgentAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const r = await getPool().query<Row>(
    `SELECT a.* FROM agent_session_attachment a JOIN agent_session s ON s.id = a.session_id
     WHERE a.id = ANY($1::text[]) AND a.session_id = $2 AND s.user_id = $3
       AND a.status = 'ready' AND a.expires_at > now()`, [attachmentIds, sessionId, userId],
  );
  const byId = new Map(r.rows.map((row) => [row.id, mapRow(row)]));
  return attachmentIds.map((id) => byId.get(id)).filter((a): a is AgentAttachment => Boolean(a));
}

export async function getReadyAttachmentForSession(attachmentId: string, sessionId: string, userId: string): Promise<AgentAttachment | null> {
  return (await getReadyAttachments([attachmentId], sessionId, userId))[0] ?? null;
}

export async function getAttachmentForSession(attachmentId: string, sessionId: string, userId: string): Promise<AgentAttachment | null> {
  const r = await getPool().query<Row>(
    `SELECT a.* FROM agent_session_attachment a JOIN agent_session s ON s.id = a.session_id
     WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3`, [attachmentId, sessionId, userId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function listAttachmentsForSession(sessionId: string): Promise<AgentAttachment[]> {
  const r = await getPool().query<Row>(`SELECT * FROM agent_session_attachment WHERE session_id = $1 ORDER BY created_at`, [sessionId]);
  return r.rows.map(mapRow);
}

export async function listReadyAttachmentsForSession(sessionId: string): Promise<AgentAttachment[]> {
  return (await listAttachmentsForSession(sessionId)).filter((item) => item.status === "ready");
}

export type AttachmentAccessKind = "attached" | "preflight" | "read" | "mmp_capability";
export async function recordAttachmentAccess(runId: string, attachmentIds: string[], kind: AttachmentAccessKind): Promise<void> {
  if (attachmentIds.length === 0) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO agent_run_attachment_access (run_id, attachment_id, access_kind)
       SELECT $1, id, $3 FROM agent_session_attachment
       WHERE id = ANY($2::text[]) AND status = 'ready' AND expires_at > now()
       ON CONFLICT (run_id, attachment_id, access_kind) DO UPDATE SET succeeded_at = now()`,
      [runId, attachmentIds, kind],
    );
    await client.query(
      `UPDATE agent_session_attachment SET last_referenced_at = now(),
         expires_at = LEAST(now() + interval '7 days', absolute_expires_at)
       WHERE id = ANY($1::text[]) AND status = 'ready'`, [attachmentIds],
    );
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function releaseAttachmentForRun(input: { attachmentId: string; runId: string; sessionId: string; userId: string }): Promise<AgentAttachment> {
  const r = await getPool().query<Row>(
    `UPDATE agent_session_attachment a
     SET status = 'released', release_until = LEAST(now() + interval '24 hours', absolute_expires_at),
         expires_at = LEAST(now() + interval '24 hours', absolute_expires_at)
     FROM agent_session s
     WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3
       AND a.status = 'ready'
       AND EXISTS (SELECT 1 FROM agent_run_attachment_access x WHERE x.run_id = $4 AND x.attachment_id = a.id)
     RETURNING a.*`, [input.attachmentId, input.sessionId, input.userId, input.runId],
  );
  if (!r.rows[0]) throw Object.assign(new Error("只能释放本轮已成功处理、且仍可用的附件"), { status: 409 });
  return mapRow(r.rows[0]);
}

export async function restoreReleasedAttachment(attachmentId: string, sessionId: string, userId: string): Promise<AgentAttachment | null> {
  const r = await getPool().query<Row>(
    `UPDATE agent_session_attachment a SET status = 'ready', release_until = NULL,
       expires_at = LEAST(now() + interval '7 days', absolute_expires_at)
     FROM agent_session s
     WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3
       AND a.status = 'released' AND a.release_until > now() RETURNING a.*`,
    [attachmentId, sessionId, userId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function scheduleAttachmentDeletion(attachmentId: string, sessionId: string, userId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE agent_session_attachment a SET status = 'deleting', expires_at = now(), release_until = NULL
       FROM agent_session s WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3
         AND a.status NOT IN ('expired', 'promoted') RETURNING a.id`, [attachmentId, sessionId, userId],
    );
    if (r.rowCount) await client.query(
      `UPDATE agent_attachment_object SET status = 'delete_pending', next_attempt_at = now(), last_error = NULL
       WHERE attachment_id = $1 AND status IN ('reserved', 'present', 'deleting')`, [attachmentId],
    );
    await client.query("COMMIT");
    return Boolean(r.rowCount);
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function scheduleSessionAttachmentDeletionInTx(client: PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `UPDATE agent_attachment_object SET status = 'delete_pending', next_attempt_at = now(), last_error = NULL
     WHERE session_id = $1 AND status IN ('reserved', 'present', 'deleting')`, [sessionId],
  );
}

export async function registerAttachmentDerivedObject(input: { attachmentId: string; kind: "doc_ir" | "mmp_result"; r2Key: string; byteSize: number }): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const parent = await client.query<{ user_id: string; session_id: string; status: AgentAttachmentStatus }>(
      `SELECT s.user_id::text, a.session_id, a.status FROM agent_session_attachment a
       JOIN agent_session s ON s.id = a.session_id WHERE a.id = $1 FOR UPDATE OF a`, [input.attachmentId],
    );
    if (!parent.rows[0]) { await client.query("COMMIT"); return; }
    const status = ["deleting", "expired", "promoted"].includes(parent.rows[0].status) ? "delete_pending" : "present";
    await client.query(
      `INSERT INTO agent_attachment_object
         (id, attachment_id, user_id, session_id, kind, r2_key, byte_size, status, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 = 'delete_pending' THEN now() ELSE NULL END)
       ON CONFLICT (r2_key) DO UPDATE SET byte_size = EXCLUDED.byte_size`,
      [newAttachmentObjectId(), input.attachmentId, parent.rows[0].user_id, parent.rows[0].session_id,
       input.kind, input.r2Key, input.byteSize, status],
    );
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

/**
 * 若 fileId 是临时附件，在附件行锁内完成 PUT + 对象登记，避免 session 删除恰好
 * 穿过两步之间而留下没有回收账的派生对象。不是附件则返回 false，由资产路径照常存储。
 */
export async function putAttachmentDerivedObject(input: {
  attachmentId: string; kind: "doc_ir" | "mmp_result"; r2Key: string; body: Buffer; mimeType: string;
}): Promise<boolean> {
  const client = await getPool().connect();
  let uploaded = false;
  try {
    await client.query("BEGIN");
    const parent = await client.query<{ user_id: string; session_id: string; status: AgentAttachmentStatus }>(
      `SELECT s.user_id::text, a.session_id, a.status FROM agent_session_attachment a
       JOIN agent_session s ON s.id = a.session_id WHERE a.id = $1 FOR UPDATE OF a`, [input.attachmentId],
    );
    if (!parent.rows[0]) { await client.query("COMMIT"); return false; }
    await putR2Object(input.r2Key, input.body, input.mimeType);
    uploaded = true;
    const status = ["deleting", "expired", "promoted"].includes(parent.rows[0].status) ? "delete_pending" : "present";
    await client.query(
      `INSERT INTO agent_attachment_object
         (id, attachment_id, user_id, session_id, kind, r2_key, byte_size, status, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 = 'delete_pending' THEN now() ELSE NULL END)
       ON CONFLICT (r2_key) DO UPDATE SET byte_size = EXCLUDED.byte_size`,
      [newAttachmentObjectId(), input.attachmentId, parent.rows[0].user_id, parent.rows[0].session_id,
       input.kind, input.r2Key, input.body.byteLength, status],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    if (uploaded) await deleteR2Object(input.r2Key).catch((cleanupErr) => {
      console.error(`[agent-attachment] 派生对象登记失败后的补偿删除失败 ${input.r2Key}:`, cleanupErr);
    });
    throw err;
  } finally { client.release(); }
}

export async function expireDueAttachments(): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ id: string }>(
      `UPDATE agent_session_attachment SET status = 'deleting'
       WHERE status IN ('pending', 'ready', 'released') AND (expires_at <= now() OR absolute_expires_at <= now()) RETURNING id`,
    );
    if (due.rows.length) await client.query(
      `UPDATE agent_attachment_object SET status = 'delete_pending', next_attempt_at = now()
       WHERE attachment_id = ANY($1::text[]) AND status IN ('reserved', 'present', 'deleting')`,
      [due.rows.map((row) => row.id)],
    );
    await client.query("COMMIT");
    return due.rows.length;
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function runAttachmentGcBatch(limit = 25): Promise<{ deleted: number; failed: number }> {
  await expireDueAttachments();
  await getPool().query(`UPDATE agent_attachment_object SET status = 'delete_pending' WHERE status = 'deleting' AND next_attempt_at <= now()`);
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const client = await getPool().connect();
    let object: { id: string; r2_key: string; attachment_id: string | null; attempts: number } | undefined;
    try {
      await client.query("BEGIN");
      const claimed = await client.query<{ id: string; r2_key: string; attachment_id: string | null; attempts: number }>(
        `SELECT id, r2_key, attachment_id, attempts FROM agent_attachment_object
         WHERE status = 'delete_pending' AND COALESCE(next_attempt_at, now()) <= now()
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      object = claimed.rows[0];
      if (!object) { await client.query("COMMIT"); break; }
      await client.query(
        `UPDATE agent_attachment_object SET status = 'deleting', attempts = attempts + 1,
           next_attempt_at = now() + interval '5 minutes' WHERE id = $1`, [object.id],
      );
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
    try {
      await deleteR2Object(object.r2_key);
      await getPool().query(
        `UPDATE agent_attachment_object SET status = 'deleted', deleted_at = now(), next_attempt_at = NULL, last_error = NULL WHERE id = $1`,
        [object.id],
      );
      if (object.attachment_id) await getPool().query(
        `UPDATE agent_session_attachment a SET status = 'expired', deleted_at = now()
         WHERE a.id = $1 AND a.status = 'deleting'
           AND NOT EXISTS (SELECT 1 FROM agent_attachment_object o WHERE o.attachment_id = a.id AND o.status NOT IN ('deleted', 'transferred'))`,
        [object.attachment_id],
      );
      deleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delaySeconds = Math.min(86400, 60 * (2 ** Math.min(object.attempts, 10)));
      await getPool().query(
        `UPDATE agent_attachment_object SET status = 'delete_pending', last_error = $2,
           next_attempt_at = now() + ($3 * interval '1 second') WHERE id = $1`,
        [object.id, message.slice(0, 1000), delaySeconds],
      );
      failed++;
    }
  }
  return { deleted, failed };
}

export async function attachmentGcMetrics() {
  const r = await getPool().query<{ pending_count: string; pending_bytes: string; failed_count: string; oldest_failure_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE status IN ('delete_pending','deleting')) AS pending_count,
            COALESCE(sum(byte_size) FILTER (WHERE status IN ('delete_pending','deleting')), 0) AS pending_bytes,
            count(*) FILTER (WHERE last_error IS NOT NULL AND status IN ('delete_pending','deleting')) AS failed_count,
            min(created_at) FILTER (WHERE last_error IS NOT NULL AND status IN ('delete_pending','deleting')) AS oldest_failure_at
     FROM agent_attachment_object`,
  );
  return {
    pendingCount: Number(r.rows[0].pending_count), pendingBytes: Number(r.rows[0].pending_bytes),
    failedCount: Number(r.rows[0].failed_count), oldestFailureAt: r.rows[0].oldest_failure_at?.toISOString() ?? null,
  };
}
