// 事件分发（#367 §4.4 ③ 观看者与执行者解耦）。
//
// 执行侧：StreamLine 逐条落 agent_event（seq 单调）+ pg_notify('agent_events',
// '<sessionId>:<seq>')。delta 行做时间窗合并（累计值语义，合并无损），其余行立即落。
// 观看侧：LISTEN agent_events，收到通知按 (session_id, seq > cursor) 取行推给
// SSE；断线重连 since=seq 直接重放。哪个进程在执行 run 对观看者不可见。

import type { Pool, PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import type { StreamLine } from "@/lib/agent-gateway/stream-reducer";

export const EVENT_CHANNEL = "agent_events";
const DELTA_COALESCE_MS = 80;

export interface EventRow {
  seq: number;
  line: StreamLine;
}

/** 执行侧发布器：一个 run 一个实例。 */
export class EventPublisher {
  private pendingDelta: StreamLine | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    private readonly runId: string | null,
    private readonly pool: Pool = getPool(),
  ) {}

  /** 非 delta 行立即入队（保序）；delta 合并到时间窗末尾（最后一个胜出）。 */
  publish(line: StreamLine): void {
    if (line.type === "delta") {
      this.pendingDelta = line;
      if (!this.timer) this.timer = setTimeout(() => this.flushDelta(), DELTA_COALESCE_MS);
      return;
    }
    // 非 delta 行到达前先把挂着的 delta 冲出去，保证顺序（例如 delta → tool）
    this.flushDelta();
    this.enqueue(line);
  }

  private flushDelta(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pendingDelta) return;
    const line = this.pendingDelta;
    this.pendingDelta = null;
    this.enqueue(line);
  }

  private enqueue(line: StreamLine): void {
    this.chain = this.chain.then(() => this.write(line)).catch((err) => {
      console.error("[agent-runtime] event write failed:", err);
    });
  }

  private async write(line: StreamLine): Promise<void> {
    await this.pool.query(
      `WITH next AS (SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_event WHERE session_id = $1),
       ins AS (
         INSERT INTO agent_event (session_id, seq, run_id, line)
         SELECT $1, next.seq, $2, $3::jsonb FROM next RETURNING seq
       )
       SELECT pg_notify($4, $1 || ':' || ins.seq::text) FROM ins`,
      [this.sessionId, this.runId, JSON.stringify(line), EVENT_CHANNEL],
    );
  }

  /** 等全部行落库（run 收尾时调用，保证 final 行先于 run 状态更新可见）。 */
  async drain(): Promise<void> {
    this.flushDelta();
    await this.chain;
  }
}

export async function readEventsSince(sessionId: string, afterSeq: number, pool: Pool = getPool()): Promise<EventRow[]> {
  const r = await pool.query<{ seq: string; line: StreamLine }>(
    `SELECT seq, line FROM agent_event WHERE session_id = $1 AND seq > $2 ORDER BY seq`,
    [sessionId, afterSeq],
  );
  return r.rows.map((row) => ({ seq: Number(row.seq), line: row.line }));
}

/** run 结束后清理 delta 行（终态与工具/审批行保留，作为重连重放与审计材料）。 */
export async function pruneDeltas(sessionId: string, runId: string, pool: Pool = getPool()): Promise<void> {
  await pool.query(
    `DELETE FROM agent_event WHERE session_id = $1 AND run_id = $2 AND line->>'type' = 'delta'`,
    [sessionId, runId],
  );
}

type Listener = (seq: number) => void;

/**
 * 进程级 LISTEN 单例：一条专用连接，按 sessionId 分发通知。
 * 连接断开时自动重连；订阅者若错过通知也不会丢事件——消费侧按 seq 游标取行，
 * 通知只是"该去取了"的提示。
 */
class EventListener {
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly pool: Pool) {}

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await this.pool.connect();
      client.on("notification", (msg) => {
        if (msg.channel !== EVENT_CHANNEL || !msg.payload) return;
        const idx = msg.payload.lastIndexOf(":");
        const sessionId = msg.payload.slice(0, idx);
        const seq = Number(msg.payload.slice(idx + 1));
        for (const fn of this.listeners.get(sessionId) ?? []) fn(seq);
      });
      client.on("error", () => {
        this.client = null; // 下次 subscribe 重连
      });
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      this.client = client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async subscribe(sessionId: string, fn: Listener): Promise<() => void> {
    await this.ensureConnected();
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }
}

const g = global as typeof globalThis & { __agentEventListener?: EventListener };

export function subscribeSessionEvents(sessionId: string, fn: Listener): Promise<() => void> {
  if (!g.__agentEventListener) g.__agentEventListener = new EventListener(getPool());
  return g.__agentEventListener.subscribe(sessionId, fn);
}
