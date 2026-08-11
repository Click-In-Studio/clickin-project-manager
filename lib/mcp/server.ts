import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import http from "http";
import type { Request, Response } from "express";

const rawPort = Number(process.env.MCP_PORT ?? 3101);
const MCP_PORT = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3101;

export function buildMcpServer(): McpServer {
  const s = new McpServer({ name: "clickin", version: "0.1.0" });

  s.registerTool("docs.read", {
    description: "Read a vault document by path",
    inputSchema: { path: z.string().describe("Vault-relative document path") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => ({
    content: [{ type: "text" as const, text: `[stub] docs.read → ${path}` }],
  }));

  s.registerTool("approvals.list", {
    description: "List pending approval requests for a production",
    inputSchema: {
      production_id: z.string().describe("Production ID"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ production_id }) => ({
    content: [{ type: "text" as const, text: `[stub] approvals.list → production_id=${production_id}` }],
  }));

  // ─── 用户信息工具（Phase 5 首批真实工具）───────────────────────────────
  // _caller_user_id 由 clickin-memory 插件在 before_tool_call 里按
  // sessionKey 强制覆写（模型填什么都会被盖掉）——工具只信这个字段；
  // 缺失（未经插件的调用路径）一律拒绝。

  s.registerTool("users.query", {
    description: "按姓名查询可见成员的基础信息（角色、参与制作）。可见范围：调用者参与的制作的成员。",
    inputSchema: {
      query: z.string().describe("姓名（支持部分匹配）"),
      _caller_user_id: z.string().optional().describe("系统注入的调用者身份，勿手动填写"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, _caller_user_id }) => {
    if (!_caller_user_id) {
      return { content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }] };
    }
    const { queryUsers } = await import("./user-context");
    return { content: [{ type: "text" as const, text: await queryUsers(_caller_user_id, query) }] };
  });

  s.registerTool("users.query_sensitive", {
    // 刻意不标 readOnlyHint: true —— 插件的 fail-closed 门控会因此把它
    // 当写工具挂确认门（"AI 想查询 X 的联系方式" → 用户批准/拒绝），
    // 敏感读取的确认语义纯靠 annotations 表达，零插件改动。
    description: "查询某位成员的联系方式（邮箱/电话）。敏感信息，需用户确认。",
    inputSchema: {
      name: z.string().describe("目标成员姓名"),
      _caller_user_id: z.string().optional().describe("系统注入的调用者身份，勿手动填写"),
    },
    annotations: { openWorldHint: false, destructiveHint: false },
  }, async ({ name, _caller_user_id }) => {
    if (!_caller_user_id) {
      return { content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }] };
    }
    const { queryUserSensitive } = await import("./user-context");
    return { content: [{ type: "text" as const, text: await queryUserSensitive(_caller_user_id, name) }] };
  });

  s.registerTool("docs.propose", {
    // TODO(Phase 5): add shared-secret header check before touching real data
    description: "Propose a document change — requires human approval before taking effect",
    inputSchema: {
      path: z.string().describe("Vault-relative document path"),
      content: z.string().describe("Proposed full new content"),
      summary: z.string().describe("Short description of what changed and why"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ path, summary }) => ({
    content: [{ type: "text" as const, text: `[stub] docs.propose → path=${path} | "${summary}" — proposal queued` }],
  }));

  return s;
}

const g = global as typeof globalThis & { __mcpHttpServer?: http.Server };

export function startMcpServer(): void {
  if (g.__mcpHttpServer) return;

  const app = createMcpExpressApp({ host: "127.0.0.1" });

  // 拒绝理由取件端点（供 clickin-memory 插件在 tool_result_persist 里调用，
  // 把理由重写进被拒工具结果）。仅绑定 loopback，与 MCP 本体同信任域，
  // 无需额外鉴权；一次性取走（takeDenyReason 取后即删）。
  app.get("/deny-reason", async (req: Request, res: Response) => {
    const toolCallId = typeof req.query.toolCallId === "string" ? req.query.toolCallId : "";
    if (!toolCallId) {
      res.status(400).json({ error: "missing toolCallId" });
      return;
    }
    // 动态 import：不把 gateway-client 依赖树拉进 MCP 模块的静态依赖图
    // （本仓库有过 Turbopack 循环依赖 TDZ 前科，静态图保持最小）；
    // Node 模块缓存保证首次之后零开销。
    const { takeDenyReason } = await import("../agent-gateway/client");
    res.json({ reason: takeDenyReason(toolCallId) ?? null });
  });

  // 用户上下文端点（供 clickin-memory 插件在 before_prompt_build 注入
  // "当前用户"档案）。仅 loopback，与 MCP 同信任域。
  app.get("/user-context", async (req: Request, res: Response) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    if (!userId) {
      res.status(400).json({ error: "missing userId" });
      return;
    }
    try {
      const { buildUserContextMarkdown } = await import("./user-context");
      res.json({ markdown: await buildUserContextMarkdown(userId) });
    } catch (err) {
      console.error("[mcp] /user-context error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    } finally {
      await server.close().catch(() => {});
    }
  });

  const httpServer = http.createServer(app);
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    // EADDRINUSE on hot-reload is expected; log and continue rather than crashing Next.js
    console.error(`[mcp] server error (port ${MCP_PORT}):`, err.message);
  });
  httpServer.listen(MCP_PORT, "127.0.0.1", () => {
    console.log(`[mcp] listening on 127.0.0.1:${MCP_PORT}/mcp`);
  });
  g.__mcpHttpServer = httpServer;
}
