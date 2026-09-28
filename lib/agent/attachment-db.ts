import { getPool } from "@/lib/pg";
import { parseSessionIdentity } from "@/lib/agent/tools/session-identity";
import { newAttachmentId } from "@/lib/agent/runtime/ids";

export const AGENT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const AGENT_ATTACHMENT_MAX_PER_MESSAGE = 8;

export type AgentAttachment = {
  id: string;
  sessionId: string;
  r2Key: string;
  fileName: string;
  mimeType: string;
  mediaKind: string | null;
  fileSize: number;
  status: "pending" | "ready";
};

type Row = {
  id: string;
  session_id: string;
  r2_key: string;
  file_name: string;
  mime_type: string;
  media_kind: string | null;
  file_size: string | number;
  status: "pending" | "ready";
};

function mapRow(row: Row): AgentAttachment {
  return {
    id: row.id,
    sessionId: row.session_id,
    r2Key: row.r2_key,
    fileName: row.file_name,
    mimeType: row.mime_type,
    mediaKind: row.media_kind,
    fileSize: Number(row.file_size),
    status: row.status,
  };
}

/** 附件可能先于第一条消息上传，因此在这里按已签发 session key 建空会话。 */
export async function createPendingAttachment(input: {
  sessionId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  mediaKind?: string | null;
  fileSize: number;
}): Promise<AgentAttachment> {
  const identity = parseSessionIdentity(input.sessionId);
  if (!identity || identity.userId !== input.userId) throw Object.assign(new Error("无权访问该会话"), { status: 403 });
  const id = newAttachmentId();
  const safeName = input.fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 240) || "attachment";
  const r2ObjectName = safeName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  const r2Key = `agent-attachments/${id}/${r2ObjectName}`;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO agent_session (id, user_id, production_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [input.sessionId, input.userId, identity.productionId ?? null],
    );
    const owner = await client.query<{ user_id: string; production_id: string | null }>(
      `SELECT user_id::text, production_id FROM agent_session WHERE id = $1 FOR UPDATE`,
      [input.sessionId],
    );
    if (owner.rows[0]?.user_id !== input.userId || owner.rows[0]?.production_id !== (identity.productionId ?? null)) {
      throw Object.assign(new Error("无权访问该会话"), { status: 403 });
    }
    const inserted = await client.query<Row>(
      `INSERT INTO agent_session_attachment (id, session_id, r2_key, file_name, mime_type, media_kind, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, input.sessionId, r2Key, safeName, input.mimeType, input.mediaKind ?? null, input.fileSize],
    );
    await client.query("COMMIT");
    return mapRow(inserted.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markAttachmentReady(
  attachmentId: string,
  sessionId: string,
  userId: string,
  verifiedSize: number,
): Promise<AgentAttachment | null> {
  const r = await getPool().query<Row>(
    `UPDATE agent_session_attachment a SET status = 'ready', ready_at = now(), file_size = $4
     FROM agent_session s
     WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3
     RETURNING a.*`,
    [attachmentId, sessionId, userId, verifiedSize],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function getAttachmentUploadRecord(
  attachmentId: string, sessionId: string, userId: string,
): Promise<Pick<AgentAttachment, "r2Key" | "fileSize"> | null> {
  const r = await getPool().query<{ r2_key: string; file_size: string | number }>(
    `SELECT a.r2_key, a.file_size FROM agent_session_attachment a
     JOIN agent_session s ON s.id = a.session_id
     WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3`,
    [attachmentId, sessionId, userId],
  );
  return r.rows[0] ? { r2Key: r.rows[0].r2_key, fileSize: Number(r.rows[0].file_size) } : null;
}

export async function getReadyAttachments(
  attachmentIds: string[], sessionId: string, userId: string,
): Promise<AgentAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const r = await getPool().query<Row>(
    `SELECT a.* FROM agent_session_attachment a
     JOIN agent_session s ON s.id = a.session_id
     WHERE a.id = ANY($1::text[]) AND a.session_id = $2 AND s.user_id = $3 AND a.status = 'ready'`,
    [attachmentIds, sessionId, userId],
  );
  const byId = new Map(r.rows.map((row) => [row.id, mapRow(row)]));
  return attachmentIds.map((id) => byId.get(id)).filter((a): a is AgentAttachment => Boolean(a));
}

export async function getReadyAttachmentForSession(
  attachmentId: string, sessionId: string, userId: string,
): Promise<AgentAttachment | null> {
  return (await getReadyAttachments([attachmentId], sessionId, userId))[0] ?? null;
}

export async function listReadyAttachmentsForSession(sessionId: string): Promise<AgentAttachment[]> {
  const r = await getPool().query<Row>(
    `SELECT * FROM agent_session_attachment WHERE session_id = $1 AND status = 'ready' ORDER BY created_at`,
    [sessionId],
  );
  return r.rows.map(mapRow);
}

export async function attachmentKeysForSession(sessionId: string): Promise<string[]> {
  const r = await getPool().query<{ r2_key: string }>(
    `SELECT r2_key FROM agent_session_attachment WHERE session_id = $1`, [sessionId],
  );
  return r.rows.map((row) => row.r2_key);
}

export async function deleteAttachment(
  attachmentId: string, sessionId: string, userId: string,
): Promise<string | null> {
  const r = await getPool().query<{ r2_key: string }>(
    `DELETE FROM agent_session_attachment a
     USING agent_session s
     WHERE a.id = $1 AND a.session_id = $2 AND s.id = a.session_id AND s.user_id = $3
     RETURNING a.r2_key`,
    [attachmentId, sessionId, userId],
  );
  return r.rows[0]?.r2_key ?? null;
}
