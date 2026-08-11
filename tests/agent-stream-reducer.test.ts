import { describe, it, expect } from "vitest";
import { applyStreamLine, type Bubble } from "@/lib/agent-gateway/stream-reducer";

// 聊天流 reducer 的渲染语义测试——重点覆盖 #198 的两个修复：
// fallback final 去重（只吞兜底重复，不吞正常重复回复）与流式段落收尾。

const approval = {
  id: "plugin:abc",
  title: "执行 docs-propose",
  description: "参数：{}",
  severity: "warning" as const,
  allowedDecisions: ["allow-once", "deny"],
};

describe("applyStreamLine", () => {
  it("delta creates then updates a streaming bubble", () => {
    let b: Bubble[] = [{ kind: "user", text: "hi" }];
    b = applyStreamLine(b, { type: "delta", text: "你" });
    b = applyStreamLine(b, { type: "delta", text: "你好" });
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual({ kind: "assistant", text: "你好", streaming: true });
  });

  it("final settles the streaming bubble in place", () => {
    let b: Bubble[] = [{ kind: "assistant", text: "部分", streaming: true }];
    b = applyStreamLine(b, { type: "final", text: "完整回复" });
    expect(b).toEqual([{ kind: "assistant", text: "完整回复" }]);
  });

  it("fallback final identical to last assistant bubble is deduped", () => {
    const prev: Bubble[] = [
      { kind: "assistant", text: "上一轮的回复" },
      { kind: "user", text: "新问题" },
    ];
    const next = applyStreamLine(prev, { type: "final", text: "上一轮的回复", fallback: true });
    expect(next).toEqual(prev); // 兜底重复被吞
  });

  it("NON-fallback final with identical text still renders", () => {
    const prev: Bubble[] = [
      { kind: "assistant", text: "好的" },
      { kind: "user", text: "再说一次" },
    ];
    const next = applyStreamLine(prev, { type: "final", text: "好的" });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ kind: "assistant", text: "好的" });
  });

  it("fallback final with NEW text renders (recovery path)", () => {
    const prev: Bubble[] = [
      { kind: "assistant", text: "旧回复" },
      { kind: "user", text: "新问题" },
    ];
    const next = applyStreamLine(prev, { type: "final", text: "事件丢了但历史里有的新回复", fallback: true });
    expect(next).toHaveLength(3);
  });

  it("tool call settles streaming segment and appends chip; tool-end flips it", () => {
    let b: Bubble[] = [{ kind: "assistant", text: "我来查一下", streaming: true }];
    b = applyStreamLine(b, { type: "tool", name: "clickin__docs-read", id: "t1" });
    expect(b[0]).toEqual({ kind: "assistant", text: "我来查一下" });
    expect(b[1]).toEqual({ kind: "tool", name: "clickin__docs-read", id: "t1", done: false });
    b = applyStreamLine(b, { type: "tool-end", id: "t1" });
    expect(b[1]).toMatchObject({ done: true });
  });

  it("approval card appends and resolves by id", () => {
    let b: Bubble[] = [{ kind: "user", text: "propose 一下" }];
    b = applyStreamLine(b, { type: "approval", approval });
    expect(b[1]).toMatchObject({ kind: "approval", approval: { id: "plugin:abc" } });
    b = applyStreamLine(b, { type: "approval-resolved", id: "plugin:abc", decision: "allow-once" });
    expect(b[1]).toMatchObject({ kind: "approval", decision: "allow-once", resolving: false });
  });

  it("ping/session lines change nothing", () => {
    const prev: Bubble[] = [{ kind: "user", text: "hi" }];
    expect(applyStreamLine(prev, { type: "ping" })).toEqual(prev);
    expect(applyStreamLine(prev, { type: "session", key: "agent:team:x" })).toEqual(prev);
  });
});
