export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMcpServer } = await import("./lib/mcp/server");
    startMcpServer();
    // 自建运行时（#367）在 next 进程内跑时：启动即接管上一进程留下的孤儿 run
    // （心跳过期），按中断点续跑——§4.4 ①。独立 agent-runner 进程上线后由它接管，
    // 这里对不存在孤儿的情况零开销。
    if (process.env.AGENT_RUNTIME && process.env.AGENT_RUNTIME !== "gateway") {
      const { resumeOrphans } = await import("./lib/agent-runtime/service");
      resumeOrphans()
        .then((n) => { if (n > 0) console.log(`[agent-runtime] resumed ${n} orphan run(s)`); })
        .catch((err) => console.error("[agent-runtime] resumeOrphans failed:", err));
    }
  }
}
