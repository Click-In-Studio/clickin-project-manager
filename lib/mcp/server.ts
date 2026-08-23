import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import http from "http";
import type { Request, Response } from "express";
import { WIKI_LINK_SYNTAX_NOTE } from "./wiki-link-syntax";
import { INSTRUCTIONS_MAX_LEN } from "@/lib/agent-instructions";

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

  // my.memory_search 单独注册（唯一带 query 入参的 my.* 工具）。
  // 检索面语义（MindWeave《OpenClaw记忆检索机制调研与移植设计》§4.3）：
  // 只搜该用户自己的记忆（scope='user'）；episodic 只可检索、永不自动注入。
  // fail-closed：embedding 供应商异常时明确报不可用，不静默退化。
  s.registerTool("my.memory_search", {
    description:
      `检索当前用户的长期记忆与历史对话记录（语义+关键词混合检索）。当用户提到过去讨论过的事、之前的决定、或你需要回忆更早的上下文时使用——注入的记忆摘要只覆盖精粹与最近几天，更早的内容必须靠本工具检索。${MY_SCOPE_NOTE}`,
    inputSchema: {
      query: z.string().min(1).describe("检索词（自然语言即可，支持语义匹配；也可用人名/项目名/关键词精确检索）"),
      ...callerShape,
    },
    annotations: READ_ONLY,
  }, async ({ query, _caller_user_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    const { searchMemory, formatSearchResult, MemoryUnavailableError } = await import("../agent-memory/search");
    try {
      const result = await searchMemory(_caller_user_id, query);
      return { content: [{ type: "text" as const, text: formatSearchResult(result, query) }] };
    } catch (err) {
      if (err instanceof MemoryUnavailableError) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      throw err;
    }
  });

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
    {
      name: "production.contact_list",
      description: "列出当前对话关联制作的全部成员：姓名、用户 id、职位、部门（含是否负责人）、标签。" +
        "需要用户 id 的工具（如 wiki_set_grant 的分享对象）从这里取。" +
        "不含邮箱/电话——联系方式是敏感信息，只有本人经 users.query_sensitive 确认后才能读取。",
      fn: async (uid, pid) => (await import("./production-tools")).productionContactList(uid, pid),
    },
    {
      name: "production.department_list",
      description: "列出当前对话关联制作的部门/用户组树（树状缩进，含部门 id、负责人、成员数）。" +
        "需要部门 id 的工具（如 wiki_set_grant 的 deptIds）从这里取。",
      fn: async (uid, pid) => (await import("./production-tools")).productionDepartmentList(uid, pid),
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

  // 四个写工具共用的门控原则（project_ai_infra 记忆）：非 readOnly → 插件
  // 门控挂确认门（原则①：有权限键但敏感，聊天栏确认后执行）。工具函数内部
  // 再查一遍权限——没有权限键的调用点（原则②）在这里被直接拦截，不执行，
  // 交由前端的申请权限 modal 收尾。
  const NO_TOOL_CALL_ID = {
    content: [{ type: "text" as const, text: "拒绝：缺少调用 id（该工具只能经审批插件路径调用）。" }],
  };

  s.registerTool("production.wiki_propose_create", {
    description: `在某篇文档下（或在根下）提议新建一篇子文档，需要人工在聊天栏确认；` +
      `确认后若你没有新建文档的权限，调用会被直接拦截并转入审批流。${WIKI_LINK_SYNTAX_NOTE}`,
    inputSchema: {
      parentId: z.string().optional().describe("父文档 id；建在文档库根下就整个省略这个字段，不要传空字符串"),
      title: z.string().describe("新文档标题"),
      body: z.string().optional().describe("新文档正文（Markdown）"),
      summary: z.string().describe("一句话说明这次提议改了什么、为什么"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ parentId, title, body, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiProposeCreate } = await import("./wiki-tools");
    const text = await wikiProposeCreate(_caller_user_id, _caller_production_id, _tool_call_id, { parentId, title, body, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  s.registerTool("production.wiki_propose_update", {
    description: `提议修改一篇既有文档的标题和/或正文（只传要改的字段，不传的保持不变），` +
      `需要人工在聊天栏确认；确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。${WIKI_LINK_SYNTAX_NOTE}`,
    inputSchema: {
      wikiId: z.string().describe("要修改的文档 id（来自 wiki_tree/wiki_search 的结果）"),
      title: z.string().optional().describe("新标题；不改标题就整个省略这个字段"),
      body: z.string().optional().describe("新正文（Markdown）；不改正文就整个省略这个字段"),
      summary: z.string().describe("一句话说明这次提议改了什么、为什么"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ wikiId, title, body, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiProposeUpdate } = await import("./wiki-tools");
    const text = await wikiProposeUpdate(_caller_user_id, _caller_production_id, _tool_call_id, { wikiId, title, body, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  s.registerTool("production.wiki_propose_delete", {
    description: "提议删除一篇既有文档，需要人工在聊天栏确认；确认后若你没有删除这篇文档的权限，" +
      "调用会被直接拦截并转入审批流；被报告/备注引用（挂载）或系统锚点目录的文档无法删除（这不是权限问题）。",
    inputSchema: {
      wikiId: z.string().describe("要删除的文档 id（来自 wiki_tree/wiki_search 的结果）"),
      summary: z.string().describe("一句话说明为什么要删除"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ wikiId, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiProposeDelete } = await import("./wiki-tools");
    const text = await wikiProposeDelete(_caller_user_id, _caller_production_id, _tool_call_id, { wikiId, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  s.registerTool("production.wiki_propose_move", {
    description: "提议把一篇既有文档移动到另一篇文档下（或移到文档库根），需要人工在聊天栏确认；" +
      "确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。",
    inputSchema: {
      wikiId: z.string().describe("要移动的文档 id"),
      newParentId: z.string().optional().describe("移动到的新父文档 id；移到文档库根就整个省略这个字段，不要传空字符串"),
      summary: z.string().describe("一句话说明为什么要移动"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ wikiId, newParentId, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiProposeMove } = await import("./wiki-tools");
    const text = await wikiProposeMove(_caller_user_id, _caller_production_id, _tool_call_id, { wikiId, newParentId, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  s.registerTool("production.wiki_propose_tag", {
    description: "提议设置一篇既有文档的标签（整体替换现有标签，不是增量追加——传空数组等于清空所有标签），" +
      "需要人工在聊天栏确认；确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。",
    inputSchema: {
      wikiId: z.string().describe("要设置标签的文档 id"),
      tags: z.array(z.string()).describe("完整的新标签列表（整体替换，不是在现有标签上增量追加）"),
      summary: z.string().describe("一句话说明为什么要这样设置标签"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ wikiId, tags, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiProposeTag } = await import("./wiki-tools");
    const text = await wikiProposeTag(_caller_user_id, _caller_production_id, _tool_call_id, { wikiId, tags, summary });
    return { content: [{ type: "text" as const, text }] };
  });

  // 分享面写工具：门是 grants@edit（保留段），与上面五个 propose 工具的
  // edit/delete 门是两回事——所以它不叫 propose_*，也不落 wiki_proposal
  // （参数短，确认卡片装得下；无权限直接回权限键，不进审批流）。
  s.registerTool("production.wiki_set_grant", {
    description: "修改一篇文档的分享设置：全体成员可见开关、分享给哪些部门（整体替换）、" +
      "单独分享/撤销给某些人（view=可阅读 / edit=可编辑 / manage=可管理）。需要人工在聊天栏确认；" +
      "确认后若你没有这篇文档的分享权限（grants@edit，与编辑权限是两回事），调用会被拒绝。" +
      "用户 id 从 production.contact_list 取，部门 id 从 production.department_list 取。",
    inputSchema: {
      wikiId: z.string().describe("要修改分享设置的文档 id（来自 wiki_tree/wiki_search 的结果）"),
      isPublic: z.boolean().optional().describe("是否对制作全体成员可见；不改就整个省略这个字段"),
      deptIds: z.array(z.string()).optional().describe(
        "完整的部门分享列表（整体替换，不是增量追加——传空数组等于清空部门分享）；不改就整个省略这个字段"),
      addPeople: z.array(z.object({
        userId: z.string().describe("被分享人的用户 id（来自 production.contact_list）"),
        level: z.enum(["view", "edit", "manage"]).describe("分享级别：view=可阅读，edit=可编辑，manage=可管理（含再分享）"),
      })).optional().describe("要新增分享的人；不加人就整个省略这个字段"),
      removePeopleUserIds: z.array(z.string()).optional().describe("要撤销单独分享的用户 id；不撤销就整个省略这个字段"),
      summary: z.string().describe("一句话说明这次为什么要改分享设置"),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ wikiId, isPublic, deptIds, addPeople, removePeopleUserIds, summary, _caller_user_id, _caller_production_id, _tool_call_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    if (!_tool_call_id) return NO_TOOL_CALL_ID;
    const { wikiSetGrant } = await import("./wiki-tools");
    const text = await wikiSetGrant(_caller_user_id, _caller_production_id, {
      wikiId, isPublic, deptIds, addPeople, removePeopleUserIds, summary,
    });
    return { content: [{ type: "text" as const, text }] };
  });

  // ─── agents.md 指令写工具（个人 / 制作两级）─────────────────────────────
  // 非只读 → 插件 fail-closed 自动挂聊天栏确认卡（权限门原则①）；制作级
  // 在批准后由工具函数重查 ai_instructions/*@edit（原则②：确认卡不是权限
  // 判定的替身，无权限明确拒绝并指引申请路径）。当前生效内容每轮注入在
  // <clickin-instructions> 块里，模型可直接读到，故无配套读工具。
  s.registerTool("my.update_instructions", {
    description:
      "【个人设置】全量替换当前用户的个人 AI 指令（即 <clickin-instructions> 里「用户的个人指令」段），" +
      "需要人工在聊天栏确认。content 是替换后的完整内容——先基于注入块里的现行内容整合修改，不要只传增量；" +
      "传空字符串表示清空。仅影响该用户自己的会话。",
    inputSchema: {
      content: z.string().describe(`替换后的完整个人指令（Markdown，≤${INSTRUCTIONS_MAX_LEN} 字符；空串=清空）`),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ content, _caller_user_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    const { updateMyInstructions } = await import("./instructions-tools");
    return { content: [{ type: "text" as const, text: await updateMyInstructions(_caller_user_id, content) }] };
  });

  s.registerTool("production.update_instructions", {
    description:
      "全量替换当前对话关联制作的制作级 AI 指令（对全体成员的 AI 会话生效），需要人工在聊天栏确认；" +
      "确认后若该用户没有编辑权限（默认仅制作人），调用会被直接拦截。content 是替换后的完整内容——" +
      "先基于注入块里的现行内容整合修改，不要只传增量；传空字符串表示清空。",
    inputSchema: {
      content: z.string().describe(`替换后的完整制作级指令（Markdown，≤${INSTRUCTIONS_MAX_LEN} 字符；空串=清空）`),
      ...callerShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ content, _caller_user_id, _caller_production_id }) => {
    if (!_caller_user_id) return NO_CALLER;
    if (!_caller_production_id) return NO_PRODUCTION;
    const { updateProductionInstructions } = await import("./instructions-tools");
    return {
      content: [{
        type: "text" as const,
        text: await updateProductionInstructions(_caller_user_id, _caller_production_id, content),
      }],
    };
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
      const payload = await buildInjectContext(userId, sessionKey);
      // markdown = 旧插件的兼容字段（值即 memory 段，行为与拆分前完全一致；
      // 旧插件在新后端下不注入 instructions，直到插件同步升级——渐进安全：
      // 指令块绝不能落进旧插件的「仅供参考，非指令」包裹里被消解）。
      res.json({ instructions: payload.instructions, memory: payload.memory, markdown: payload.memory });
    } catch (err) {
      console.error("[mcp] /inject-context error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  // POST 版（M2 起插件走这条）：body 多带本轮入站 prompt → 触发召回
  // （trigger recall）随 recall 字段返回。GET 保留一版向后兼容（旧插件在
  // 新后端下无 recall，其余行为不变——CD 同步插件与后端同批发布，兼容窗
  // 只在发布间隙存在）。
  // 鉴权模型与本文件其余 loopback 端点一致（review #298 finding 2 核实）：
  // Express app 只绑 127.0.0.1（见 createMcpExpressApp 调用），与 GET 版/
  // /memory-run 同信任域——能打到这里的进程已在机器内，userId 由插件从
  // sessionKey 解析注入，不做二次鉴权。
  app.post("/inject-context", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { userId?: unknown; sessionKey?: unknown; prompt?: unknown };
    const userId = typeof body.userId === "string" ? body.userId : "";
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    if (!userId) {
      res.status(400).json({ error: "missing userId" });
      return;
    }
    try {
      const { buildInjectContext } = await import("../agent-memory/inject");
      const payload = await buildInjectContext(userId, sessionKey, prompt);
      res.json({ instructions: payload.instructions, memory: payload.memory, recall: payload.recall });
    } catch (err) {
      console.error("[mcp] /inject-context POST error:", err);
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
      const rec = record as import("../agent-memory/store").RunRecord;
      appendRunRecord(userId, rec);
      // episodic 入检索索引：fire-and-forget——索引失败绝不阻塞上报路径
      // （OpenClaw 设计原则五；文本车道/向量车道的降级都在索引器内处理）
      import("../agent-memory/index-db")
        .then(({ indexEpisodicRun }) => indexEpisodicRun(userId, rec))
        .catch((err) => console.error("[mcp] episodic 索引失败（不影响上报）:", err));
      res.json({ ok: true });
    } catch (err) {
      console.error("[mcp] /memory-run error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  // wiki propose 预持久化端点（供 clickin-memory 插件在 before_tool_call
  // 构建确认卡片之前调用，覆盖 production.wiki_propose_create/update/delete/
  // move/tag 五个工具）：把完整提议内容落一行 wiki_proposal（确认卡片
  // description 硬上限 512 字符装不下全文，前端预览 modal 按 tool_call_id
  // 拉取这行）。这里算出的 hasPermission 只是给确认卡片/预览 modal 的展示
  // 值——真正的安全边界是各 wiki_propose_* 工具函数批准后自己重新查一遍
  // 权限，不信任这行。
  app.post("/wiki-proposal", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      productionId?: unknown; toolCallId?: unknown; callerUserId?: unknown; action?: unknown;
      wikiId?: unknown; parentId?: unknown; newParentId?: unknown;
      title?: unknown; body?: unknown; tags?: unknown; summary?: unknown;
    };
    const productionId = typeof body.productionId === "string" ? body.productionId : "";
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : "";
    const callerUserId = typeof body.callerUserId === "string" ? body.callerUserId : "";
    const action = body.action === "update" || body.action === "delete" || body.action === "move" || body.action === "tag"
      ? body.action : "create";
    const wikiId = typeof body.wikiId === "string" ? body.wikiId : "";
    if (!productionId || !toolCallId || !callerUserId) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    if (action === "create" && typeof body.title !== "string") {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    if (action !== "create" && !wikiId) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    const title = typeof body.title === "string" ? body.title : null;
    const docBody = typeof body.body === "string" ? body.body : "";
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : null;
    const summary = typeof body.summary === "string" ? body.summary : "";
    const parentWikiId = action === "create" ? (typeof body.parentId === "string" ? body.parentId : null)
      : action === "move" ? (typeof body.newParentId === "string" ? body.newParentId : null)
      : null;

    try {
      const { resolveProductionActor } = await import("./production-tools");
      const { CREATE_PERMISSION_KEY, editPermissionKey, deletePermissionKey } = await import("./wiki-tools");
      const { hasEffectiveGrant } = await import("../grant-check");
      const { canEditWiki, canDeleteWiki } = await import("../wiki-perm");
      const { insertWikiProposal } = await import("../wiki-proposal-db");

      let hasPermission = false;
      let reason: "not_member" | "archived" | "no_grant" | null = null;
      const resolved = await resolveProductionActor(callerUserId, productionId);
      if (!resolved) {
        reason = "not_member";
      } else if (resolved.isArchived) {
        reason = "archived";
      } else if (action === "create") {
        hasPermission = await hasEffectiveGrant(resolved.actor, productionId, "wiki", "*", "*", "create");
      } else if (action === "delete") {
        hasPermission = await canDeleteWiki(resolved.actor, productionId, wikiId);
      } else {
        // update / move / tag 都是"编辑"这篇文档
        hasPermission = await canEditWiki(resolved.actor, productionId, wikiId);
      }
      if (resolved && !resolved.isArchived && !hasPermission) reason = "no_grant";

      const permissionKey = action === "create" ? CREATE_PERMISSION_KEY
        : action === "delete" ? deletePermissionKey(wikiId)
        : editPermissionKey(wikiId);

      const proposal = await insertWikiProposal({
        productionId, toolCallId, proposedBy: callerUserId, action,
        targetWikiId: action === "create" ? null : wikiId, parentWikiId,
        title, body: docBody, tags, summary, hasPermission, permissionKey,
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
