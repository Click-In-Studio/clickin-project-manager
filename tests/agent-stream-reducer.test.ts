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

  it("tool line carries input; tool-result merges result before tool-end", () => {
    let b: Bubble[] = [];
    b = applyStreamLine(b, { type: "tool", name: "clickin__production-wiki_read", id: "t1", input: { wikiId: "w1" } });
    expect(b[0]).toEqual({
      kind: "tool", name: "clickin__production-wiki_read", id: "t1", done: false, input: { wikiId: "w1" },
    });
    // gateway 实序：tool 流的 result 先于 item 流的 end 到达
    b = applyStreamLine(b, { type: "tool-result", id: "t1", result: { content: [{ type: "text", text: "正文" }] } });
    expect(b[0]).toMatchObject({ done: false, result: { content: [{ type: "text", text: "正文" }] } });
    b = applyStreamLine(b, { type: "tool-end", id: "t1" });
    expect(b[0]).toMatchObject({ done: true, input: { wikiId: "w1" }, result: { content: [{ type: "text", text: "正文" }] } });
  });

  it("tool-result marks failure via isError and matches by id among multiple calls", () => {
    let b: Bubble[] = [
      { kind: "tool", name: "a", id: "t1", done: false },
      { kind: "tool", name: "b", id: "t2", done: false },
    ];
    b = applyStreamLine(b, { type: "tool-result", id: "t1", result: "拒绝", isError: true });
    expect(b[0]).toMatchObject({ id: "t1", isError: true, result: "拒绝" });
    expect(b[1]).toEqual({ kind: "tool", name: "b", id: "t2", done: false });
  });

  it("tool-result without id is dropped (never guessed onto a bubble); unmatched id is a no-op", () => {
    // 并发多调用下"猜最后一个未完成气泡"会张冠李戴——无 id 宁缺毋滥。
    const prev: Bubble[] = [
      { kind: "tool", name: "a", id: "t1", done: true },
      { kind: "tool", name: "b", id: "t2", done: false },
    ];
    expect(applyStreamLine(prev, { type: "tool-result", result: "ok" })).toEqual(prev);
    expect(applyStreamLine(prev, { type: "tool-result", id: "t9", result: "孤儿" })).toEqual(prev);
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

  const question = {
    id: "q-1",
    questions: [
      {
        questionId: "pick_one",
        header: "方案",
        question: "先做哪个？",
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
  };

  it("question card settles streaming segment, appends, and dedups by id", () => {
    let b: Bubble[] = [{ kind: "assistant", text: "我需要确认", streaming: true }];
    b = applyStreamLine(b, { type: "question", question });
    expect(b[0]).toEqual({ kind: "assistant", text: "我需要确认" });
    expect(b[1]).toMatchObject({ kind: "question", question: { id: "q-1" } });
    // 同一问题既来自 question.list 恢复又来自实时事件——第二次注入被吞
    b = applyStreamLine(b, { type: "question", question });
    expect(b).toHaveLength(2);
  });

  it("question-resolved flips the card status by id", () => {
    let b: Bubble[] = [{ kind: "question", question }];
    b = applyStreamLine(b, { type: "question-resolved", id: "q-1", status: "answered" });
    expect(b[0]).toMatchObject({ kind: "question", status: "answered", resolving: false });
  });

  it("malformed question lines change nothing", () => {
    const prev: Bubble[] = [{ kind: "user", text: "hi" }];
    expect(applyStreamLine(prev, { type: "question" })).toEqual(prev);
    expect(applyStreamLine(prev, { type: "question", question: { id: "x", questions: [] } })).toEqual(prev);
  });

  it("fallback final after an unfinished tool appends an incompleteness notice", () => {
    // 兜底路径必须和正常路径可区分：工具还没收尾流就以兜底 final 结束，
    // 说明本轮被掐断过，不能伪装成一次正常完成。
    let b: Bubble[] = [
      { kind: "assistant", text: "命令已在跑" },
      { kind: "tool", name: "exec", id: "t1", done: false },
    ];
    b = applyStreamLine(b, { type: "final", text: "命令已在跑", fallback: true });
    expect(b[b.length - 1]).toEqual({ kind: "notice", text: "本轮回复以兜底方式收尾，内容可能不完整" });
  });

  it("fallback final with everything settled adds no notice", () => {
    let b: Bubble[] = [
      { kind: "tool", name: "exec", id: "t1", done: true },
      { kind: "assistant", text: "旧回复" },
    ];
    b = applyStreamLine(b, { type: "final", text: "新回复", fallback: true });
    expect(b.some((x) => x.kind === "notice")).toBe(false);
  });

  it("fallback final after an unanswered question appends the notice", () => {
    let b: Bubble[] = [{ kind: "question", question }];
    b = applyStreamLine(b, { type: "final", text: "中间发言", fallback: true });
    expect(b[b.length - 1]).toMatchObject({ kind: "notice" });
  });
});

describe("mutation 行（#367 写操作后自动刷新）", () => {
  it("不进气泡：reducer 原样返回", () => {
    const prev = applyStreamLine([], { type: "final", text: "ok" });
    const next = applyStreamLine(prev, { type: "mutation", scope: "wiki", action: "created", productionId: "p1" });
    expect(next).toEqual(prev);
  });
});
