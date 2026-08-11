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
  //
  // 刻意没有"查他人"工具：sessionKey 尚无 production 维度，跨成员查询
  // 没有权限语境，等 production 环境落地后再加。

  // ─── "我的 ×××" 只读工具（镜像 app/my/* 数据面，self-scoped）────────────
  // 与 my 页面共用同一批以 userId 收窄的查询函数，无新权限面；
  // readOnlyHint: true → 插件门控直通（Level A）。
  const CALLER_PARAM = {
    _caller_user_id: z.string().optional().describe("系统注入的调用者身份，勿手动填写"),
  };
  const NO_CALLER = {
    content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }],
  };
  const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

  const myTools: Array<{ name: string; description: string; fn: (userId: string) => Promise<string> }> = [
    {
      name: "my.call_times",
      description: "查询当前用户自己的近期通告（时间、事件、地点、所属制作）。",
      fn: async (uid) => (await import("./my-tools")).myCallTimes(uid),
    },
    {
      name: "my.tech_reqs",
      description: "查询与当前用户相关的技术需求（被指派或作为部门对接人），含状态。",
      fn: async (uid) => (await import("./my-tools")).myTechReqs(uid),
    },
    {
      name: "my.events",
      description: "查询当前用户关注的即将开始的活动。",
      fn: async (uid) => (await import("./my-tools")).myFollowedEvents(uid),
    },
    {
      name: "my.milestones",
      description: "查询当前用户可见项目的临近里程碑（截止日期）。",
      fn: async (uid) => (await import("./my-tools")).myMilestones(uid),
    },
    {
      name: "my.productions",
      description: "查询当前用户参与的全部制作与角色（含已归档）。",
      fn: async (uid) => (await import("./my-tools")).myProductions(uid),
    },
  ];
  for (const t of myTools) {
    s.registerTool(t.name, {
      description: t.description,
      inputSchema: { ...CALLER_PARAM },
      annotations: READ_ONLY,
    }, async ({ _caller_user_id }) => {
      if (!_caller_user_id) return NO_CALLER;
      return { content: [{ type: "text" as const, text: await t.fn(_caller_user_id) }] };
    });
  }

  s.registerTool("users.query_sensitive", {
    // 刻意不标 readOnlyHint: true —— 插件的 fail-closed 门控会因此把它
    // 当写工具挂确认门（"AI 想查询你的联系方式" → 用户批准/拒绝）。
    // 敏感信息即使目标是自己也要确认；确认语义纯靠 annotations 表达。
    description: "查询当前用户自己的登记联系方式（邮箱/电话）。敏感信息，需用户确认。",
    inputSchema: {
      _caller_user_id: z.string().optional().describe("系统注入的调用者身份，勿手动填写"),
    },
    annotations: { openWorldHint: false, destructiveHint: false },
  }, async ({ _caller_user_id }) => {
    if (!_caller_user_id) {
      return { content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }] };
    }
    const { querySelfSensitive } = await import("./user-context");
    return { content: [{ type: "text" as const, text: await querySelfSensitive(_caller_user_id) }] };
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
