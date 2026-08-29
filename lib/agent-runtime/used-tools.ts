// 会话内已用工具的留存与淘汰（#367）。
//
// 留存的理由是话题连续性："刚才那个工具"下一轮不该消失。但连续性是**短程**的：
// 一个人在同一 session 里先问通告、再翻文档、再查通讯录、再改指令……逐轮累加会把
// 工具面越滚越大，最后全靠 cap 截断——截掉的还未必是最旧的。所以按"最近 N 个用户
// 轮次内调过的"取，且最多 M 个（最近优先）。窗口外的自然淘汰；再要用，召回/兜底会把它找回来。

import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";

/** 只看最近这么多个用户轮次（含当前轮之前的） */
export const USED_TOOL_TURNS = 3;
/** 留存上限（最近优先） */
export const USED_TOOL_MAX = 6;

/**
 * transcript 里最近 USED_TOOL_TURNS 个用户轮次内出现过的 toolCall 名（暴露名），
 * 最近的在前，去重，最多 USED_TOOL_MAX 个。不认识的名字由调用方过滤。
 */
export function recentlyUsedToolNames(
  messages: AgentMessage[],
  opts: { turns?: number; max?: number } = {},
): string[] {
  const turns = opts.turns ?? USED_TOOL_TURNS;
  const max = opts.max ?? USED_TOOL_MAX;
  const out: string[] = [];
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      // 倒序扫：遇到第 k 条用户消息时，它之后的 assistant 消息属于第 k 轮；
      // 它之前的属于更早的轮次——数满 turns 条就停
      userTurnsSeen++;
      if (userTurnsSeen >= turns) break;
      continue;
    }
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j];
      if (block.type !== "toolCall" || out.includes(block.name)) continue;
      out.push(block.name);
      if (out.length >= max) return out;
    }
  }
  return out;
}
