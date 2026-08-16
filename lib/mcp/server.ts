import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import http from "http";
import type { Request, Response } from "express";
import { WIKI_LINK_SYNTAX_NOTE } from "./wiki-link-syntax";

const rawPort = Number(process.env.MCP_PORT ?? 3101);
const MCP_PORT = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3101;

export function buildMcpServer(): McpServer {
  const s = new McpServer({ name: "clickin", version: "0.1.0" });

  // 所有 clickin 工具的 schema 都声明 caller 参数（插件对一切 clickin__*
  // 调用强制覆写注入；schema 不声明的话严格校验模式下会拒参）。
  // _tool_call_id 只有 wiki_propose 这类写工具需要（OpenClaw 网关层的
  // toolCallId，插件在 before_tool_call 里同款强制覆写注入，见插件文件
  // Level C 权限链注释）——放进共享 shape 图省事，读工具带着也无害。
  const callerShape = {
    _caller_user_id: z.string().optional().describe("系统注入的调用者身份，勿手动填写"),
    _caller_production_id: z.string().optional().describe("系统注入的制作语境，勿手动填写"),
    _tool_call_id: z.string().optional().describe("系统注入的调用 id，勿手动填写"),
  };

  s.registerTool("approvals.list", {
    description: "List pending approval requests for a production",
    inputSchema: {
      production_id: z.string().describe("Production ID"),
      ...callerShape,
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
  const NO_CALLER = {
    content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }],
  };
  const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

  // my.* 描述统一声明语义（用户定的原则）：个人查询跨全部制作、权限过滤
  // 内嵌（零权限 → 空结果而非拒绝）——在关联制作的会话里模型必须知道这些
  // 结果**不局限于当前项目**。
  const MY_SCOPE_NOTE = "【个人查询：范围是该用户参与的全部制作，不局限于当前对话关联的项目；结果已按其参与范围过滤，无权限时返回空结果而非拒绝】";

  const myTools: Array<{ name: string; description: string; fn: (userId: string) => Promise<string> }> = [
    {
      name: "my.call_times",
      description: `查询当前用户自己的近期Call（时间、事件、地点、所属制作）。${MY_SCOPE_NOTE}`,
      fn: async (uid) => (await import("./my-tools")).myCallTimes(uid),
    },
    {
      name: "my.tech_reqs",
      description: `查询与当前用户相关的技术需求/任务（被指派或作为部门负责人），含状态。${MY_SCOPE_NOTE}`,
      fn: async (uid) => (await import("./my-tools")).myTechReqs(uid),
    },
    {
      name: "my.events",
      description: `查询当前用户关注的即将开始的Event事件。${MY_SCOPE_NOTE}`,
      fn: async (uid) => (await import("./my-tools")).myFollowedEvents(uid),
    },
    {
      name: "my.milestones",
      description: `查询当前用户可见项目的临近里程碑（截止日期）。${MY_SCOPE_NOTE}`,
      fn: async (uid) => (await import("./my-tools")).myMilestones(uid),
    },
    {
      name: "my.productions",
      description: `查询当前用户参与的全部制作与角色（含已归档）。${MY_SCOPE_NOTE}`,
      fn: async (uid) => (await import("./my-tools")).myProductions(uid),
    },
  ];
  for (const t of myTools) {
    s.registerTool(t.name, {
      description: t.description,
      inputSchema: { ...callerShape },
      annotations: READ_ONLY,
    }, async ({ _caller_user_id }) => {
      if (!_caller_user_id) return NO_CALLER;
      return { content: [{ type: "text" as const, text: await t.fn(_caller_user_id) }] };
    });
  }

  // ─── production.* 项目工具（与 my.* 的语义分界）─────────────────────────
  // 权限门在前：非成员 → 明确"权限被拒绝"（不是空结果）；仅在关联制作的
  // 会话可用（_caller_production_id 由插件按 sessionKey 覆写，个人会话
  // 没有该字段）。本批四个工具的门 = 成员资格。
  const NO_PRODUCTION = {
    content: [{
      type: "text" as const,
      text: "该工具仅在关联制作的对话中可用。请让用户新建对话并选择关联制作，或改用 my.* 个人查询（跨全部制作）。",
    }],
  };

  const productionTools: Array<{ name: string; description: string; fn: (userId: string, productionId: string) => Promise<string> }> = [
    {
      name: "production.info",
      description: "查询当前对话关联制作的项目详情（简介、类型、所有者、制作人）。成员内公开信息。",
      fn: async (uid, pid) => (await import("./production-tools")).productionInfo(uid, pid),
    },
    {
      name: "production.my_role",
      description: "查询当前用户在当前对话关联制作中的职位、标签与部门（含是否部门负责人）。",
      fn: async (uid, pid) => (await import("./production-tools")).productionMyRole(uid, pid),
    },
    {
      name: "production.notifications",
      description: "查询当前用户在当前对话关联制作中的通知（未读/待办/警告）。",
      fn: async (uid, pid) => (await import("./production-tools")).productionNotifications(uid, pid),
    },
    {
      name: "production.milestones",
      description: "查询当前对话关联制作的全部里程碑（含已过与未来）。",
      fn: async (uid, pid) => (await import("./production-tools")).productionMilestones(uid, pid),
    },
  ];
  for (const t of productionTools) {
    s.registerTool(t.name, {
      description: t.description,
      inputSchema: { ...callerShape },
      annotations: READ_ONLY,
    }, async ({ _caller_user_id, _caller_production_id }) => {
      if (!_caller_user_id) return NO_CALLER;
      if (!_caller_production_id) return NO_PRODUCTION;
      return { content: [{ type: "text" as const, text: await t.fn(_caller_user_id, _caller_production_id) }] };
    });
  }

  // ─── wiki.* 项目工具（production.* 族的一部分）─────────────────────────
  // 四个只读工具签名各不相同（tree/search 少一个 id，backlinks/read 多一个
  // wikiId），塞不进上面那个 (userId, productionId) 单形状的循环——照抄
  // users.query_sensitive 的手写内联判断风格，各自独立注册。

  s.registerTool("production.wiki_tree", {
    description: "查询当前对话关联制作的文档树（wiki 库），只列出当前用户有权限看到的文档（id/标题/tag）。",
    inputSchema: { ...callerShape },
    annotations: READ_ONLY,
  }, async ({ _caller_user_id, _caller_production_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    const { wikiTree } = await import("./wiki-tools");
    return { content: [{ type: "text" as const, text: await wikiTree(_caller_user_id, _caller_production_id) }] };
  });

  s.registerTool("production.wiki_backlinks", {
    description: "查询一篇文档的双向链接：谁链接到它（backlinks）、它链接到谁（outgoing）。",
    inputSchema: { wikiId: z.string().describe("文档 id（来自 wiki_tree/wiki_search 的结果）"), ...callerShape },
    annotations: READ_ONLY,
  }, async ({ wikiId, _caller_user_id, _caller_production_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    const { wikiBacklinks } = await import("./wiki-tools");
    return { content: [{ type: "text" as const, text: await wikiBacklinks(_caller_user_id, _caller_production_id, wikiId) }] };
  });

  s.registerTool("production.wiki_read", {
    description: `按 id 读取一篇文档的完整内容（标题/标签/正文）。${WIKI_LINK_SYNTAX_NOTE}`,
    inputSchema: { wikiId: z.string().describe("文档 id（来自 wiki_tree/wiki_search 的结果）"), ...callerShape },
    annotations: READ_ONLY,
  }, async ({ wikiId, _caller_user_id, _caller_production_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    const { wikiRead } = await import("./wiki-tools");
    return { content: [{ type: "text" as const, text: await wikiRead(_caller_user_id, _caller_production_id, wikiId) }] };
  });

  s.registerTool("production.wiki_search", {
    description: "全文搜索当前对话关联制作的文档库（标题+正文），只返回当前用户有权限看到的结果。",
    inputSchema: { query: z.string().describe("搜索关键词"), ...callerShape },
    annotations: READ_ONLY,
  }, async ({ query, _caller_user_id, _caller_production_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    const { wikiSearch } = await import("./wiki-tools");
    return { content: [{ type: "text" as const, text: await wikiSearch(_caller_user_id, _caller_production_id, query) }] };
  });

  s.registerTool("production.wiki_propose", {
    // 非 readOnly → 插件门控挂确认门（工具调用权限门原则①：有权限键但敏感，
    // 聊天栏确认后执行）。工具函数内部再查一遍权限——没有权限键的调用点
    // （原则②）在这里被直接拦截，不建文档，交由前端的申请权限 modal 收尾。
    description: `在某篇文档下（或在根下）提议新建一篇子文档，需要人工在聊天栏确认；` +
      `确认后若你没有新建文档的权限，调用会被直接拦截并转入审批流。${WIKI_LINK_SYNTAX_NOTE}`,
    inputSchema: {
      parentId: z.string().optional().describe("父文档 id；留空则建在文档库根下"),
      title: z.string().describe("新文档标题"),
      body: z.string().optional().describe("新文档正文（Markdown）"),
      summary: z.string().describe("一句话说明这次提议改了什么、为什么"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ parentId, title, body, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) {
      return { content: [{ type: "text" as const, text: "拒绝：缺少调用 id（该工具只能经审批插件路径调用）。" }] };
    }
    const { wikiPropose } = await import("./wiki-tools");
    const text = await wikiPropose(_caller_user_id, _caller_production_id, _tool_call_id, { parentId, title, body, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  s.registerTool("users.query_sensitive", {
    // 刻意不标 readOnlyHint: true —— 插件的 fail-closed 门控会因此把它
    // 当写工具挂确认门（"AI 想查询你的联系方式" → 用户批准/拒绝）。
    // 敏感信息即使目标是自己也要确认；确认语义纯靠 annotations 表达。
    description: "查询当前用户自己的登记联系方式（邮箱/电话）。敏感信息，需用户确认。",
    inputSchema: { ...callerShape },
    annotations: { openWorldHint: false, destructiveHint: false },
  }, async ({ _caller_user_id }) => {
    if (!_caller_user_id) {
      return { content: [{ type: "text" as const, text: "拒绝：缺少调用者身份（该工具只能经审批插件路径调用）。" }] };
    }
    const { querySelfSensitive } = await import("./user-context");
    return { content: [{ type: "text" as const, text: await querySelfSensitive(_caller_user_id) }] };
  });

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

  // 注入内容组装端点（供 clickin-memory 插件 before_prompt_build 单次
  // fetch）：当前用户档案 + 长期记忆 + 近期对话，预算集中后端。
  // 仅 loopback，与 MCP 同信任域。
  app.get("/inject-context", async (req: Request, res: Response) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey : undefined;
    if (!userId) {
      res.status(400).json({ error: "missing userId" });
      return;
    }
    try {
      const { buildInjectContext } = await import("../agent-memory/inject");
      res.json({ markdown: await buildInjectContext(userId, sessionKey) });
    } catch (err) {
      console.error("[mcp] /inject-context error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  // episodic 上报端点（插件 agent_end 调用）——记忆文件所有权在后端
  // （插件进程写不进后端目录，也不该写），上报走 loopback HTTP。
  app.post("/memory-run", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { userId?: unknown; record?: unknown };
    const userId = typeof body.userId === "string" ? body.userId : "";
    const record = body.record as Record<string, unknown> | undefined;
    if (!userId || !record || typeof record !== "object") {
      res.status(400).json({ error: "missing userId/record" });
      return;
    }
    try {
      const { appendRunRecord } = await import("../agent-memory/store");
      appendRunRecord(userId, record as import("../agent-memory/store").RunRecord);
      res.json({ ok: true });
    } catch (err) {
      console.error("[mcp] /memory-run error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  // wiki propose 预持久化端点（供 clickin-memory 插件在 before_tool_call
  // 构建确认卡片之前调用，仅对 production.wiki_propose）：把完整提议内容
  // 落一行 wiki_proposal（确认卡片 description 硬上限 512 字符装不下全文，
  // 前端预览 modal 按 tool_call_id 拉取这行）。这里算出的 hasPermission
  // 只是给确认卡片/预览 modal 的展示值——真正的安全边界是
  // production.wiki_propose 工具函数批准后自己重新查一遍权限，不信任这行。
  app.post("/wiki-proposal", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      productionId?: unknown; toolCallId?: unknown; callerUserId?: unknown;
      parentId?: unknown; title?: unknown; body?: unknown; summary?: unknown;
    };
    const productionId = typeof body.productionId === "string" ? body.productionId : "";
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : "";
    const callerUserId = typeof body.callerUserId === "string" ? body.callerUserId : "";
    const title = typeof body.title === "string" ? body.title : "";
    if (!productionId || !toolCallId || !callerUserId || !title) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    const parentWikiId = typeof body.parentId === "string" ? body.parentId : null;
    const docBody = typeof body.body === "string" ? body.body : "";
    const summary = typeof body.summary === "string" ? body.summary : "";

    try {
      const { resolveProductionActor } = await import("./production-tools");
      const { CREATE_PERMISSION_KEY } = await import("./wiki-tools");
      const { hasEffectiveGrant } = await import("../grant-check");
      const { insertWikiProposal } = await import("../wiki-proposal-db");

      let hasPermission = false;
      let reason: "not_member" | "archived" | "no_grant" | null = null;
      const resolved = await resolveProductionActor(callerUserId, productionId);
      if (!resolved) {
        reason = "not_member";
      } else if (resolved.isArchived) {
        reason = "archived";
      } else {
        hasPermission = await hasEffectiveGrant(resolved.actor, productionId, "wiki", "*", "*", "create");
        if (!hasPermission) reason = "no_grant";
      }

      const proposal = await insertWikiProposal({
        productionId, toolCallId, proposedBy: callerUserId, parentWikiId,
        title, body: docBody, summary, hasPermission, permissionKey: CREATE_PERMISSION_KEY,
      });
      res.json({ id: proposal.id, hasPermission, reason });
    } catch (err) {
      console.error("[mcp] /wiki-proposal error:", err);
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
