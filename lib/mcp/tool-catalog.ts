// AI 工具目录（#333 P2 中文发现面）。
//
// 背景：3b 路线下（网关开 tools.toolSearch），全部 clickin 工具的 schema 离开
// prompt、落进官方 Tool Search 目录——官方 tool_search 是纯 ASCII 词法检索
// （tokenize 对中文切出空集），中文消息搜不到工具。本目录是我们自己的发现面：
// 每条入站消息对 trigger 短语跑 CJK bigram 词法匹配（与 lib/agent-memory/
// trigger.ts 同款判据），命中的工具名注入本轮召回，模型拿到确切名字后经
// tool_describe / tool_call 直取（官方目录按名精确解析，不依赖先搜到）。
//
// 维护约定（与 lib/agent-page-context.ts PAGE_SUGGESTIONS 同族）：
// - 每上线/下线一个 MCP 工具（lib/mcp/server.ts），本目录同批增删——
//   tests/tool-catalog.test.ts 与注册清单双向防漂移。
// - trigger 用用户会说出口的中文短语；en 是英文关键词（补进工具描述，
//   供官方 tool_search 的英文兜底命中），两者都是发现面信号，不是权限。
// - 分层≠权限（#333 不变量 2）：命中与否只影响提示，不影响工具端判定。

import { bigramTokens } from "@/lib/agent-memory/trigger-lexical";

export type ToolCatalogEntry = {
  /** MCP 原始名（lib/mcp/server.ts 注册名） */
  name: string;
  /** production 工具仅在关联制作的会话里提示 */
  scope: "personal" | "production";
  /** 召回提示行里的一句话说明 */
  oneliner: string;
  /** 中文触发短语（CJK bigram 匹配）；空数组 = 不参与召回（如 dialect_ref
   *  ——它经工具描述里的指针到达，不走发现面） */
  triggers: string[];
  /** 英文关键词（官方 tool_search 兜底），server.ts 描述尾缀同源 */
  en: string;
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // ── personal ──────────────────────────────────────────────────────────────
  { name: "my.call_times", scope: "personal", oneliner: "查询自己近期的 Call/通告时间",
    triggers: ["通告", "通告时间", "几点到场", "call时间", "叫我几点"], en: "my call times schedule" },
  { name: "my.tech_reqs", scope: "personal", oneliner: "查询与我相关的技术需求/任务",
    triggers: ["技术需求", "我的任务", "需求单", "指派给我"], en: "my tech requirements tasks" },
  { name: "my.events", scope: "personal", oneliner: "查询我关注的即将开始的事件",
    triggers: ["关注的事件", "即将开始", "活动安排"], en: "my followed upcoming events" },
  { name: "my.milestones", scope: "personal", oneliner: "查询可见项目的临近里程碑",
    triggers: ["里程碑", "截止日期", "临近节点"], en: "my upcoming milestones deadlines" },
  { name: "my.productions", scope: "personal", oneliner: "查询我参与的全部制作与角色",
    triggers: ["我参与", "哪些制作", "哪些项目", "我的项目"], en: "my productions projects roles" },
  { name: "my.memory_search", scope: "personal", oneliner: "检索长期记忆与更早的历史对话",
    triggers: ["之前说过", "上次讨论", "之前的决定", "还记得", "更早的对话"], en: "search my memory history" },
  { name: "my.update_instructions", scope: "personal", oneliner: "修改个人 AI 指令（全量替换）",
    triggers: ["个人指令", "以后回复", "记住以后都", "设置偏好"], en: "update my AI instructions preferences" },
  { name: "users.query_sensitive", scope: "personal", oneliner: "查询自己登记的联系方式（需确认）",
    triggers: ["我的邮箱", "我的电话", "我的联系方式"], en: "my registered email phone" },

  // ── production ────────────────────────────────────────────────────────────
  { name: "production.info", scope: "production", oneliner: "查询当前制作的项目详情",
    triggers: ["项目介绍", "项目详情", "项目信息", "这个制作是"], en: "production project info" },
  { name: "production.my_role", scope: "production", oneliner: "查询我在本制作的职位与部门",
    triggers: ["我的职位", "我的部门", "我是什么角色"], en: "my role position department" },
  { name: "production.notifications", scope: "production", oneliner: "查询本制作里我的通知",
    triggers: ["未读通知", "有什么通知", "待办提醒"], en: "my notifications unread" },
  { name: "production.milestones", scope: "production", oneliner: "查询本制作的全部里程碑",
    triggers: ["里程碑", "排期", "时间表", "什么时候上演"], en: "production milestones timeline" },
  { name: "production.contact_list", scope: "production", oneliner: "查询成员名单（含用户 id、职位、部门）",
    triggers: ["成员名单", "通讯录", "谁负责", "找个人", "联系人"], en: "members contact list user id" },
  { name: "production.department_list", scope: "production", oneliner: "查询部门/用户组结构（含部门 id）",
    triggers: ["部门结构", "组织架构", "有哪些部门", "哪些组"], en: "departments groups structure" },
  { name: "production.wiki_tree", scope: "production", oneliner: "浏览文档库的目录树",
    triggers: ["文档结构", "文档目录", "有哪些文档", "文档库怎么组织"], en: "wiki documents tree list" },
  { name: "production.wiki_search", scope: "production", oneliner: "全文搜索当前制作的文档库",
    // "文档库"/"搜索" 这类短触发词是刻意的：bigram 命中占比对 3 字短语苛刻
    // （"文档库里搜索" 不含 "索文"，"搜索文档" 只得 0.67），短词补覆盖，
    // 误报代价只是召回提示里多一行，可接受。
    triggers: ["搜文档", "找资料", "查资料", "搜索文档", "文档里找", "找一篇", "文档库", "搜索"], en: "wiki search documents fulltext" },
  { name: "production.wiki_read", scope: "production", oneliner: "按 id 读取一篇文档的完整内容",
    triggers: ["读文档", "打开文档", "看看这篇", "文档内容", "这篇文档"], en: "wiki read document content" },
  { name: "production.wiki_backlinks", scope: "production", oneliner: "查询文档的双向链接关系",
    triggers: ["谁引用", "反向链接", "链接关系", "引用了哪些"], en: "wiki backlinks references" },
  { name: "production.wiki_propose_create", scope: "production", oneliner: "提议新建一篇文档（需人工确认）",
    triggers: ["新建文档", "建一篇", "写一篇文档", "整理成文档", "记录成文档"], en: "wiki create new document" },
  { name: "production.wiki_propose_update", scope: "production", oneliner: "提议修改一篇文档（需人工确认）",
    triggers: ["修改文档", "改这篇", "更新文档", "优化这篇文档", "补充到文档"], en: "wiki update edit document" },
  { name: "production.wiki_propose_delete", scope: "production", oneliner: "提议删除一篇文档（需人工确认）",
    triggers: ["删除文档", "删掉这篇"], en: "wiki delete document" },
  { name: "production.wiki_propose_move", scope: "production", oneliner: "提议移动一篇文档（需人工确认）",
    triggers: ["移动文档", "挪到", "换个目录", "归到"], en: "wiki move document" },
  { name: "production.wiki_propose_tag", scope: "production", oneliner: "提议设置文档标签（整体替换，需人工确认）",
    triggers: ["打标签", "设置标签", "加标签"], en: "wiki set tags" },
  { name: "production.wiki_set_grant", scope: "production", oneliner: "修改文档分享设置（需人工确认）",
    triggers: ["分享给", "谁能看", "文档权限", "可见范围"], en: "wiki share grant visibility" },
  { name: "production.wiki_dialect_ref", scope: "production", oneliner: "获取文档正文的私有 Markdown 方言说明",
    triggers: [], en: "wiki markdown dialect syntax reference" },
  { name: "production.update_instructions", scope: "production", oneliner: "修改本制作的 AI 指令（全量替换，需人工确认）",
    triggers: ["制作指令", "项目指令", "团队的 AI"], en: "update production AI instructions" },
];

/** 命中判据与 lib/agent-memory/trigger.ts 对齐（纯词法单路）。 */
export const TOOL_RECALL_THRESHOLD = 0.72;
export const TOOL_RECALL_MAX = 3;

/** 需要方言说明的正文读写工具（召回命中时闭包携带方言，#333 T1 冷层通道）。 */
export const DIALECT_CLOSURE_TOOLS = new Set([
  "production.wiki_read",
  "production.wiki_propose_create",
  "production.wiki_propose_update",
]);

function lexicalScore(phrase: string, promptTokens: Set<string>): number {
  const toks = bigramTokens(phrase);
  if (toks.length === 0) return 0;
  let hit = 0;
  for (const t of toks) if (promptTokens.has(t)) hit++;
  return hit / toks.length;
}

export type ToolRecallHit = { name: string; oneliner: string; score: number };

/** 入站消息 → 相关工具（纯函数，无 DB/embedding）。production 工具只在
 *  关联制作的会话提示——个人会话推它们只会引导模型撞 NO_PRODUCTION。 */
export function toolRecall(prompt: string, opts: { hasProduction: boolean }): ToolRecallHit[] {
  const promptTokens = new Set(bigramTokens(prompt));
  if (promptTokens.size === 0) return [];
  const hits: ToolRecallHit[] = [];
  for (const entry of TOOL_CATALOG) {
    if (entry.scope === "production" && !opts.hasProduction) continue;
    if (entry.triggers.length === 0) continue;
    let best = 0;
    for (const t of entry.triggers) {
      const s = lexicalScore(t, promptTokens);
      if (s > best) best = s;
    }
    if (best >= TOOL_RECALL_THRESHOLD) hits.push({ name: entry.name, oneliner: entry.oneliner, score: best });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, TOOL_RECALL_MAX);
}
