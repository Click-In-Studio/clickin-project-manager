import { describe, it, expect, beforeEach } from "vitest";
import { dispatchAgentMutation, subscribeAgentMutation, _resetAgentMutationSubscribers } from "@/lib/agent-mutations";

// 前端派发表：按 scope（可选 productionId）匹配；没人接返回 false（AgentPopout 据此兜底 router.refresh）。

describe("agent-mutations 派发", () => {
  beforeEach(() => _resetAgentMutationSubscribers());

  it("scope 命中才派发；订阅带 productionId 时信号必须同制作（缺席也不算）；返回值告诉调用方有没有人接", () => {
    const got: string[] = [];
    subscribeAgentMutation({ scope: "wiki", productionId: "p1" }, (m) => got.push(`wiki:${m.action}`));
    subscribeAgentMutation({ scope: "instructions" }, (m) => got.push(`instr:${m.action}`));
    expect(dispatchAgentMutation({ scope: "wiki", action: "created", productionId: "p1" })).toBe(true);
    expect(dispatchAgentMutation({ scope: "wiki", action: "created", productionId: "p2" })).toBe(false);
    expect(dispatchAgentMutation({ scope: "wiki", action: "updated", productionId: null })).toBe(false); // 订阅按制作过滤，信号没带制作 → 不算命中
    expect(dispatchAgentMutation({ scope: "instructions", action: "updated" })).toBe(true);
    expect(dispatchAgentMutation({ scope: "tasks", action: "updated" })).toBe(false);
    expect(got).toEqual(["wiki:created", "instr:updated"]);
  });

  it("退订后不再收到；某个 handler 抛错不影响其他订阅者", () => {
    const got: string[] = [];
    const off = subscribeAgentMutation({ scope: "wiki" }, () => { throw new Error("boom"); });
    subscribeAgentMutation({ scope: "wiki" }, () => got.push("ok"));
    expect(dispatchAgentMutation({ scope: "wiki", action: "deleted" })).toBe(true);
    expect(got).toEqual(["ok"]);
    off();
    dispatchAgentMutation({ scope: "wiki", action: "deleted" });
    expect(got).toEqual(["ok", "ok"]);
  });
});
