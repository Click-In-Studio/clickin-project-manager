export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMcpServer } = await import("./lib/mcp/server");
    startMcpServer();
  }
}
