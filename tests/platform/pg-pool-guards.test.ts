import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { getPool, poolConfigFromEnv, PG_POOL_DEFAULTS } from "@/lib/pg";
import { registerWikiSSE, stopCollabListenerForTests, COLLAB_CHANNEL } from "@/lib/wiki/collab";
import { shortId } from "../_support/factories";

// #459 连接池四道闸 + LISTEN 连接回收。
//
// 这个文件盯的是**接线**，不是业务：闸漏配一项、或某条长连接不还池，症状都不是
// 某个功能坏了，而是全站在某个不确定的时刻一起排队——单测里没有任何业务断言会红。

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("池配置（四道闸）", () => {
  it("缺省即四道闸齐全——任何一项缺失都是全站慢查询放大器", () => {
    const cfg = withEnv(
      {
        PG_POOL_MAX: undefined,
        PG_STATEMENT_TIMEOUT_MS: undefined,
        PG_IDLE_IN_TX_TIMEOUT_MS: undefined,
        PG_CONNECTION_TIMEOUT_MS: undefined,
      },
      poolConfigFromEnv,
    );
    expect(cfg.max).toBe(PG_POOL_DEFAULTS.max);
    expect(cfg.statement_timeout).toBe(PG_POOL_DEFAULTS.statementTimeoutMs);
    expect(cfg.idle_in_transaction_session_timeout).toBe(PG_POOL_DEFAULTS.idleInTransactionTimeoutMs);
    expect(cfg.connectionTimeoutMillis).toBe(PG_POOL_DEFAULTS.connectionTimeoutMs);
  });

  it("env 覆盖生效：池大小按进程分配（deploy/ecosystem.config.js 里三个进程各一份）", () => {
    const cfg = withEnv({ PG_POOL_MAX: "8", PG_CONNECTION_TIMEOUT_MS: "3000" }, poolConfigFromEnv);
    expect(cfg.max).toBe(8);
    expect(cfg.connectionTimeoutMillis).toBe(3000);
  });

  it("0 = 显式关闸；非法值回落缺省而不是把 NaN 塞进池", () => {
    const off = withEnv({ PG_STATEMENT_TIMEOUT_MS: "0" }, poolConfigFromEnv);
    expect(off.statement_timeout).toBe(0);

    for (const bad of ["", "  ", "abc", "-1"]) {
      const cfg = withEnv({ PG_STATEMENT_TIMEOUT_MS: bad }, poolConfigFromEnv);
      expect(cfg.statement_timeout).toBe(PG_POOL_DEFAULTS.statementTimeoutMs);
    }
  });

  it("statement_timeout 真的下发成会话 GUC（配置字段 ≠ 生效）", async () => {
    // 用独立的池验证下发链路：改共享池的会话默认值会污染同一 run 的其他测试文件。
    const pool = new Pool({ ...poolConfigFromEnv(), max: 1, statement_timeout: 300 });
    try {
      await expect(pool.query("SELECT pg_sleep(3)")).rejects.toMatchObject({ code: "57014" });
      const shown = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(shown.rows[0].statement_timeout).toBe("300ms");
    } finally {
      await pool.end();
    }
  });

  it("等锁也归 statement_timeout 管——这才是它在本仓的主要用途", async () => {
    // 应用里有 6 处 pg_advisory_xact_lock（同版本剧本补丁串行化）。没有闸时
    // 后到的那条无限等；有闸则到点报错，不会把连接永久顶住。
    const holder = new Pool({ ...poolConfigFromEnv(), max: 1 });
    const waiter = new Pool({ ...poolConfigFromEnv(), max: 1, statement_timeout: 500 });
    const key = Math.floor(Math.random() * 2_000_000_000);
    const c = await holder.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [key]);
      await expect(waiter.query("SELECT pg_advisory_xact_lock($1)", [key])).rejects.toMatchObject({ code: "57014" });
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
      await holder.end();
      await waiter.end();
    }
  });
});

describe("LISTEN 长连接：断连要还池", () => {
  const wikiId = `w-${shortId()}`;
  let cancel: (() => void) | null = null;

  afterAll(async () => {
    cancel?.();
    await stopCollabListenerForTests();
  });

  async function listenBackendPid(): Promise<number | null> {
    const res = await getPool().query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND query = $1 AND pid <> pg_backend_pid()`,
      [`LISTEN ${COLLAB_CHANNEL}`],
    );
    return res.rows[0]?.pid ?? null;
  }

  it("后端连接被掐断后，槽位回到池里（不还池＝每次 PG 重启永久少一个连接）", async () => {
    const pool = getPool();
    await stopCollabListenerForTests(); // 从干净状态起步：本 run 里别的文件可能已经连上了
    await waitFor(async () => (await listenBackendPid()) === null);
    const baseline = pool.totalCount;

    cancel = registerWikiSSE(wikiId, "c1", () => {});
    await waitFor(async () => (await listenBackendPid()) !== null);
    const pid = await listenBackendPid();
    expect(pid).not.toBeNull();
    expect(pool.totalCount).toBeGreaterThan(baseline);

    // 模拟 PG 重启/网络抖动：签出中的连接被服务端掐断。pg-pool 在签出那一刻就摘掉了
    // 自己的 error 监听器，所以只有我们主动 release 才会把它移出池。
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    await waitFor(() => pool.totalCount <= baseline);
    expect(pool.totalCount).toBeLessThanOrEqual(baseline);

    // 且下一次注册能重连（置空引用的语义没被破坏）
    const cancel2 = registerWikiSSE(`${wikiId}-again`, "c2", () => {});
    await waitFor(async () => (await listenBackendPid()) !== null);
    cancel2();
  });

  it("建连途中被 stop：连接不带着 LISTEN 回池（AI review #477-①）", async () => {
    const pool = getPool();
    await stopCollabListenerForTests();
    await waitFor(async () => (await listenBackendPid()) === null);
    const baseline = pool.totalCount;

    // 不等 ensure 落地就 stop——stop 若不等 this.connecting，drop() 会把一条
    // LISTEN 还在飞的连接还回池：它带着我们的 notification 监听器和 LISTEN 注册
    // 去给下一个主人用，且这次 stop 没机会发 UNLISTEN。
    const cancel3 = registerWikiSSE(`${wikiId}-race`, "c3", () => {});
    await stopCollabListenerForTests();
    cancel3();

    expect(await listenBackendPid()).toBeNull();
    await waitFor(() => pool.totalCount <= baseline);
  });
});
