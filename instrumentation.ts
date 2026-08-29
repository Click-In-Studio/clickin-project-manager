export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMcpServer } = await import("./lib/mcp/server");
    startMcpServer();
    // 自建运行时（#367）在 next 进程内跑时：启动即接管上一进程留下的孤儿 run
    // （心跳过期），按中断点续跑——§4.4 ①。配了 AGENT_RUNNER_URL（独立 agent-runner
    // 进程）时由它接管，next 这边绝不能抢——否则 run 会在 next 进程里执行。
    if (!process.env.AGENT_RUNNER_URL) {
      const { resumeOrphans } = await import("./lib/agent-runtime/service");
      resumeOrphans()
        .then((n) => { if (n > 0) console.log(`[agent-runtime] resumed ${n} orphan run(s)`); })
        .catch((err) => console.error("[agent-runtime] resumeOrphans failed:", err));
    }
  }
}
