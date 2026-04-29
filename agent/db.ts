import { Pool } from "pg";
import type { Message } from "./llm";

const g = global as typeof globalThis & { __agentPool?: Pool };

export function getPool(): Pool {
  if (!g.__agentPool) {
    g.__agentPool = new Pool({
      database: process.env.AGENT_PGDATABASE ?? "click_in_agent",
      host:     process.env.AGENT_PGHOST     ?? "localhost",
      port:     Number(process.env.AGENT_PGPORT ?? 5432),
      user:     process.env.AGENT_PGUSER,
      password: process.env.AGENT_PGPASSWORD,
    });
  }
  return g.__agentPool;
}

// ─── Session management ───────────────────────────────────────────────────────

export type CtxSnapshot = {
  chatId:     string;
  chatType:   "p2p" | "group";
  senderId:   string;
  senderName: string;
  chatName:   string;
};

export type PendingSession = {
  messages:    Message[];
  ctxSnapshot: CtxSnapshot;
  expired:     boolean;
};

export async function saveSession(
  key:         string,
  messages:    Message[],
  ctxSnapshot: CtxSnapshot,
  timeoutMs:   number,
): Promise<void> {
  const pool = getPool();
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  await pool.query(
    `INSERT INTO agent_sessions (session_key, messages, ctx_snapshot, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_key) DO UPDATE
       SET messages     = EXCLUDED.messages,
           ctx_snapshot = EXCLUDED.ctx_snapshot,
           expires_at   = EXCLUDED.expires_at,
           created_at   = NOW()`,
    [key, JSON.stringify(messages), JSON.stringify(ctxSnapshot), expiresAt],
  );
}

export async function loadSession(key: string): Promise<PendingSession | null> {
  const pool = getPool();
  const res = await pool.query<{
    messages:     Message[];
    ctx_snapshot: CtxSnapshot;
    expires_at:   Date;
  }>(
    `SELECT messages, ctx_snapshot, expires_at FROM agent_sessions WHERE session_key = $1`,
    [key],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    messages:    row.messages,
    ctxSnapshot: row.ctx_snapshot,
    expired:     new Date(row.expires_at) < new Date(),
  };
}

export async function deleteSession(key: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM agent_sessions WHERE session_key = $1`, [key]);
}

// Atomically deletes the session and returns whether it existed.
// Used by async skills to race against user input: if this returns true,
// the session was still pending and we can auto-resume; if false, a user
// message already consumed it and we should discard the skill result.
export async function tryConsumeSession(key: string): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM agent_sessions WHERE session_key = $1 RETURNING session_key`,
    [key],
  );
  return (res.rowCount ?? 0) > 0;
}

// Atomically deletes the session only if it is expired, returning its data.
// Used by the proactive timeout timer to race against an incoming user message:
// if this returns non-null, the timer won and should continue the agent loop;
// if null, a user message already consumed the session first.
export async function consumeExpiredSession(key: string): Promise<PendingSession | null> {
  const pool = getPool();
  const res = await pool.query<{ messages: Message[]; ctx_snapshot: CtxSnapshot }>(
    `DELETE FROM agent_sessions WHERE session_key = $1 AND expires_at <= NOW()
     RETURNING messages, ctx_snapshot`,
    [key],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0];
  return { messages: row.messages, ctxSnapshot: row.ctx_snapshot, expired: true };
}

// ─── script_editor database (read-only access) ───────────────────────────────

const gSE = global as typeof globalThis & { __scriptEditorPool?: Pool };

// Reuses the same agent credentials but connects to script_editor.
// Grant the agent_user access once:
//   GRANT CONNECT ON DATABASE script_editor TO agent_user;
//   \c script_editor
//   GRANT USAGE ON SCHEMA public TO agent_user;
//   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_user;
export function getScriptEditorPool(): Pool {
  if (!gSE.__scriptEditorPool) {
    gSE.__scriptEditorPool = new Pool({
      database: "script_editor",
      host:     process.env.AGENT_PGHOST ?? "localhost",
      port:     Number(process.env.AGENT_PGPORT ?? 5432),
      user:     process.env.AGENT_PGUSER,
      password: process.env.AGENT_PGPASSWORD,
    });
  }
  return gSE.__scriptEditorPool;
}

export type ProductionInfo = {
  id:          string;
  name:        string;
  createdAt:   Date;
  memberCount: number;
};

// Productions where every open_id in the list that is known to our system
// has access (is in production_member OR is a super_admin).
// Unknown open_ids (not in feishu_user) are ignored.
export async function getProductionsVisibleToAll(openIds: string[]): Promise<ProductionInfo[]> {
  if (openIds.length === 0) return [];
  const pool = getScriptEditorPool();
  const res = await pool.query<{
    id: string; name: string; created_at: Date; member_count: string;
  }>(
    `SELECT p.id, p.name, p.created_at,
       (SELECT COUNT(*) FROM production_member pm2 WHERE pm2.production_id = p.id) AS member_count
     FROM production p
     WHERE NOT EXISTS (
       SELECT 1
       FROM unnest($1::text[]) AS t(uid)
       JOIN feishu_user fu ON fu.open_id = t.uid
       WHERE NOT (
         fu.is_super_admin = true
         OR EXISTS (
           SELECT 1 FROM production_member pm
           WHERE pm.production_id = p.id AND pm.open_id = t.uid
         )
       )
     )
     ORDER BY p.created_at DESC`,
    [openIds],
  );
  return res.rows.map(r => ({
    id:          r.id,
    name:        r.name,
    createdAt:   r.created_at,
    memberCount: parseInt(r.member_count, 10),
  }));
}

// Sender's roles in each of the given productions.
export async function getMemberRolesInProductions(
  openId:        string,
  productionIds: string[],
): Promise<Map<string, string[]>> {
  if (productionIds.length === 0) return new Map();
  const pool = getScriptEditorPool();
  const res = await pool.query<{ production_id: string; roles: string[] }>(
    `SELECT production_id, roles FROM production_member
     WHERE open_id = $1 AND production_id = ANY($2::text[])`,
    [openId, productionIds],
  );
  const map = new Map<string, string[]>();
  for (const row of res.rows) map.set(row.production_id, row.roles);
  return map;
}

// ─── Chat context (production focus) ─────────────────────────────────────────

export type ProductionContext = { id: string; name: string };

export async function getChatProductionContext(chatId: string): Promise<ProductionContext | null> {
  const pool = getPool();
  const res = await pool.query<{ production_id: string; production_name: string }>(
    `SELECT production_id, production_name FROM agent_chat_context WHERE chat_id = $1`,
    [chatId],
  );
  if (res.rowCount === 0) return null;
  return { id: res.rows[0].production_id, name: res.rows[0].production_name };
}

export async function setChatProductionContext(
  chatId: string,
  productionId: string,
  productionName: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_chat_context (chat_id, production_id, production_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE
       SET production_id   = EXCLUDED.production_id,
           production_name = EXCLUDED.production_name,
           updated_at      = NOW()`,
    [chatId, productionId, productionName],
  );
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export async function getChatMemory(chatId: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ memory: string }>(
    `SELECT memory FROM chat_memories WHERE chat_id = $1`,
    [chatId],
  );
  return res.rows[0]?.memory ?? null;
}

export async function getUserMemory(senderId: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ memory: string }>(
    `SELECT memory FROM user_memories WHERE sender_id = $1`,
    [senderId],
  );
  return res.rows[0]?.memory ?? null;
}

export async function saveChatMemory(chatId: string, memory: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO chat_memories (chat_id, memory) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET memory = EXCLUDED.memory, updated_at = NOW()`,
    [chatId, memory],
  );
}

export async function saveUserMemory(senderId: string, memory: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO user_memories (sender_id, memory) VALUES ($1, $2)
     ON CONFLICT (sender_id) DO UPDATE SET memory = EXCLUDED.memory, updated_at = NOW()`,
    [senderId, memory],
  );
}
