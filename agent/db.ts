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

// Minimal BotContext fields needed to resume a session from a button click.
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
