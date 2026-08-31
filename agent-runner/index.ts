// agent-runner：自建 AI 运行时的独立进程（#367 §3 / §4.2 / §4.4）。
//
// 只做三件事：接 run（loopback HTTP）、跑 run（lib/agent-runtime/service）、活着（心跳、
// 孤儿接管、排水）。事件经 agent_event + pg_notify 分发，浏览器的 SSE 由 next 端点服务，
// 本进程不直接面对任何客户端——所以它可以随时重启（§4.4：先排水，超时才断）。
//
// 启动：
//   npx tsx agent-runner/index.ts                      # 本地（读 .env.local）
//   pm2 start agent-runner/index.ts --interpreter tsx  # 或 esbuild 打包后 node 跑（见 docs）
// 环境：AGENT_RUNNER_PORT（默认 3102）、AGENT_DRAIN_TIMEOUT_MS（默认 10 分钟）、
//       DEEPSEEK_API_KEY、PG*（与 next 同一份 .env.local）

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

for (const line of fs.existsSync(".env.local") ? fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n") : []) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PORT = Number(process.env.AGENT_RUNNER_PORT ?? 3102);
const DRAIN_TIMEOUT_MS = Number(process.env.AGENT_DRAIN_TIMEOUT_MS ?? 600_000);
const ORPHAN_SCAN_MS = Number(process.env.AGENT_ORPHAN_SCAN_MS ?? 30_000);

async function main() {
  const service = await import("../lib/agent-runtime/service");
  const { RUNNER_OWNER } = await import("../lib/agent-runtime/config");

  let draining = false;

  const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (c) => { buf += c; if (buf.length > 1_000_000) reject(new Error("body too large")); });
      req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true, owner: RUNNER_OWNER, active: service.__internal.active.size, draining });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      if (draining) return send(res, 503, { error: "runner draining" }); // §4.4 ②：排水期不接新 run
      const body = await readJson(req);
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
      if (req.url === "/runs") {
        const sessionId = str("sessionId"); const userId = str("userId"); const message = str("message");
        if (!sessionId || !userId || !message) return send(res, 400, { error: "missing fields" });
        const r = await service.startRun({ sessionId, userId, message, pageKey: str("pageKey") ?? null });
        return send(res, 200, r);
      }
      if (req.url === "/runs/steer") {
        const sessionId = str("sessionId"); const message = str("message");
        if (!sessionId || !message) return send(res, 400, { error: "missing fields" });
        const r = await service.steerRun(sessionId, message);
        return send(res, 200, { runId: r?.runId ?? null });
      }
      if (req.url === "/runs/abort") {
        const sessionId = str("sessionId");
        if (!sessionId) return send(res, 400, { error: "missing fields" });
        return send(res, 200, { aborted: await service.abortRun(sessionId) });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const status = (err as { status?: number })?.status ?? 500;
      return send(res, status, { error: err instanceof Error ? err.message : "internal error" });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[agent-runner] ${RUNNER_OWNER} listening on 127.0.0.1:${PORT}`);
    if (process.send) process.send("ready"); // pm2 wait_ready
  });

  // 启动接管孤儿 + 定时巡检（别的 runner 死了由活着的接）
  const scan = async () => {
    try {
      const n = await service.resumeOrphans();
      if (n > 0) console.log(`[agent-runner] resumed ${n} orphan run(s)`);
    } catch (err) {
      console.error("[agent-runner] orphan scan failed:", err);
    }
  };
  await scan();
  const scanTimer = setInterval(scan, ORPHAN_SCAN_MS);

  // 定时任务节拍（lib/agent-runtime/schedules.ts）：认领到期任务 → 以创建者身份开新会话跑 run。
  // 排水期不认领（认领了没人跑，租约到期前别的进程也接不了）。
  const { tickSchedules, SCHEDULE_TICK_MS } = await import("../lib/agent-runtime/schedules");
  const tick = async () => {
    if (draining) return;
    try {
      const n = await tickSchedules(service.startRun);
      if (n > 0) console.log(`[agent-runner] fired ${n} scheduled task(s)`);
    } catch (err) {
      console.error("[agent-runner] schedule tick failed:", err);
    }
  };
  const tickTimer = setInterval(tick, SCHEDULE_TICK_MS);

  // §4.4 ②：SIGTERM → 不接新 run、等进行中的到自然停点、超时才退（超时的由下一个进程按 ① 恢复）
  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    clearInterval(scanTimer);
    clearInterval(tickTimer);
    console.log(`[agent-runner] ${signal}: draining ${service.__internal.active.size} active run(s), up to ${DRAIN_TIMEOUT_MS}ms`);
    server.close();
    await service.drain(DRAIN_TIMEOUT_MS);
    console.log(`[agent-runner] drained, exiting (${service.__internal.active.size} left)`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[agent-runner] fatal:", err);
  process.exit(1);
});
