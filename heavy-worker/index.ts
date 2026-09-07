// heavy-worker：后台重活的独立进程（2026-09 负载盘点：单体大任务异步化，不影响主进程）。
//
// 只做一件事：从 job 表租约认领任务（lib/job/queue.ts）并执行（lib/job/handlers.ts）。
// pdf/docx 解析、sharp 缩略图这类 CPU/内存重活全在这里跑——炸了只影响自己
// （pm2 拉起后，过期租约由 sweep 收回重排），agent-runner 和 next 主进程不受牵连。
// 未来商用化铺开：集群子服务器就是多个本进程从同一张表认领，调用方不感知。
//
// 启动：
//   npx tsx heavy-worker/index.ts                     # 本地（读 .env.local）
//   生产由 esbuild 打包（npm run build:worker）+ pm2（deploy/ecosystem.config.js）
// 环境：HEAVY_WORKER_PORT（默认 3103，仅 /health）、HEAVY_WORKER_CONCURRENCY（默认 2）、
//       JOB_TICK_MS（默认 2000）、HEAVY_WORKER_DRAIN_MS（默认 5 分钟）、
//       PG* / R2* / AGENT_RUNNER_URL（与 next 同一份 .env.local）
// 注意：本进程消费队列，不看 JOB_WORKER 开关——那是 enqueue 侧「有没有人替我干」的开关。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";

for (const line of fs.existsSync(".env.local") ? fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n") : []) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PORT = Number(process.env.HEAVY_WORKER_PORT ?? 3103);
const TICK_MS = Number(process.env.JOB_TICK_MS ?? 2_000);
const SWEEP_MS = Number(process.env.JOB_SWEEP_MS ?? 60_000);
const DRAIN_TIMEOUT_MS = Number(process.env.HEAVY_WORKER_DRAIN_MS ?? 300_000);
const MAX_CONCURRENT = Number(process.env.HEAVY_WORKER_CONCURRENCY ?? 2);
/** 单种类并发上限：解析是纯 CPU 单线程重活，多开只会互相拖慢 + 内存叠加。 */
const KIND_LIMITS: Record<string, number> = { doc_parse: 1 };

const OWNER = `hw:${hostname()}:${process.pid}`;

async function main() {
  const queue = await import("../lib/job/queue");
  const { executeClaimedJob } = await import("../lib/job/run");
  await import("../lib/job/handlers"); // 注册 handler

  let draining = false;
  const running = new Map<string, { kind: string; promise: Promise<void> }>();

  const runningOfKind = (kind: string) => [...running.values()].filter((r) => r.kind === kind).length;

  const tick = async () => {
    if (draining) return;
    try {
      // 逐条认领：每条前重算已占满的种类（批量领可能一批拿到两条 doc_parse，退回会白烧 attempts）
      while (running.size < MAX_CONCURRENT) {
        const excludeKinds = Object.keys(KIND_LIMITS).filter((k) => runningOfKind(k) >= KIND_LIMITS[k]);
        const [job] = await queue.claimJobs(OWNER, 1, { excludeKinds });
        if (!job) break;
        const promise = executeClaimedJob(job, OWNER)
          .catch((err) => console.error(`[heavy-worker] job ${job.id} (${job.kind}) crashed:`, err))
          .finally(() => {
            running.delete(job.id);
            if (!draining) void tick(); // 有空槽立刻补位
          });
        running.set(job.id, { kind: job.kind, promise });
      }
    } catch (err) {
      console.error("[heavy-worker] tick failed:", err);
    }
  };

  const tickTimer = setInterval(() => void tick(), TICK_MS);
  const sweepTimer = setInterval(() => {
    void queue.sweepExpiredLeases()
      .then((n) => { if (n > 0) console.log(`[heavy-worker] swept ${n} expired lease(s)`); })
      .catch((err) => console.error("[heavy-worker] sweep failed:", err));
  }, SWEEP_MS);

  // LISTEN job_new：新任务立即醒，比纯轮询快一拍；断连不重连（轮询兜底，错过只是慢 TICK_MS）
  const { getPool } = await import("../lib/pg");
  let listenClient: import("pg").PoolClient | null = null;
  try {
    listenClient = await getPool().connect();
    listenClient.on("notification", (msg) => { if (msg.channel === queue.JOB_NEW_CHANNEL) void tick(); });
    listenClient.on("error", () => { listenClient = null; });
    await listenClient.query(`LISTEN ${queue.JOB_NEW_CHANNEL}`);
  } catch (err) {
    console.error("[heavy-worker] LISTEN job_new failed (falling back to polling):", err);
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, owner: OWNER, running: running.size, draining }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[heavy-worker] ${OWNER} listening on 127.0.0.1:${PORT}, concurrency ${MAX_CONCURRENT}`);
    if (process.send) process.send("ready"); // pm2 wait_ready
  });

  await queue.sweepExpiredLeases().catch(() => {});
  await tick();

  // SIGTERM → 不再认领、等在跑的任务收尾（超时不管：租约过期后由下一个进程 sweep 重排）
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    clearInterval(tickTimer);
    clearInterval(sweepTimer);
    console.log(`[heavy-worker] ${signal}: draining ${running.size} running job(s), up to ${DRAIN_TIMEOUT_MS}ms`);
    server.close();
    if (listenClient) { try { await listenClient.query(`UNLISTEN ${queue.JOB_NEW_CHANNEL}`); } catch { /* ignore */ } listenClient.release(); }
    await Promise.race([
      Promise.allSettled([...running.values()].map((r) => r.promise)),
      new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
    ]);
    console.log(`[heavy-worker] drained, exiting (${running.size} left)`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[heavy-worker] fatal:", err);
  process.exit(1);
});
