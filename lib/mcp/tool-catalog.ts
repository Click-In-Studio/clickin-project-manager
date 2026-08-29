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
  /** 用户会怎么说（向量召回的语料，#367 tool-index）：嵌入的是"说法"而不是描述——
   *  用户消息 ↔ 例句的相似度远高于用户消息 ↔ 技术描述。每条独立嵌入，召回取 max。 */
  examples?: string[];
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // ── personal ──────────────────────────────────────────────────────────────
  { name: "my.call_times", scope: "personal", oneliner: "查询自己近期的 Call/通告时间",
    triggers: ["通告", "通告时间", "几点到场", "call时间", "叫我几点"], en: "my call times schedule",
    examples: ["我明天几点到场", "我最近的通告是什么时候", "查一下我的 call 时间", "我今天几点有排练"] },
  { name: "my.tech_reqs", scope: "personal", oneliner: "查询与我相关的技术需求/任务",
    triggers: ["技术需求", "我的任务", "需求单", "指派给我"], en: "my tech requirements tasks",
    examples: ["我名下有哪些技术需求", "分给我的任务有哪些", "我负责的需求进度怎么样"] },
  { name: "my.events", scope: "personal", oneliner: "查询我关注的即将开始的事件",
    triggers: ["关注的事件", "即将开始", "活动安排"], en: "my followed upcoming events",
    examples: ["我关注的活动有哪些快开始了", "最近有什么我关注的事件"] },
  { name: "my.milestones", scope: "personal", oneliner: "查询可见项目的临近里程碑",
    triggers: ["里程碑", "截止日期", "临近节点"], en: "my upcoming milestones deadlines",
    examples: ["最近有什么截止日期", "我参与的项目有哪些里程碑快到了"] },
  { name: "my.productions", scope: "personal", oneliner: "查询我参与的全部制作与角色",
    triggers: ["我参与", "哪些制作", "哪些项目", "我的项目"], en: "my productions projects roles",
    examples: ["我参与了哪些制作", "我在哪些项目里", "我在每个项目里是什么角色"] },
  { name: "my.memory_search", scope: "personal", oneliner: "检索长期记忆与更早的历史对话",
    triggers: ["之前说过", "上次讨论", "之前的决定", "还记得", "更早的对话"], en: "search my memory history",
    examples: ["我们之前聊过这个吗", "你还记得上次说的那个决定吗", "帮我回忆一下之前讨论的内容"] },
  { name: "my.update_instructions", scope: "personal", oneliner: "修改个人 AI 指令（全量替换）",
    triggers: ["个人指令", "以后回复", "记住以后都", "设置偏好"], en: "update my AI instructions preferences",
    examples: ["以后回复我都用简短一点", "记住以后叫我导演", "把我的个人偏好设置改一下"] },
  { name: "users.query_sensitive", scope: "personal", oneliner: "查询自己登记的联系方式（需确认）",
    triggers: ["我的邮箱", "我的电话", "我的联系方式"], en: "my registered email phone",
    examples: ["我登记的邮箱是什么", "系统里我的电话是多少"] },

  // ── production ────────────────────────────────────────────────────────────
  { name: "production.info", scope: "production", oneliner: "查询当前制作的项目详情",
    triggers: ["项目介绍", "项目详情", "项目信息", "这个制作是"], en: "production project info",
    examples: ["介绍一下这个项目", "这部戏的基本信息", "这个制作是谁负责的"] },
  { name: "production.my_role", scope: "production", oneliner: "查询我在本制作的职位与部门",
    triggers: ["我的职位", "我的部门", "我是什么角色"], en: "my role position department",
    examples: ["我在这个项目里是什么职位", "我属于哪个部门"] },
  { name: "production.notifications", scope: "production", oneliner: "查询本制作里我的通知",
    triggers: ["未读通知", "有什么通知", "待办提醒"], en: "my notifications unread",
    examples: ["这个项目里我有什么未读通知", "有没有需要我处理的提醒"] },
  { name: "production.milestones", scope: "production", oneliner: "查询本制作的全部里程碑",
    triggers: ["里程碑", "排期", "时间表", "什么时候上演"], en: "production milestones timeline",
    examples: ["这个项目接下来的里程碑有哪些", "首演定在什么时候", "排期是怎么安排的"] },
  { name: "production.contact_list", scope: "production", oneliner: "查询成员名单（含用户 id、职位、部门）",
    triggers: ["成员名单", "通讯录", "谁负责", "找个人", "联系人"], en: "members contact list user id",
    examples: ["这个项目有哪些成员", "谁负责灯光", "帮我找一下舞美的负责人是谁"] },
  { name: "production.department_list", scope: "production", oneliner: "查询部门/用户组结构（含部门 id）",
    triggers: ["部门结构", "组织架构", "有哪些部门", "哪些组"], en: "departments groups structure",
    examples: ["这个项目有哪些部门", "部门结构是怎样的"] },
  // "wiki"/"文档" 这类短触发词是真人使用校出来的（2026-08-29）："列举我能看到哪些 wiki 文档"
  // 对四字短语只中一半，而 wiki 这个最显然的词此前不在任何触发词里。短词误报的代价
  // 只是工具面多几个工具（闭包会把 read/search/tree 一起带上），可接受。
  { name: "production.wiki_tree", scope: "production", oneliner: "浏览文档库的目录树",
    triggers: ["wiki", "文档", "文档结构", "文档目录", "有哪些文档", "文档库怎么组织"], en: "wiki documents tree list",
    examples: ["我能看到哪些文档", "列一下这个项目的文档", "文档库里都有什么", "有哪些 wiki"] },
  { name: "production.wiki_search", scope: "production", oneliner: "全文搜索当前制作的文档库",
    // "文档库"/"搜索" 这类短触发词是刻意的：bigram 命中占比对 3 字短语苛刻
    // （"文档库里搜索" 不含 "索文"，"搜索文档" 只得 0.67），短词补覆盖，
    // 误报代价只是召回提示里多一行，可接受。
    triggers: ["wiki", "文档", "搜文档", "找资料", "查资料", "搜索文档", "文档里找", "找一篇", "文档库", "搜索"], en: "wiki search documents fulltext",
    examples: ["帮我在文档里找一下关于灯光的内容", "搜一下排练笔记", "文档库里有没有提到预算"] },
  { name: "production.wiki_read", scope: "production", oneliner: "按 id 读取一篇文档的完整内容",
    triggers: ["wiki", "读文档", "打开文档", "看看这篇", "文档内容", "这篇文档"], en: "wiki read document content",
    examples: ["把那篇文档读给我看", "打开这篇文档的内容", "这篇 wiki 写了什么", "帮我读一下现在有的几份排练记录，里面有内容吗", "看看这几篇文档里写了什么", "打开最新的那篇看看"] },
  { name: "production.wiki_backlinks", scope: "production", oneliner: "查询文档的双向链接关系",
    triggers: ["谁引用", "反向链接", "链接关系", "引用了哪些"], en: "wiki backlinks references",
    examples: ["哪些文档引用了这一篇", "这篇文档链接到了谁"] },
  { name: "production.wiki_propose_create", scope: "production", oneliner: "提议新建一篇文档（需人工确认）",
    triggers: ["新建文档", "建一篇", "写一篇文档", "整理成文档", "记录成文档"], en: "wiki create new document",
    examples: ["帮我新建一篇文档记录今天的会议", "把这些整理成一篇文档", "写一篇排练总结存到文档库"] },
  { name: "production.wiki_propose_update", scope: "production", oneliner: "提议修改一篇文档（需人工确认）",
    triggers: ["修改文档", "改这篇", "更新文档", "优化这篇文档", "补充到文档"], en: "wiki update edit document",
    examples: ["帮我修改这篇文档", "把会议结论补充进文档", "优化一下这篇的结构"] },
  { name: "production.wiki_propose_delete", scope: "production", oneliner: "提议删除一篇文档（需人工确认）",
    triggers: ["删除文档", "删掉这篇"], en: "wiki delete document",
    examples: ["把这篇文档删掉", "删除这篇过时的文档"] },
  { name: "production.wiki_propose_move", scope: "production", oneliner: "提议移动一篇文档（需人工确认）",
    triggers: ["移动文档", "挪到", "换个目录", "归到"], en: "wiki move document",
    examples: ["把这篇文档挪到另一个目录下", "移动这篇文档"] },
  { name: "production.wiki_propose_tag", scope: "production", oneliner: "提议设置文档标签（整体替换，需人工确认）",
    triggers: ["打标签", "设置标签", "加标签"], en: "wiki set tags",
    examples: ["给这篇文档打个标签", "把这篇的标签改成剧本"] },
  { name: "production.wiki_set_grant", scope: "production", oneliner: "修改文档分享设置（需人工确认）",
    triggers: ["分享给", "谁能看", "文档权限", "可见范围"], en: "wiki share grant visibility",
    examples: ["把这篇文档分享给灯光部门", "让某某也能看这篇文档", "这篇文档谁能看"] },
  { name: "production.wiki_dialect_ref", scope: "production", oneliner: "获取文档正文的私有 Markdown 方言说明",
    triggers: [], en: "wiki markdown dialect syntax reference" },
  { name: "production.update_instructions", scope: "production", oneliner: "修改本制作的 AI 指令（全量替换，需人工确认）",
    triggers: ["制作指令", "项目指令", "团队的 AI"], en: "update production AI instructions",
    examples: ["给整个项目的 AI 加一条规则", "修改本制作的 AI 指令"] },
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
