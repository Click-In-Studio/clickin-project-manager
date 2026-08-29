// 进程内工具注册表（#367 S2）：26 个业务工具从 MCP handler 变成直接调用。
//
// 与 lib/mcp/server.ts 的对应关系：同一批底层函数（my-tools / production-tools /
// wiki-tools / instructions-tools / user-context），同一份描述文案；差别只在包装——
// 身份（userId / productionId）来自构造时的闭包，**模型参数里不存在身份字段**
// （§5-1 安全不变量，tests/agent-runtime-tools.test.ts 静态扫描钉死）。
//
// 工具名沿用网关暴露名 clickin__<族>-<名>（"." → "-"）：lib/agent-tool-labels.ts 的
// 显示名、TOOLS.md 的措辞、前端气泡全部原样可用——前端零改动的一部分。
//
// readOnly = 网关时代的 readOnlyHint：决定要不要过确认门，以及中断后能否盲重跑
// （lib/agent-runtime/resume.ts）。users.query_sensitive 刻意 readOnly=false（敏感读取
// 也过确认门，与 server.ts 注释同理）。

import { Type, type TSchema } from "typebox";
import type { AgentToolResult } from "../../vendor/openclaw/packages/agent-core/src/types";
import { INSTRUCTIONS_MAX_LEN } from "@/lib/agent-instructions";
import { WIKI_DIALECT_POINTER_WRITE, WIKI_DIALECT_POINTER_READ, WIKI_LINK_SYNTAX_NOTE, WIKI_DIALECT_NOTE } from "@/lib/mcp/wiki-link-syntax";
import { toolLabel } from "@/lib/agent-tool-labels";
import type { StreamLine, QuestionItem } from "@/lib/agent-gateway/stream-reducer";
import type { RuntimeTool } from "./resume";

export const TOOL_PREFIX = "clickin__";

export interface ToolContext {
  userId: string;
  productionId: string | null;
  /** 本轮 run 的句柄（ask_user 这类要与前端交互的工具用）；离线恢复/单测可缺席 */
  run?: RunHandle;
}

export interface RunHandle {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  publish: (line: StreamLine) => void;
  /** run 状态切换（awaiting_answer ↔ running） */
  setStatus: (status: "running" | "awaiting_answer") => Promise<void>;
  /** 本进程是否已脱离（排水）：等待中的工具据此不再碰表、不发事件 */
  isDetached: () => boolean;
}

/** 写工具成功后的变更信号（前端 lib/agent-mutations.ts 派发给页面订阅者决定怎么刷） */
export interface ToolMutation {
  scope: string;
  action: "created" | "updated" | "deleted";
  ids?: string[];
}

/** 注册表条目：RuntimeTool + MCP 原始名（tool-catalog / 显示名 / 卡片文案按它索引）。 */
export interface RuntimeToolDef extends RuntimeTool {
  mcpName: string;
  /** 写工具声明：成功执行后产生了什么变更（读工具不声明） */
  mutates?: (args: Record<string, unknown>) => ToolMutation | null;
}

const text = (t: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: t }], details: undefined });

const NO_PRODUCTION =
  "该工具仅在关联制作的对话中可用。请让用户新建对话并选择关联制作，或改用 my.* 个人查询（跨全部制作）。";

const MY_SCOPE_NOTE =
  "【个人查询：范围是该用户参与的全部制作，不局限于当前对话关联的项目；结果已按其参与范围过滤，无权限时返回空结果而非拒绝】";

export function exposedName(mcpName: string): string {
  return TOOL_PREFIX + mcpName.replace(/[^A-Za-z0-9_-]/g, "-");
}
export function bareName(exposed: string): string {
  return exposed.startsWith(TOOL_PREFIX) ? exposed.slice(TOOL_PREFIX.length) : exposed;
}

type Def = {
  mcpName: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
  /** production 工具在个人会话里拒绝（与 server.ts 的 NO_PRODUCTION 同款） */
  needsProduction?: boolean;
  execute: (ctx: ToolContext & { productionId: string }, args: Record<string, unknown>, toolCallId: string) => Promise<string>;
  /** 结果判定为"错误"（isError）而非正常文本——ask_user 取消/过期用 */
  isErrorResult?: (out: string) => boolean;
  /** 写工具：成功后产生的变更（service 据此往 agent SSE 发 mutation 行） */
  mutates?: (args: Record<string, unknown>) => ToolMutation | null;
};

const wikiIdOf = (args: Record<string, unknown>): string[] => (typeof args.wikiId === "string" && args.wikiId ? [args.wikiId] : []);
const WIKI_MUTATES = {
  created: (): ToolMutation => ({ scope: "wiki", action: "created" }),
  updated: (args: Record<string, unknown>): ToolMutation => ({ scope: "wiki", action: "updated", ids: wikiIdOf(args) }),
  deleted: (args: Record<string, unknown>): ToolMutation => ({ scope: "wiki", action: "deleted", ids: wikiIdOf(args) }),
};

const NONE = Type.Object({});

function myTool(mcpName: string, description: string, fn: (uid: string) => Promise<string>): Def {
  return { mcpName, description: `${description}${MY_SCOPE_NOTE}`, parameters: NONE, readOnly: true, execute: (ctx) => fn(ctx.userId) };
}
function prodTool(mcpName: string, description: string, fn: (uid: string, pid: string) => Promise<string>): Def {
  return { mcpName, description, parameters: NONE, readOnly: true, needsProduction: true, execute: (ctx) => fn(ctx.userId, ctx.productionId) };
}

const WIKI_ID = Type.String({ description: "文档 id（来自 wiki_tree/wiki_search 的结果）" });

const DEFS: Def[] = [
  // ── my.* ────────────────────────────────────────────────────────────────
  myTool("my.call_times", "查询当前用户自己的近期Call（时间、事件、地点、所属制作）（EN: my call times schedule）。",
    async (uid) => (await import("@/lib/mcp/my-tools")).myCallTimes(uid)),
  myTool("my.tech_reqs", "查询与当前用户相关的技术需求/任务（被指派或作为部门负责人），含状态（EN: my tech requirements tasks）。",
    async (uid) => (await import("@/lib/mcp/my-tools")).myTechReqs(uid)),
  myTool("my.events", "查询当前用户关注的即将开始的Event事件。",
    async (uid) => (await import("@/lib/mcp/my-tools")).myFollowedEvents(uid)),
  myTool("my.milestones", "查询当前用户可见项目的临近里程碑（截止日期）。",
    async (uid) => (await import("@/lib/mcp/my-tools")).myMilestones(uid)),
  myTool("my.productions", "查询当前用户参与的全部制作与角色（含已归档）。",
    async (uid) => (await import("@/lib/mcp/my-tools")).myProductions(uid)),
  {
    mcpName: "my.memory_search",
    description: `检索当前用户的长期记忆与历史对话记录（语义+关键词混合检索）。当用户提到过去讨论过的事、之前的决定、或你需要回忆更早的上下文时使用——注入的记忆摘要只覆盖精粹与最近几天，更早的内容必须靠本工具检索。${MY_SCOPE_NOTE}`,
    parameters: Type.Object({ query: Type.String({ minLength: 1, description: "检索词（自然语言即可，支持语义匹配；也可用人名/项目名/关键词精确检索）" }) }),
    readOnly: true,
    execute: async (ctx, args) => {
      const { searchMemory, formatSearchResult, MemoryUnavailableError } = await import("@/lib/agent-memory/search");
      try {
        const query = String(args.query);
        return formatSearchResult(await searchMemory(ctx.userId, query), query);
      } catch (err) {
        if (err instanceof MemoryUnavailableError) return err.message;
        throw err;
      }
    },
  },
  {
    mcpName: "my.update_instructions",
    description: "【个人设置】全量替换当前用户的个人 AI 指令（即 <clickin-instructions> 里「用户的个人指令」段），需要人工在聊天栏确认。content 是替换后的完整内容——先基于注入块里的现行内容整合修改，不要只传增量；传空字符串表示清空。仅影响该用户自己的会话。",
    parameters: Type.Object({ content: Type.String({ description: `替换后的完整个人指令（Markdown，≤${INSTRUCTIONS_MAX_LEN} 字符；空串=清空）` }) }),
    readOnly: false,
    mutates: () => ({ scope: "instructions", action: "updated" }),
    execute: async (ctx, args) => (await import("@/lib/mcp/instructions-tools")).updateMyInstructions(ctx.userId, String(args.content)),
  },
  {
    mcpName: "users.query_sensitive",
    description: "查询当前用户自己的登记联系方式（邮箱/电话）（EN: my contact email phone）。敏感信息，需用户确认。",
    parameters: NONE,
    readOnly: false, // 敏感读取也过确认门
    execute: async (ctx) => (await import("@/lib/mcp/user-context")).querySelfSensitive(ctx.userId),
  },

  // ── production.* ────────────────────────────────────────────────────────
  prodTool("production.info", "查询当前对话关联制作的项目详情（简介、类型、所有者、制作人）。成员内公开信息。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionInfo(uid, pid)),
  prodTool("production.my_role", "查询当前用户在当前对话关联制作中的职位、标签与部门（含是否部门负责人）。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionMyRole(uid, pid)),
  prodTool("production.notifications", "查询当前用户在当前对话关联制作中的通知（未读/待办/警告）。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionNotifications(uid, pid)),
  prodTool("production.milestones", "查询当前对话关联制作的全部里程碑（含已过与未来）。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionMilestones(uid, pid)),
  prodTool("production.contact_list",
    "列出当前对话关联制作的全部成员：姓名、用户 id、职位、部门（含是否负责人）、标签。需要用户 id 的工具（如 wiki_set_grant 的分享对象）从这里取。不含邮箱/电话——联系方式是敏感信息，只有本人经 users.query_sensitive 确认后才能读取。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionContactList(uid, pid)),
  prodTool("production.department_list",
    "列出当前对话关联制作的部门/用户组树（树状缩进，含部门 id、负责人、成员数）。需要部门 id 的工具（如 wiki_set_grant 的 deptIds）从这里取。",
    async (uid, pid) => (await import("@/lib/mcp/production-tools")).productionDepartmentList(uid, pid)),
  {
    mcpName: "production.update_instructions",
    description: "全量替换当前对话关联制作的制作级 AI 指令（对全体成员的 AI 会话生效），需要人工在聊天栏确认；确认后若该用户没有编辑权限（默认仅制作人），调用会被直接拦截。content 是替换后的完整内容——先基于注入块里的现行内容整合修改，不要只传增量；传空字符串表示清空。",
    parameters: Type.Object({ content: Type.String({ description: `替换后的完整制作级指令（Markdown，≤${INSTRUCTIONS_MAX_LEN} 字符；空串=清空）` }) }),
    readOnly: false,
    mutates: () => ({ scope: "instructions", action: "updated" }), needsProduction: true,
    execute: async (ctx, args) => (await import("@/lib/mcp/instructions-tools")).updateProductionInstructions(ctx.userId, ctx.productionId, String(args.content)),
  },

  // ── production.wiki_* ───────────────────────────────────────────────────
  prodTool("production.wiki_tree", "查询当前对话关联制作的文档树（wiki 库），只列出当前用户有权限看到的文档（id/标题/tag）。",
    async (uid, pid) => (await import("@/lib/mcp/wiki-tools")).wikiTree(uid, pid)),
  {
    mcpName: "production.wiki_backlinks",
    description: "查询一篇文档的双向链接：谁链接到它（backlinks）、它链接到谁（outgoing）。",
    parameters: Type.Object({ wikiId: WIKI_ID }), readOnly: true, needsProduction: true,
    execute: async (ctx, args) => (await import("@/lib/mcp/wiki-tools")).wikiBacklinks(ctx.userId, ctx.productionId, String(args.wikiId)),
  },
  {
    mcpName: "production.wiki_read",
    description: `按 id 读取一篇文档的完整内容（标题/标签/正文）（EN: wiki read document content）。${WIKI_DIALECT_POINTER_READ}`,
    parameters: Type.Object({ wikiId: WIKI_ID }), readOnly: true, needsProduction: true,
    execute: async (ctx, args) => (await import("@/lib/mcp/wiki-tools")).wikiRead(ctx.userId, ctx.productionId, String(args.wikiId)),
  },
  {
    mcpName: "production.wiki_search",
    description: "全文搜索当前对话关联制作的文档库（标题+正文），只返回当前用户有权限看到的结果。",
    parameters: Type.Object({ query: Type.String({ description: "搜索关键词" }) }), readOnly: true, needsProduction: true,
    execute: async (ctx, args) => (await import("@/lib/mcp/wiki-tools")).wikiSearch(ctx.userId, ctx.productionId, String(args.query)),
  },
  {
    mcpName: "production.wiki_dialect_ref",
    description: "获取文档库正文的私有 Markdown 方言完整说明（链接/嵌入/布局/锚点文法）（EN: wiki markdown dialect syntax reference）。写作或改写文档正文前，语境中没有方言说明时必须先调用本工具。",
    parameters: NONE, readOnly: true,
    // 幂等标志（方言已在语境中）由 service 的 tool_result 钩子按本轮送达结论改写结果
    execute: async () => `${WIKI_LINK_SYNTAX_NOTE}\n\n${WIKI_DIALECT_NOTE}`,
  },
  {
    mcpName: "production.wiki_propose_create",
    description: `在某篇文档下（或在根下）提议新建一篇子文档（EN: wiki create new document），需要人工在聊天栏确认；确认后若你没有新建文档的权限，调用会被直接拦截并转入审批流。${WIKI_DIALECT_POINTER_WRITE}`,
    parameters: Type.Object({
      parentId: Type.Optional(Type.String({ description: "父文档 id；建在文档库根下就整个省略这个字段，不要传空字符串" })),
      title: Type.String({ description: "新文档标题" }),
      body: Type.Optional(Type.String({ description: "新文档正文（Markdown）" })),
      summary: Type.String({ description: "一句话说明这次提议改了什么、为什么" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.created, needsProduction: true,
    execute: async (ctx, args, toolCallId) => {
      const { wikiProposeCreate } = await import("@/lib/mcp/wiki-tools");
      const body = await proposalBody(ctx.productionId, toolCallId, ctx.userId, args.body);
      return wikiProposeCreate(ctx.userId, ctx.productionId, toolCallId, {
        parentId: optString(args.parentId), title: String(args.title), body, summary: String(args.summary ?? ""),
      });
    },
  },
  {
    mcpName: "production.wiki_propose_update",
    description: `提议修改一篇既有文档的标题和/或正文（只传要改的字段，不传的保持不变）（EN: wiki update edit document），需要人工在聊天栏确认；确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。${WIKI_DIALECT_POINTER_WRITE}`,
    parameters: Type.Object({
      wikiId: Type.String({ description: "要修改的文档 id（来自 wiki_tree/wiki_search 的结果）" }),
      title: Type.Optional(Type.String({ description: "新标题；不改标题就整个省略这个字段" })),
      body: Type.Optional(Type.String({ description: "新正文（Markdown）；不改正文就整个省略这个字段" })),
      summary: Type.String({ description: "一句话说明这次提议改了什么、为什么" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.updated, needsProduction: true,
    execute: async (ctx, args, toolCallId) => {
      const { wikiProposeUpdate } = await import("@/lib/mcp/wiki-tools");
      const body = await proposalBody(ctx.productionId, toolCallId, ctx.userId, args.body);
      return wikiProposeUpdate(ctx.userId, ctx.productionId, toolCallId, {
        wikiId: String(args.wikiId), title: optString(args.title), body, summary: String(args.summary ?? ""),
      });
    },
  },
  {
    mcpName: "production.wiki_propose_delete",
    description: "提议删除一篇既有文档，需要人工在聊天栏确认；确认后若你没有删除这篇文档的权限，调用会被直接拦截并转入审批流；被报告/备注引用（挂载）或系统锚点目录的文档无法删除（这不是权限问题）。",
    parameters: Type.Object({
      wikiId: Type.String({ description: "要删除的文档 id（来自 wiki_tree/wiki_search 的结果）" }),
      summary: Type.String({ description: "一句话说明为什么要删除" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.deleted, needsProduction: true,
    execute: async (ctx, args, toolCallId) => (await import("@/lib/mcp/wiki-tools")).wikiProposeDelete(ctx.userId, ctx.productionId, toolCallId, {
      wikiId: String(args.wikiId), summary: String(args.summary ?? ""),
    }),
  },
  {
    mcpName: "production.wiki_propose_move",
    description: "提议把一篇既有文档移动到另一篇文档下（或移到文档库根），需要人工在聊天栏确认；确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。",
    parameters: Type.Object({
      wikiId: Type.String({ description: "要移动的文档 id" }),
      newParentId: Type.Optional(Type.String({ description: "移动到的新父文档 id；移到文档库根就整个省略这个字段，不要传空字符串" })),
      summary: Type.String({ description: "一句话说明为什么要移动" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.updated, needsProduction: true,
    execute: async (ctx, args, toolCallId) => (await import("@/lib/mcp/wiki-tools")).wikiProposeMove(ctx.userId, ctx.productionId, toolCallId, {
      wikiId: String(args.wikiId), newParentId: optString(args.newParentId), summary: String(args.summary ?? ""),
    }),
  },
  {
    mcpName: "production.wiki_propose_tag",
    description: "提议设置一篇既有文档的标签（整体替换现有标签，不是增量追加——传空数组等于清空所有标签），需要人工在聊天栏确认；确认后若你没有编辑这篇文档的权限，调用会被直接拦截并转入审批流。",
    parameters: Type.Object({
      wikiId: Type.String({ description: "要设置标签的文档 id" }),
      tags: Type.Array(Type.String(), { description: "完整的新标签列表（整体替换，不是在现有标签上增量追加）" }),
      summary: Type.String({ description: "一句话说明为什么要这样设置标签" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.updated, needsProduction: true,
    execute: async (ctx, args, toolCallId) => (await import("@/lib/mcp/wiki-tools")).wikiProposeTag(ctx.userId, ctx.productionId, toolCallId, {
      wikiId: String(args.wikiId), tags: Array.isArray(args.tags) ? args.tags.map(String) : [], summary: String(args.summary ?? ""),
    }),
  },
  {
    mcpName: "production.wiki_set_grant",
    description: "修改一篇文档的分享设置：全体成员可见开关、分享给哪些部门（整体替换）、单独分享/撤销给某些人（view=可阅读 / edit=可编辑 / manage=可管理）。需要人工在聊天栏确认；确认后若你没有这篇文档的分享权限（grants@edit，与编辑权限是两回事），调用会被拒绝。用户 id 从 production.contact_list 取，部门 id 从 production.department_list 取。",
    parameters: Type.Object({
      wikiId: WIKI_ID,
      isPublic: Type.Optional(Type.Boolean({ description: "是否对制作全体成员可见；不改就整个省略这个字段" })),
      deptIds: Type.Optional(Type.Array(Type.String(), { description: "完整的部门分享列表（整体替换，不是增量追加——传空数组等于清空部门分享）；不改就整个省略这个字段" })),
      addPeople: Type.Optional(Type.Array(Type.Object({
        userId: Type.String({ description: "被分享人的用户 id（来自 production.contact_list）" }),
        level: Type.Union([Type.Literal("view"), Type.Literal("edit"), Type.Literal("manage")], { description: "分享级别：view=可阅读，edit=可编辑，manage=可管理（含再分享）" }),
      }), { description: "要新增分享的人；不加人就整个省略这个字段" })),
      removePeopleUserIds: Type.Optional(Type.Array(Type.String(), { description: "要撤销单独分享的用户 id；不撤销就整个省略这个字段" })),
      summary: Type.String({ description: "一句话说明这次为什么要改分享设置" }),
    }),
    readOnly: false,
    mutates: WIKI_MUTATES.updated, needsProduction: true,
    execute: async (ctx, args) => (await import("@/lib/mcp/wiki-tools")).wikiSetGrant(ctx.userId, ctx.productionId, {
      wikiId: String(args.wikiId),
      isPublic: typeof args.isPublic === "boolean" ? args.isPublic : undefined,
      deptIds: Array.isArray(args.deptIds) ? args.deptIds.map(String) : undefined,
      addPeople: Array.isArray(args.addPeople) ? (args.addPeople as Array<{ userId: string; level: "view" | "edit" | "manage" }>) : undefined,
      removePeopleUserIds: Array.isArray(args.removePeopleUserIds) ? args.removePeopleUserIds.map(String) : undefined,
      summary: String(args.summary ?? ""),
    }),
  },

  // ── 联网（网关时代 OpenClaw 内置的 web_search / web_fetch 的自建形态，见 web-tools.ts）
  {
    mcpName: "web.search",
    description: "联网搜索（Brave）：查外部资讯、剧目/演出/技术资料、不确定的事实等（EN: web search）。返回标题/链接/摘要，需要正文再用 web.fetch 抓取。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "搜索词（中英文均可）" }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "结果数，默认 5" })),
    }),
    readOnly: true,
    execute: async (ctx, args) => {
      const { webSearch, formatSearchHits, WebToolError } = await import("./web-tools");
      const q = String(args.query ?? "").trim();
      try {
        return formatSearchHits(q, await webSearch(q, typeof args.count === "number" ? args.count : undefined, ctx.run?.signal));
      } catch (err) {
        if (err instanceof WebToolError) return err.message;
        throw err;
      }
    },
  },
  {
    mcpName: "web.fetch",
    description: "抓取一个公开网页并抽出正文文本（EN: web fetch page）。用于读搜索结果、用户给的链接；内网地址不可抓，正文超长会截断。",
    parameters: Type.Object({ url: Type.String({ minLength: 1, description: "http/https 地址" }) }),
    readOnly: true,
    execute: async (ctx, args) => {
      const { webFetch, formatFetchedPage, WebToolError } = await import("./web-tools");
      try {
        return formatFetchedPage(await webFetch(String(args.url ?? ""), ctx.run?.signal));
      } catch (err) {
        if (err instanceof WebToolError) return err.message;
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "抓取超时";
        // 其余（TLS/网络栈内部错误）不把细节回给模型
        if (err instanceof Error) return "抓取失败：无法连接该网址";
        throw err;
      }
    },
  },

  // ── find_tools：冷层兜底。工具面按页面/召回分层（#333），模型觉得"应该有个工具能做
  // 这件事但列表里没有"时用它搜；搜到的名字**直接调用即可**（resolveDeferredTool 会按
  // 名临时加载，不需要任何中间步骤）。260 个工具时也是这个形态：目录不进 prompt。
  {
    mcpName: "find_tools",
    description:
      "按需求搜索本环境可用的 clickin 工具（EN: find tools）。当前工具列表只是本轮相关的子集；" +
      "如果你觉得应该有某个工具能完成用户的请求但列表里没有，用一句话描述需求来搜。" +
      "返回工具名与说明——**拿到名字后直接调用**，不需要其他步骤。",
    parameters: Type.Object({ query: Type.String({ description: "用户想做什么（自然语言，中文即可）" }) }),
    readOnly: true,
    execute: async (ctx, args) => {
      const { searchTools } = await import("./tool-index");
      const hits = await searchTools(String(args.query ?? ""), { hasProduction: !!ctx.productionId, userId: ctx.userId, limit: 5 });
      if (hits.length === 0) return "没有找到相关工具。请基于现有信息回答，或在回复里说明这件事目前没有工具支持。";
      const lines = hits.map((h) => `- ${exposedName(h.name)}：${h.oneliner}`);
      return `找到以下工具（直接按名调用即可，无需其他步骤）：\n${lines.join("\n")}`;
    },
  },

  // ── ask_user（#290）：向用户提问并等待回答。只读（无副作用）；恢复/重跑按
  // toolCallId 复用同一待答问题，不重问。取消/过期以错误结果回模型。
  {
    mcpName: "ask_user",
    description:
      "向用户提出一个或多个带选项的问题并**等待回答**（用户会看到卡片，可能几分钟后才答）。" +
      "只在信息确实缺失、且答案会改变你的做法时用；能自己查工具确定的事不要问。" +
      "每个问题给 2–5 个简短选项；需要自由输入就把 isOther 设为 true。用户可能取消（结果会说明），此时不要重复提问。",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        questionId: Type.String({ description: "本次提问内唯一的短 id，如 q1" }),
        header: Type.String({ description: "问题标题（≤12 字）" }),
        question: Type.String({ description: "完整问题" }),
        options: Type.Array(Type.Object({
          label: Type.String({ description: "选项文字" }),
          description: Type.Optional(Type.String({ description: "选项补充说明" })),
        }), { minItems: 1, maxItems: 6 }),
        multiSelect: Type.Optional(Type.Boolean({ description: "允许多选" })),
        isOther: Type.Optional(Type.Boolean({ description: "允许用户自由输入" })),
      }), { minItems: 1, maxItems: 4 }),
    }),
    readOnly: true,
    isErrorResult: (out) => out.startsWith("【"),
    execute: async (ctx, args, toolCallId) => {
      const run = ctx.run;
      if (!run) return "【提问不可用：当前执行环境没有会话交互通道】";
      const { createOrReuseQuestion, awaitQuestion, formatAnswers } = await import("./questions");
      const questions = (args.questions as QuestionItem[]).map((q) => ({
        questionId: String(q.questionId), header: String(q.header), question: String(q.question),
        options: (q.options ?? []).map((o) => ({ label: String(o.label), ...(o.description ? { description: String(o.description) } : {}) })),
        ...(q.multiSelect ? { multiSelect: true } : {}), ...(q.isOther ? { isOther: true } : {}),
      }));
      const { reused, ...info } = await createOrReuseQuestion({ runId: run.runId, sessionId: run.sessionId, toolCallId, questions });
      // 复用的待答问题不再重发卡（前端重开会话时经 /questions 恢复；重发只会多一张）
      if (!reused) run.publish({ type: "question", question: info });
      await run.setStatus("awaiting_answer");
      const outcome = await awaitQuestion(info.id, run.signal, undefined, { isDetached: run.isDetached });
      if (outcome.kind === "detached") return "【本进程已脱离，提问由下一个进程接管】"; // 不会落库：storage 已 detach
      await run.setStatus("running");
      run.publish({ type: "question-resolved", id: info.id, status: outcome.kind });
      if (outcome.kind === "answered") return formatAnswers(questions, outcome.answers);
      if (outcome.kind === "expired") return "【用户在限时内没有回答，提问已过期。不要重复提问；按现有信息继续，或在回复正文里说明需要哪些信息。】";
      return "【用户取消了这次提问。不要重复提问；按现有信息继续，或在回复正文里说明需要哪些信息。】";
    },
  },
];

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** propose 工具的正文以审批阶段预持久化的 wiki_proposal 行为准（[[标题]] 已反解），
 *  没有行（预持久化失败/超时）才退回模型原参数——与插件 restoredBody 覆写同义。 */
async function proposalBody(productionId: string, toolCallId: string, userId: string, fallback: unknown): Promise<string | undefined> {
  const { getWikiProposalByToolCallId } = await import("@/lib/wiki-proposal-db");
  const proposal = await getWikiProposalByToolCallId(productionId, toolCallId, userId);
  if (proposal && typeof proposal.body === "string" && proposal.body) return proposal.body;
  return optString(fallback);
}

export const TOOL_MCP_NAMES: readonly string[] = DEFS.map((d) => d.mcpName);

/** 按会话身份构造工具集；身份只进闭包，绝不进 schema。 */
export function buildTools(ctx: ToolContext): RuntimeToolDef[] {
  return DEFS.map((d) => ({
    mcpName: d.mcpName,
    name: exposedName(d.mcpName),
    label: toolLabel(d.mcpName),
    description: d.description,
    parameters: d.parameters,
    readOnly: d.readOnly,
    mutates: d.mutates,
    execute: async (toolCallId, params) => {
      if (d.needsProduction && !ctx.productionId) return text(NO_PRODUCTION);
      const out = await d.execute(
        { userId: ctx.userId, productionId: ctx.productionId ?? "", run: ctx.run },
        (params ?? {}) as Record<string, unknown>,
        toolCallId,
      );
      if (d.isErrorResult?.(out)) throw new Error(out);
      return text(out);
    },
  }));
}
