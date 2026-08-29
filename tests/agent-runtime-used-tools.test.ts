import { describe, it, expect } from "vitest";
import { recentlyUsedToolNames, USED_TOOL_TURNS, USED_TOOL_MAX } from "@/lib/agent-runtime/used-tools";
import type { AgentMessage } from "../vendor/openclaw/packages/agent-core/src/types";

// 会话内已用工具的留存有淘汰窗口：只看最近 N 个用户轮次、最多 M 个、最近优先。
// 否则一个在同一 session 里东问西问的人会把工具面越滚越大。

const user = (t: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 });
const call = (...names: string[]): AgentMessage => ({
  role: "assistant",
  content: names.map((n, i) => ({ type: "toolCall" as const, id: `c${n}${i}`, name: n, arguments: {} })),
  api: "openai-completions", provider: "deepseek", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 0,
} as AgentMessage);

describe("recentlyUsedToolNames", () => {
  it("窗口外的轮次淘汰：只保留最近 N 个用户轮次里调过的", () => {
    const msgs = [
      user("通告"), call("call_times"),
      user("文档"), call("wiki_search", "wiki_read"),
      user("通讯录"), call("contact_list"),
      user("里程碑"), call("milestones"),
    ];
    expect(USED_TOOL_TURNS).toBe(3);
    const used = recentlyUsedToolNames(msgs);
    expect(used).toEqual(["milestones", "contact_list", "wiki_read", "wiki_search"]); // 最近优先
    expect(used).not.toContain("call_times"); // 第 4 轮之前的淘汰
  });

  it("上限 M 个，最近优先；同名去重", () => {
    const msgs = [user("x"), call("a", "b", "c", "d"), user("y"), call("e", "f", "g", "a")];
    const used = recentlyUsedToolNames(msgs);
    expect(used.length).toBe(USED_TOOL_MAX);
    expect(used.slice(0, 4)).toEqual(["a", "g", "f", "e"]);
    expect(new Set(used).size).toBe(used.length);
  });

  it("窗口可调；没有 toolCall 的会话返回空", () => {
    const msgs = [user("x"), call("a"), user("y")];
    expect(recentlyUsedToolNames(msgs, { turns: 1 })).toEqual([]);
    expect(recentlyUsedToolNames(msgs, { turns: 2 })).toEqual(["a"]);
    expect(recentlyUsedToolNames([user("x")])).toEqual([]);
  });
});
