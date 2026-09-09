import { Pool } from "pg";

const g = global as typeof globalThis & { __pgPool?: Pool };

/**
 * 池参数（#459）：三个进程（next / agent-runner / heavy-worker）各持一池，
 * 每池的 max 之和不能超过 PG 的 max_connections（线上 100，保留 3）余量——
 * 所以 max 按进程分配，写在 deploy/ecosystem.config.js 的进程 env 里，
 * 不写 shared/.env.local（那份三个进程共用，区分不了）。
 *
 * 四道闸的分工：
 * - max                 一条慢路径顶住连接时，排队范围有上界；
 * - statement_timeout   单条语句（含 pg_advisory_xact_lock / FOR UPDATE 的**等锁**）封顶；
 * - idle_in_transaction 事务开着不动的连接不能无限占坑；
 * - connectionTimeout   池满时取连接不再无限等，转成显式报错（宽一点：冷池突发建连别误杀）。
 *
 * 任一项设 0 = 关掉该闸（pg 对 0 值不下发对应参数；connectionTimeoutMillis 的 0 同义）。
 */
export const PG_POOL_DEFAULTS = {
  max: 20,
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
} as const;

/** env 里的非负数；未设/空/非法一律回落缺省（0 是合法值，表示关闸）。 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 池配置（导出供测试静态断言：闸只要漏配一项就是全站放大器）。 */
export function poolConfigFromEnv() {
  return {
    database: process.env.PGDATABASE ?? "script_editor",
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: envNum("PG_POOL_MAX", PG_POOL_DEFAULTS.max),
    connectionTimeoutMillis: envNum("PG_CONNECTION_TIMEOUT_MS", PG_POOL_DEFAULTS.connectionTimeoutMs),
    // 这两项经启动包下发，是**会话默认值**——连接内 `SET`/`RESET` 仍照常工作，
    // RESET 回到的就是这里的值。
    statement_timeout: envNum("PG_STATEMENT_TIMEOUT_MS", PG_POOL_DEFAULTS.statementTimeoutMs),
    idle_in_transaction_session_timeout: envNum(
      "PG_IDLE_IN_TX_TIMEOUT_MS",
      PG_POOL_DEFAULTS.idleInTransactionTimeoutMs,
    ),
  };
}

export function getPool(): Pool {
  if (!g.__pgPool) {
    g.__pgPool = new Pool(poolConfigFromEnv());
  }
  return g.__pgPool;
}
