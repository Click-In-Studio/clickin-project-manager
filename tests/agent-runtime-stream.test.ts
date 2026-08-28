import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Model, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types.js";
import { CoreAgentHarness, InMemorySessionStorage, type ExecutionEnv } from "../vendor/openclaw/packages/agent-core/src/index.js";
import { Session } from "../vendor/openclaw/packages/agent-core/src/harness/session/session.js";
import { applyStreamLine, type Bubble, type StreamLine } from "@/lib/agent-gateway/stream-reducer";
import { createStreamLineAdapter } from "@/lib/agent-runtime/stream-lines";
import type { RuntimeTool } from "@/lib/agent-runtime/resume";

// #367 S1 出口判据④：harness 事件经适配器变成现有前端的 StreamLine，再喂给
// **现有** reducer（lib/agent-gateway/stream-reducer.ts 原样），气泡结果与
// gateway 时代一致——前端零改动的判据在 reducer 层可机械验证。

const MODEL: Model = {
  id: "fake", name: "fake", api: "openai-completions", provider: "deepseek", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
};
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = (): Omit<AssistantMessage, "content" | "stopReason"> => ({ role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, timestamp: Date.now() });

/** 假模型：文本按字符逐个 text_delta 流出（partial 省略，逼 loop 自己累积）；toolUse 一次到位。 */
function scriptedStream(script: Array<{ text: string } | { calls: ToolCall[] } | { abort: true }>) {
  const streamFn: StreamFn = () => {
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if ("text" in next) {
        const final: AssistantMessage = { ...base(), content: [{ type: "text", text: next.text }], stopReason: "stop" };
        stream.push({ type: "start", partial: { ...base(), content: [], stopReason: "stop" } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...base(), content: [{ type: "text", text: "" }], stopReason: "stop" } });
        for (const ch of next.text) stream.push({ type: "text_delta", contentIndex: 0, delta: ch });
        stream.push({ type: "done", reason: "stop", message: final });
      } else if ("calls" in next) {
        const final: AssistantMessage = { ...base(), content: next.calls, stopReason: "toolUse" };
        stream.push({ type: "start", partial: { ...base(), content: [], stopReason: "toolUse" } });
        stream.push({ type: "done", reason: "toolUse", message: final });
      } else {
        const final: AssistantMessage = { ...base(), content: [{ type: "text", text: "" }], stopReason: "aborted", errorMessage: "aborted" };
        stream.push({ type: "start", partial: { ...base(), content: [], stopReason: "aborted" } });
        stream.push({ type: "error", reason: "aborted", error: final });
      }
    });
    return stream;
  };
  return streamFn;
}

function makeHarness(streamFn: StreamFn, tools: RuntimeTool[]) {
  return new CoreAgentHarness({
    env: {} as ExecutionEnv, session: new Session(new InMemorySessionStorage()), tools, model: MODEL, systemPrompt: "t",
    runtime: { streamSimple: streamFn, completeSimple: async () => { throw new Error("unused"); } },
  });
}

const echo: RuntimeTool = {
  name: "echo", label: "Echo", description: "回显", readOnly: true, parameters: Type.Object({ q: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: `echoed ${(p as { q: string }).q}` }], details: undefined }),
};

async function collect(streamFn: StreamFn, tools: RuntimeTool[], prompt: string) {
  const lines: StreamLine[] = [];
  const harness = makeHarness(streamFn, tools);
  harness.subscribe(createStreamLineAdapter((l) => lines.push(l)));
  await harness.prompt(prompt);
  const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
  return { lines, bubbles };
}

describe("判据④：harness 事件 → StreamLine → 现有 reducer", () => {
  it("纯文本回复：delta 为累计值、逐字增长、final 收尾成一个 assistant 气泡", async () => {
    const { lines, bubbles } = await collect(scriptedStream([{ text: "你好世界" }]), [], "hi");
    const deltas = lines.filter((l): l is Extract<StreamLine, { type: "delta" }> => l.type === "delta").map((l) => l.text);
    expect(deltas).toEqual(["你", "你好", "你好世", "你好世界"]); // 累计值，不是碎片
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "你好世界" });
    expect(bubbles).toEqual([{ kind: "assistant", text: "你好世界" }]);
  });

  it("工具调用一轮：tool → tool-result → tool-end → 新段 delta → final；气泡与 gateway 时代一致", async () => {
    const call: ToolCall = { type: "toolCall", id: "c1", name: "echo", arguments: { q: "hi" } };
    const { lines, bubbles } = await collect(scriptedStream([{ calls: [call] }, { text: "结果是 echoed hi" }]), [echo], "回显 hi");
    const types = lines.map((l) => l.type);
    expect(types.slice(0, 3)).toEqual(["tool", "tool-result", "tool-end"]);
    expect(types.slice(3, -1).every((t) => t === "delta")).toBe(true);
    expect(types[types.length - 1]).toBe("final");
    const tool = lines[0] as Extract<StreamLine, { type: "tool" }>;
    expect(tool).toEqual({ type: "tool", name: "echo", id: "c1", input: { q: "hi" } });
    expect(lines[1]).toEqual({ type: "tool-result", id: "c1", result: "echoed hi" });
    expect(lines[lines.length - 1]).toEqual({ type: "final", text: "结果是 echoed hi" }); // final 只含最后一段
    expect(bubbles).toEqual([
      { kind: "tool", name: "echo", id: "c1", done: true, input: { q: "hi" }, result: "echoed hi" },
      { kind: "assistant", text: "结果是 echoed hi" },
    ]);
  });

  it("工具前有文本：段边界正确——前段文本在工具气泡前定格，后段独立", async () => {
    const call: ToolCall = { type: "toolCall", id: "c2", name: "echo", arguments: { q: "x" } };
    // 第一条既有文本又有 toolUse：先流文本再给 toolUse 的最终消息
    const streamFn: StreamFn = (() => {
      let n = 0;
      return () => {
        n++;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (n === 1) {
            stream.push({ type: "start", partial: { ...base(), content: [], stopReason: "toolUse" } });
            stream.push({ type: "text_start", contentIndex: 0, partial: { ...base(), content: [{ type: "text", text: "" }], stopReason: "toolUse" } });
            for (const ch of "我来查") stream.push({ type: "text_delta", contentIndex: 0, delta: ch });
            stream.push({ type: "done", reason: "toolUse", message: { ...base(), content: [{ type: "text", text: "我来查" }, call], stopReason: "toolUse" } });
          } else {
            stream.push({ type: "start", partial: { ...base(), content: [], stopReason: "stop" } });
            stream.push({ type: "done", reason: "stop", message: { ...base(), content: [{ type: "text", text: "查到了" }], stopReason: "stop" } });
          }
        });
        return stream;
      };
    })();
    const { bubbles } = await collect(streamFn, [echo], "查");
    expect(bubbles).toEqual([
      { kind: "assistant", text: "我来查" },
      { kind: "tool", name: "echo", id: "c2", done: true, input: { q: "x" }, result: "echoed x" },
      { kind: "assistant", text: "查到了" },
    ]);
  });

  it("工具被 tool_call 钩子 block：tool-result 带 isError，前端照常渲染为出错的工具气泡", async () => {
    const call: ToolCall = { type: "toolCall", id: "c3", name: "echo", arguments: { q: "no" } };
    const lines: StreamLine[] = [];
    const harness = makeHarness(scriptedStream([{ calls: [call] }, { text: "好吧" }]), [echo]);
    harness.on("tool_call", () => ({ block: true, reason: "用户拒绝" }));
    harness.subscribe(createStreamLineAdapter((l) => lines.push(l)));
    await harness.prompt("x");
    const result = lines.find((l) => l.type === "tool-result") as Extract<StreamLine, { type: "tool-result" }>;
    expect(result.isError).toBe(true);
    expect(result.result).toContain("用户拒绝");
    const bubbles = lines.reduce<Bubble[]>((acc, l) => applyStreamLine(acc, l), []);
    expect(bubbles[0]).toMatchObject({ kind: "tool", id: "c3", done: true, isError: true });
  });

  it("模型侧中止：aborted 行 + 「已中止」提示气泡", async () => {
    const { lines, bubbles } = await collect(scriptedStream([{ abort: true }]), [], "x");
    expect(lines[lines.length - 1]).toEqual({ type: "aborted", text: "" });
    expect(bubbles[bubbles.length - 1]).toEqual({ kind: "notice", text: "已中止" });
  });
});
