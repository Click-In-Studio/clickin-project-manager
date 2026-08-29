// 工具三层（#333 判据，#367 里一行代码的实现）：每轮送给模型的工具列表 =
//   热层（按会话类型两张表） ∪ 温层（当前页面） ∪ 冷层召回命中（tool-catalog 中文 bigram）
//   ∪ 依赖闭包（id 供给入口 / 知识节点由 knowledge 通道另送）
//
// 判据总纲（Skills 分层指南 §2）：热 = 按需机制覆盖不了的（范围锚点、id 供给、高频）；
// 冷 = 能被页面/触发词覆盖的。分层是可见性与成本，**不是权限**（不变量 2）：工具端
// hasEffectiveGrant 才是边界，这里少给一个工具最多让模型这轮不知道它存在。
//
// fail-open：任何异常 → 全量工具（宁可贵，不可残废）。AGENT_TOOL_TIERS=off 关闭分层。

import { toolRecall } from "@/lib/mcp/tool-catalog";

/** 个人会话热层：my.* 就是它的全部业务面（砍了等于空手）+ 提问 */
const HOT_PERSONAL = [
  "my.productions", "my.memory_search", "my.call_times", "my.events", "my.milestones", "my.tech_reqs", "ask_user", "find_tools",
];

/** 制作会话热层：范围锚点 + 语境锚（info/my_role/notifications）+ id 供给入口（成员/部门）+ 提问 */
const HOT_PRODUCTION = [
  "my.productions", "my.memory_search", "my.call_times",
  "production.info", "production.my_role", "production.notifications",
  "production.contact_list", "production.department_list",
  "ask_user", "find_tools",
];

const WIKI_FAMILY = [
  "production.wiki_tree", "production.wiki_search", "production.wiki_read", "production.wiki_backlinks",
  "production.wiki_dialect_ref",
  "production.wiki_propose_create", "production.wiki_propose_update", "production.wiki_propose_delete",
  "production.wiki_propose_move", "production.wiki_propose_tag", "production.wiki_set_grant",
];

/** 温层：pageKey → 该页的工作面（与 PAGE_LABELS 的 key 对齐；缺席 = 该页无温层） */
const WARM_BY_PAGE: Record<string, string[]> = {
  "prod:wiki": WIKI_FAMILY,
  "prod:dramaturgy-inspiration": WIKI_FAMILY,
  "prod:planning": ["production.milestones"],
  "prod:home": ["production.milestones"],
  "prod:contacts": ["production.contact_list", "production.department_list", "users.query_sensitive"],
  "prod:notifications": ["production.notifications"],
  "prod:admin": ["production.update_instructions"],
  "account": ["my.update_instructions", "users.query_sensitive"],
  "my:milestones": ["my.milestones"],
  "my:reqs": ["my.tech_reqs"],
  "my:daily-call": ["my.call_times"],
  "my:weekly-call": ["my.call_times"],
};

/** 依赖闭包：激活某工具时必须连带激活的上游 id 供给工具。 */
const CLOSURE: Record<string, string[]> = {
  "production.wiki_read": ["production.wiki_tree", "production.wiki_search"],
  "production.wiki_backlinks": ["production.wiki_tree", "production.wiki_search"],
  "production.wiki_propose_create": ["production.wiki_tree", "production.wiki_search", "production.wiki_read", "production.wiki_dialect_ref"],
  "production.wiki_propose_update": ["production.wiki_tree", "production.wiki_search", "production.wiki_read", "production.wiki_dialect_ref"],
  "production.wiki_propose_delete": ["production.wiki_tree", "production.wiki_search"],
  "production.wiki_propose_move": ["production.wiki_tree", "production.wiki_search"],
  "production.wiki_propose_tag": ["production.wiki_tree", "production.wiki_search"],
  "production.wiki_set_grant": ["production.wiki_tree", "production.wiki_search", "production.contact_list", "production.department_list"],
};

export interface TierInput {
  hasProduction: boolean;
  pageKey: string | null;
  /** 冷层召回结果（tool-index：词法+向量）。缺席时退回纯词法 toolRecall(prompt) */
  recalled?: string[];
  prompt: string | null;
  /** 全部可用工具的 MCP 名（注册表）——结果只会是它的子集 */
  available: readonly string[];
}

export interface TierResult {
  active: string[];
  hot: string[];
  warm: string[];
  recalled: string[];
}

export function tieredToolNames(input: TierInput): TierResult {
  const available = new Set(input.available);
  if (process.env.AGENT_TOOL_TIERS === "off") {
    return { active: [...available], hot: [...available], warm: [], recalled: [] };
  }
  try {
    const hot = (input.hasProduction ? HOT_PRODUCTION : HOT_PERSONAL).filter((n) => available.has(n));
    const warm = (input.pageKey ? WARM_BY_PAGE[input.pageKey] ?? [] : []).filter((n) => available.has(n));
    const recalled = (input.recalled
      ?? (input.prompt ? toolRecall(input.prompt, { hasProduction: input.hasProduction }).map((h) => h.name) : [])
    ).filter((n) => available.has(n));
    const active = new Set<string>([...hot, ...warm, ...recalled]);
    // 闭包：迭代到不动点（闭包里的工具也可能有自己的闭包）
    let grew = true;
    while (grew) {
      grew = false;
      for (const name of [...active]) {
        for (const dep of CLOSURE[name] ?? []) {
          if (available.has(dep) && !active.has(dep)) {
            active.add(dep);
            grew = true;
          }
        }
      }
    }
    // 个人会话里 production 工具本来就不可用，去掉免得模型撞 NO_PRODUCTION
    const list = [...active].filter((n) => input.hasProduction || !n.startsWith("production."));
    return { active: list, hot, warm, recalled };
  } catch (err) {
    console.error("[agent-runtime] tool tiering failed, falling back to all tools:", err);
    return { active: [...available], hot: [...available], warm: [], recalled: [] };
  }
}
