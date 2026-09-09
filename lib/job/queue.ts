// 后台重活任务队列（db/add-job-queue.sql）——enqueue / 租约认领 / 完成 / 双模式等待。
//
// 设计（2026-09 负载盘点定谳：单体大任务异步化，不影响主进程）：
// - 传输层就是 pg：INSERT + pg_notify('job_new') 派发，worker 用原子 UPDATE +
//   FOR UPDATE SKIP LOCKED 认领（与 agent_schedule 节拍同款），完成/终局
//   pg_notify('job_done') 通知等待方。未来集群子服务器＝多进程从同一张表认领，
//   调用方代码不变。
// - 双模式：waitForJob(id, timeoutMs) 短等（LISTEN + 轮询兜底），到点返回 null，
//   调用方转后台语义（doc 工具会告诉模型"解析完成后自动通知"）。
// - 无 worker 形态（本地 dev / 测试 / 未配 JOB_WORKER 的部署）：enqueue 原地执行
//   handler——与历史同步行为一致，一条代码路径两种部署（同 AGENT_RUNNER_URL 模式）。
// - 重试：认领时 attempts+1；失败非终局则退避重排（30s×attempts），attempts 用尽或
//   TerminalJobError（解析类确定性失败）→ failed。租约过期由 sweep 收回。

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";

export const JOB_NEW_CHANNEL = "job_new";
export const JOB_DONE_CHANNEL = "job_done";
const LEASE_MS = 10 * 60_000;
const RETRY_BACKOFF_MS = 30_000;
const WAIT_POLL_MS = 2_000;

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseOwner: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** 确定性失败（坏文件、未知任务类型等）：不重试，直接 failed。 */
export class TerminalJobError extends Error {
  constructor(msg: string) { super(msg); this.name = "TerminalJobError"; }
}

export const newJobId = () => `jb_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** 有独立 heavy-worker 消费队列（服务器 .env.local 设 JOB_WORKER=1）；未设则原地执行。 */
export function jobWorkerEnabled(): boolean {
  return process.env.JOB_WORKER === "1";
}

type Raw = {
  id: string; kind: string; payload: Record<string, unknown>; dedupe_key: string | null; priority: number;
  status: JobStatus; attempts: number; max_attempts: number; run_after: Date; lease_owner: string | null;
  result: Record<string, unknown> | null; error: string | null; created_at: Date; finished_at: Date | null;
};
const COLS = `id, kind, payload, dedupe_key, priority, status, attempts, max_attempts, run_after, lease_owner, result, error, created_at, finished_at`;
function toRow(r: Raw): JobRow {
  return {
    id: r.id, kind: r.kind, payload: r.payload ?? {}, dedupeKey: r.dedupe_key, priority: r.priority,
    status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, runAfter: r.run_after,
    leaseOwner: r.lease_owner, result: r.result, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

// ── enqueue ──────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  kind: string;
  payload: Record<string, unknown>;
  /** 相同工作合流：已有同 key 的在途任务时直接返回它（等待方挂同一个 job）。 */
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
}

export async function enqueueJob(input: EnqueueInput): Promise<JobRow> {
  const pool = getPool();
  if (input.dedupeKey) {
    const existing = await pool.query<Raw>(
      `SELECT ${COLS} FROM job WHERE dedupe_key = $1 AND status IN ('queued','running') LIMIT 1`,
      [input.dedupeKey],
    );
    if (existing.rows[0]) return toRow(existing.rows[0]);
  }
  const id = newJobId();
  let row: Raw;
  try {
    const r = await pool.query<Raw>(
      `INSERT INTO job (id, kind, payload, dedupe_key, priority, max_attempts)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING ${COLS}`,
      [id, input.kind, JSON.stringify(input.payload), input.dedupeKey ?? null, input.priority ?? 0, input.maxAttempts ?? 3],
    );
    row = r.rows[0];
  } catch (err) {
    // 并发窗口撞 job_dedupe_active_idx：认对方为准
    if (input.dedupeKey && (err as { code?: string })?.code === "23505") {
      const again = await pool.query<Raw>(
        `SELECT ${COLS} FROM job WHERE dedupe_key = $1 AND status IN ('queued','running') LIMIT 1`,
        [input.dedupeKey],
      );
      if (again.rows[0]) return toRow(again.rows[0]);
    }
    throw err;
  }
  if (jobWorkerEnabled()) {
    await pool.query(`SELECT pg_notify($1, $2)`, [JOB_NEW_CHANNEL, id]).catch(() => {});
  } else {
    // 无 worker 形态：原地跑完再返回（与历史同步行为一致；dev/测试专用路径）
    const { executeJobInline } = await import("./run");
    await executeJobInline(id);
  }
  const fresh = await getJob(id);
  return fresh ?? toRow(row);
}

/**
 * 等待方超时转后台的那一刻，把要唤醒的 agent 会话补进 payload。
 * 不在 enqueue 时写：快路径（等待内完成）不该留下唤醒字段（模型会收到多余插话）。
 * 执行侧在终局后读**最新**行（lib/job/run.ts maybeSteer），接住写入与完成擦肩的竞态。
 */
export async function requestJobSteer(id: string, sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE job SET payload = payload || jsonb_build_object('notifySessionId', $2::text) WHERE id = $1`,
    [id, sessionId],
  );
}

export async function getJob(id: string): Promise<JobRow | null> {
  const r = await getPool().query<Raw>(`SELECT ${COLS} FROM job WHERE id = $1`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

// ── worker 侧：认领 / 完成 / 失败 / sweep ─────────────────────────────────────

/** 租约认领至多 limit 条到期任务（excludeKinds＝已占满并发槽的种类）。认领即 attempts+1。 */
export async function claimJobs(owner: string, limit: number, opts: { excludeKinds?: string[] } = {}): Promise<JobRow[]> {
  if (limit <= 0) return [];
  const exclude = opts.excludeKinds?.length ? opts.excludeKinds : null;
  const r = await getPool().query<Raw>(
    `UPDATE job j SET status = 'running', lease_owner = $1, lease_until = now() + ($2::int * interval '1 millisecond'),
                      attempts = attempts + 1, started_at = COALESCE(started_at, now())
     WHERE j.id IN (
       SELECT id FROM job
       WHERE status = 'queued' AND run_after <= now() AND ($4::text[] IS NULL OR NOT (kind = ANY($4)))
       ORDER BY priority DESC, created_at LIMIT $3 FOR UPDATE SKIP LOCKED
     )
     RETURNING ${COLS}`,
    [owner, LEASE_MS, limit, exclude],
  );
  return r.rows.map(toRow);
}

/** 按 id 认领指定任务（inline 执行路径用）。 */
export async function claimJobById(id: string, owner: string): Promise<JobRow | null> {
  const r = await getPool().query<Raw>(
    `UPDATE job SET status = 'running', lease_owner = $2, lease_until = now() + ($3::int * interval '1 millisecond'),
                    attempts = attempts + 1, started_at = COALESCE(started_at, now())
     WHERE id = $1 AND status = 'queued' RETURNING ${COLS}`,
    [id, owner, LEASE_MS],
  );
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

async function notifyDone(id: string): Promise<void> {
  await getPool().query(`SELECT pg_notify($1, $2)`, [JOB_DONE_CHANNEL, id]).catch(() => {});
}

export async function completeJob(id: string, owner: string, result: Record<string, unknown> | null): Promise<void> {
  await getPool().query(
    `UPDATE job SET status = 'done', result = $3::jsonb, error = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, result == null ? null : JSON.stringify(result)],
  );
  await notifyDone(id);
}

/** 失败：非终局且 attempts 未用尽 → 退避重排；否则 failed（终局，通知等待方）。 */
export async function failJob(id: string, owner: string, error: string, opts: { terminal?: boolean } = {}): Promise<void> {
  const pool = getPool();
  const r = await pool.query<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts FROM job WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner],
  );
  if (!r.rows[0]) return;
  const { attempts, max_attempts } = r.rows[0];
  const terminal = opts.terminal || attempts >= max_attempts;
  if (terminal) {
    await pool.query(
      `UPDATE job SET status = 'failed', error = $3, lease_owner = NULL, lease_until = NULL, finished_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [id, owner, error.slice(0, 2000)],
    );
    await notifyDone(id);
    return;
  }
  await pool.query(
    `UPDATE job SET status = 'queued', error = $3, lease_owner = NULL, lease_until = NULL,
                    run_after = now() + ($4::int * interval '1 millisecond')
     WHERE id = $1 AND lease_owner = $2`,
    [id, owner, error.slice(0, 2000), RETRY_BACKOFF_MS * attempts],
  );
}

/** 收回过期租约（worker 崩溃/OOM 留下的 running 行）：可重试的重排，用尽的终局。返回处理数。 */
export async function sweepExpiredLeases(): Promise<number> {
  const pool = getPool();
  const failed = await pool.query<{ id: string }>(
    `UPDATE job SET status = 'failed', error = COALESCE(error, '') || '（租约过期：执行进程未正常收尾）',
                    lease_owner = NULL, lease_until = NULL, finished_at = now()
     WHERE status = 'running' AND lease_until < now() AND attempts >= max_attempts RETURNING id`,
  );
  for (const row of failed.rows) await notifyDone(row.id);
  const requeued = await pool.query(
    `UPDATE job SET status = 'queued', lease_owner = NULL, lease_until = NULL
     WHERE status = 'running' AND lease_until < now()`,
  );
  return failed.rows.length + (requeued.rowCount ?? 0);
}

// ── 双模式等待（LISTEN job_done 单例 + 轮询兜底）──────────────────────────────
// 形态照抄 lib/wiki/collab.ts 的 CollabListener：进程级单例、第一个等待方才连、
// 断连置空下次重连；错过的通知由轮询兜底（不追求 exactly-once，只求叫得快）。

type Waiter = (row: JobRow) => void;

class DoneListener {
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  /** 连接还给池的幂等入口（error 与 stop 共用）——见 ensure 里的注释。 */
  private drop: ((err?: Error) => void) | null = null;
  readonly waiters = new Map<string, Set<Waiter>>();

  async ensure(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await getPool().connect();
      // 断连即把连接还给池（#459）：签出中的连接报错时 pg-pool 不会自己回收——它在
      // 签出那一刻就摘掉了自己的 error 监听器，只有 release() 才会把连接移出池。
      // 光置空引用＝这个槽位永久损失；线上 PG 约每周随 unattended-upgrades 重启一次，
      // 每次重启每个进程漏一个，攒够 max 就是全池死锁。
      let released = false;
      const drop = (err?: Error) => {
        if (released) return;
        released = true;
        if (this.client === client) this.client = null;
        if (this.drop === drop) this.drop = null;
        try { client.release(err); } catch { /* 已经还过了 */ }
      };
      this.drop = drop;
      client.on("notification", (msg) => {
        if (msg.channel !== JOB_DONE_CHANNEL || !msg.payload) return;
        const set = this.waiters.get(msg.payload);
        if (!set?.size) return;
        void getJob(msg.payload)
          .then((row) => { if (row && (row.status === "done" || row.status === "failed")) for (const w of [...set]) w(row); })
          .catch(() => {});
      });
      client.on("error", drop);
      try {
        await client.query(`LISTEN ${JOB_DONE_CHANNEL}`);
      } catch (err) {
        drop(err as Error);
        throw err;
      }
      if (released) return; // 建连途中就被 stop()/断连还回去了，别再挂上来
      this.client = client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async stop(): Promise<void> {
    const c = this.client;
    const drop = this.drop;
    this.client = null;
    if (c) { try { await c.query(`UNLISTEN ${JOB_DONE_CHANNEL}`); } catch { /* ignore */ } }
    drop?.(); // 与 error 分支共用同一个幂等入口，不会重复 release
  }
}

const gl = global as typeof globalThis & { __jobDoneListener?: DoneListener };
function listener(): DoneListener {
  if (!gl.__jobDoneListener) gl.__jobDoneListener = new DoneListener();
  return gl.__jobDoneListener;
}

/** 测试用：断开 LISTEN 连接（否则连接池关不掉）。 */
export async function stopJobListenerForTests(): Promise<void> {
  await gl.__jobDoneListener?.stop();
}

/**
 * 等任务终局（done/failed），至多 timeoutMs；超时返回 null（调用方转后台语义）。
 * LISTEN 叫醒为主、轮询兜底（NOTIFY 在 LISTEN 建立前发出会错过）。
 */
export async function waitForJob(id: string, timeoutMs: number): Promise<JobRow | null> {
  const first = await getJob(id);
  if (!first) return null;
  if (first.status === "done" || first.status === "failed") return first;
  if (timeoutMs <= 0) return null;

  const l = listener();
  await l.ensure().catch(() => { /* LISTEN 失败仍有轮询兜底 */ });

  return new Promise<JobRow | null>((resolve) => {
    let settled = false;
    const finish = (row: JobRow | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(poll);
      const set = l.waiters.get(id);
      set?.delete(onDone);
      if (set && set.size === 0) l.waiters.delete(id);
      resolve(row);
    };
    const onDone: Waiter = (row) => finish(row);
    if (!l.waiters.has(id)) l.waiters.set(id, new Set());
    l.waiters.get(id)!.add(onDone);
    const deadline = setTimeout(() => finish(null), timeoutMs);
    const poll = setInterval(() => {
      void getJob(id).then((row) => {
        if (row == null) return finish(null); // 行没了（被清理）——别让等待方干等
        if (row.status === "done" || row.status === "failed") finish(row);
      }).catch(() => {});
    }, WAIT_POLL_MS);
  });
}
