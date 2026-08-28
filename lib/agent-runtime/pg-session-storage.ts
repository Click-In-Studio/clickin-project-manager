// Postgres 版会话树存储（#367 S2）：vendor agent-core 的 SessionStorage 实现。
//
// BaseSessionStorage 已经把树语义（leaf/appendParent/label/逻辑父/路径重建）全做完，
// 子类只需两件事：启动时从 agent_session_entry 装载全部条目、追加时落一行。
// 单执行者前提（agent_run 租约，§4.4）：同一会话同时只有一个 runner 进程在追加，
// seq 用 max+1 即可；(session_id, seq) 与 (session_id, entry_id) 两条唯一约束是
// 前提被打破时的最后防线（违约抛错而不是静默写坏树）。

import type { Pool } from "pg";
import { getPool } from "@/lib/pg";
import { BaseSessionStorage } from "../../vendor/openclaw/packages/agent-core/src/harness/session/storage-base";
import type {
  SessionMetadata,
  SessionTreeEntry,
} from "../../vendor/openclaw/packages/agent-core/src/harness/types";

export interface PgSessionMetadata extends SessionMetadata {
  userId: string;
  productionId: string | null;
}

type SessionRow = { id: string; user_id: string; production_id: string | null; created_at: Date };
type EntryRow = { payload: SessionTreeEntry };

export class PgSessionStorage extends BaseSessionStorage<PgSessionMetadata> {
  private constructor(
    private readonly pool: Pool,
    metadata: PgSessionMetadata,
    entries: SessionTreeEntry[],
  ) {
    super(metadata, entries);
  }

  /** 装载既有会话；不存在返回 null（调用方决定 404 还是新建）。 */
  static async load(sessionId: string, pool: Pool = getPool()): Promise<PgSessionStorage | null> {
    const s = await pool.query<SessionRow>(
      `SELECT id, user_id, production_id, created_at FROM agent_session WHERE id = $1`,
      [sessionId],
    );
    const row = s.rows[0];
    if (!row) return null;
    const e = await pool.query<EntryRow>(
      `SELECT payload FROM agent_session_entry WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return new PgSessionStorage(
      pool,
      { id: row.id, createdAt: row.created_at.toISOString(), userId: row.user_id, productionId: row.production_id },
      e.rows.map((r) => r.payload),
    );
  }

  /** 新建会话行并返回空树存储。user/production 关联在这里一次定死。 */
  static async create(
    input: { id: string; userId: string; productionId: string | null; title?: string | null },
    pool: Pool = getPool(),
  ): Promise<PgSessionStorage> {
    const r = await pool.query<{ created_at: Date }>(
      `INSERT INTO agent_session (id, user_id, production_id, title)
       VALUES ($1, $2, $3, $4) RETURNING created_at`,
      [input.id, input.userId, input.productionId, input.title ?? null],
    );
    return new PgSessionStorage(
      pool,
      { id: input.id, createdAt: r.rows[0].created_at.toISOString(), userId: input.userId, productionId: input.productionId },
      [],
    );
  }

  private async persist(entry: SessionTreeEntry): Promise<void> {
    const meta = await this.getMetadata();
    await this.pool.query(
      `INSERT INTO agent_session_entry (session_id, seq, entry_id, parent_id, type, payload)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5::jsonb
       FROM agent_session_entry WHERE session_id = $1`,
      [meta.id, entry.id, entry.parentId, entry.type, JSON.stringify(entry)],
    );
    // 会话活跃时间：只有消息类条目算"最后一条消息"
    await this.pool.query(
      `UPDATE agent_session SET updated_at = now()${entry.type === "message" ? ", last_message_at = now()" : ""} WHERE id = $1`,
      [meta.id],
    );
  }

  override async setLeafId(leafId: string | null): Promise<void> {
    const entry = this.createLeafEntry(leafId);
    await this.persist(entry);
    this.recordEntry(entry);
  }

  override async appendEntry(entry: SessionTreeEntry): Promise<void> {
    // 先落库再入内存：DB 拒绝（唯一约束）时内存树保持与 DB 一致
    await this.persist(entry);
    this.recordEntry(entry);
  }
}
