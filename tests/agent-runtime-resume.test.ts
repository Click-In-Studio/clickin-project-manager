import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Model, StreamFn, ToolCall } from "../vendor/openclaw/packages/llm-core/src/types.js";
import {
  CoreAgentHarness,
  InMemorySessionStorage,
  type AgentMessage,
  type ExecutionEnv,
  type SessionTreeEntry,
} from "../vendor/openclaw/packages/agent-core/src/index.js";
// index.ts 同时经 harness/types 以 `export type` 重导出 Session，值导入要走原模块
import { Session } from "../vendor/openclaw/packages/agent-core/src/harness/session/session.js";
import { repairAndClassify, findPendingToolCalls, UNKNOWN_STATE_TOOL_RESULT, type RuntimeTool } from "@/lib/agent-runtime/resume";

// #367 S1 出口判据⑤：从持久化 transcript 冷启动一个中途 run（含 tool_use 无
// tool_result 的配对修复）能续跑。用脚本化假模型驱动 vendor 的真 harness，
// 三种中断点各一条；外加 tool_call 钩子 block 的审批门原语验证。

const MODEL: Model = {
  id: "fake-model",
  name: "fake",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
};

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantText(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() };
}
function assistantToolUse(calls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content: calls, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, stopReason: "toolUse", timestamp: Date.now() };
}

/** 脚本化假模型：每次调用弹出一条预设回复，并记录它看到的上下文。 */
function scriptedStream(script: AssistantMessage[]) {
  const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
  const streamFn: StreamFn = (_model, context) => {
    seen.push({ messages: context.messages, tools: (context.tools ?? []).map((t) => t.name) });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...next, content: [] } });
      stream.push({ type: "done", reason: next.stopReason as "stop" | "toolUse", message: next });
    });
    return stream;
  };
  return { streamFn, seen };
}

function makeTools(log: string[]): Map<string, RuntimeTool> {
  const echo: RuntimeTool = {
    name: "echo",
    label: "Echo",
    description: "只读回显",
    parameters: Type.Object({ q: Type.String() }),
    readOnly: true,
    execute: async (_id, params) => {
      log.push(`echo:${(params as { q: string }).q}`);
      return { content: [{ type: "text", text: `echoed ${(params as { q: string }).q}` }], details: undefined };
    },
  };
  const write: RuntimeTool = {
    name: "write_doc",
    label: "写文档",
    description: "有副作用的写工具",
    parameters: Type.Object({ title: Type.String() }),
    readOnly: false,
    execute: async (_id, params) => {
      log.push(`write:${(params as { title: string }).title}`);
      return { content: [{ type: "text", text: "written" }], details: undefined };
    },
  };
  return new Map([[echo.name, echo], [write.name, write]]);
}

function entriesFrom(messages: AgentMessage[]): SessionTreeEntry[] {
  return messages.map((message, i) => ({
    type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp: new Date().toISOString(), message,
  }));
}

// 我们的工具不碰文件系统/shell；harness 只是持有 env 传给 systemPrompt 回调。
const NO_ENV = {} as ExecutionEnv;

function makeHarness(session: Session, tools: Map<string, RuntimeTool>, streamFn: StreamFn) {
  return new CoreAgentHarness({
    env: NO_ENV,
    session,
    tools: [...tools.values()],
    systemPrompt: "你是测试助手",
    model: MODEL,
    runtime: { streamSimple: streamFn, completeSimple: async () => { throw new Error("not used"); } },
  });
}

async function roles(session: Session): Promise<string[]> {
  return (await session.buildContext()).messages.map((m) => m.role);
}

describe("判据⑤：从持久化 transcript 冷启动中途 run", () => {
  it("A. 模型调用进行中崩溃（transcript 以 user 结尾）→ 直接续跑，模型调用被重发", async () => {
    const session = new Session(new InMemorySessionStorage({ entries: entriesFrom([
      { role: "user", content: [{ type: "text", text: "你好" }], timestamp: Date.now() },
    ]) }));
    const log: string[] = [];
    const tools = makeTools(log);
    const { streamFn, seen } = scriptedStream([assistantText("重启后重发的回答")]);

    const decision = await repairAndClassify(session, tools);
    expect(decision).toEqual({ kind: "continue", repaired: [] });

    const harness = makeHarness(session, tools, streamFn);
    const reply = await harness.continueTurn();
    expect(reply.content).toEqual([{ type: "text", text: "重启后重发的回答" }]);
    expect(await roles(session)).toEqual(["user", "assistant"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].messages).toHaveLength(1); // 模型看到的是原 transcript，没有多出用户消息
  });

  it("B. 只读工具执行中崩溃（assistant toolUse 无 toolResult）→ 重跑工具补真结果再续跑", async () => {
    const call: ToolCall = { type: "toolCall", id: "call_1", name: "echo", arguments: { q: "ping" } };
    const session = new Session(new InMemorySessionStorage({ entries: entriesFrom([
      { role: "user", content: [{ type: "text", text: "回显 ping" }], timestamp: Date.now() },
      assistantToolUse([call]),
    ]) }));
    const log: string[] = [];
    const tools = makeTools(log);
    const { streamFn, seen } = scriptedStream([assistantText("工具结果是 echoed ping")]);

    expect(findPendingToolCalls((await session.buildContext()).messages).map((c) => c.id)).toEqual(["call_1"]);
    const decision = await repairAndClassify(session, tools);
    expect(decision).toEqual({ kind: "continue", repaired: [{ toolCallId: "call_1", toolName: "echo", action: "re-executed" }] });
    expect(log).toEqual(["echo:ping"]); // 只读工具被真实重跑
    expect(await roles(session)).toEqual(["user", "assistant", "toolResult"]);

    const harness = makeHarness(session, tools, streamFn);
    await harness.continueTurn();
    expect(await roles(session)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const seenLast = seen[0].messages[seen[0].messages.length - 1] as { role: string; content: Array<{ text?: string }> };
    expect(seenLast.role).toBe("toolResult");
    expect(seenLast.content[0]?.text).toBe("echoed ping");
  });

  it("C. 写工具执行中崩溃 → 不盲重放，补「状态未知」错误结果交给模型", async () => {
    const call: ToolCall = { type: "toolCall", id: "call_w", name: "write_doc", arguments: { title: "会议纪要" } };
    const session = new Session(new InMemorySessionStorage({ entries: entriesFrom([
      { role: "user", content: [{ type: "text", text: "建一篇会议纪要" }], timestamp: Date.now() },
      assistantToolUse([call]),
    ]) }));
    const log: string[] = [];
    const tools = makeTools(log);
    const { streamFn, seen } = scriptedStream([assistantText("我先查一下是否已创建")]);

    const decision = await repairAndClassify(session, tools);
    expect(decision).toEqual({ kind: "continue", repaired: [{ toolCallId: "call_w", toolName: "write_doc", action: "unknown-state" }] });
    expect(log).toEqual([]); // 写工具绝不重跑

    const harness = makeHarness(session, tools, streamFn);
    await harness.continueTurn();
    const seenLast = seen[0].messages[seen[0].messages.length - 1] as { role: string; isError: boolean; content: Array<{ text?: string }> };
    expect(seenLast.role).toBe("toolResult");
    expect(seenLast.isError).toBe(true);
    expect(seenLast.content[0]?.text).toBe(UNKNOWN_STATE_TOOL_RESULT);
  });

  it("D. assistant 已收尾 → idle，不动 transcript、不调模型", async () => {
    const session = new Session(new InMemorySessionStorage({ entries: entriesFrom([
      { role: "user", content: [{ type: "text", text: "你好" }], timestamp: Date.now() },
      assistantText("已回复"),
    ]) }));
    const tools = makeTools([]);
    const decision = await repairAndClassify(session, tools);
    expect(decision).toEqual({ kind: "idle", reason: "assistant-finished" });
    expect(await roles(session)).toEqual(["user", "assistant"]);
  });

  it("E. 空 transcript → idle；continueTurn 拒绝 assistant 结尾的 transcript", async () => {
    const empty = new Session(new InMemorySessionStorage());
    expect(await repairAndClassify(empty, makeTools([]))).toEqual({ kind: "idle", reason: "empty" });

    const finished = new Session(new InMemorySessionStorage({ entries: entriesFrom([
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() },
      assistantText("done"),
    ]) }));
    const harness = makeHarness(finished, makeTools([]), scriptedStream([]).streamFn);
    await expect(harness.continueTurn()).rejects.toThrow(/ends with an assistant message/);
  });
});

describe("harness 常规路径与审批门原语", () => {
  it("prompt → toolUse → 工具执行 → 最终回复，每步都落进 session", async () => {
    const session = new Session(new InMemorySessionStorage());
    const log: string[] = [];
    const tools = makeTools(log);
    const call: ToolCall = { type: "toolCall", id: "c1", name: "echo", arguments: { q: "hi" } };
    const { streamFn } = scriptedStream([assistantToolUse([call]), assistantText("完成")]);
    const harness = makeHarness(session, tools, streamFn);
    const reply = await harness.prompt("回显 hi");
    expect(reply.content).toEqual([{ type: "text", text: "完成" }]);
    expect(log).toEqual(["echo:hi"]);
    expect(await roles(session)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("tool_call 钩子 block → 工具不执行，模型收到带理由的错误结果（审批拒绝的形态）", async () => {
    const session = new Session(new InMemorySessionStorage());
    const log: string[] = [];
    const tools = makeTools(log);
    const call: ToolCall = { type: "toolCall", id: "c2", name: "write_doc", arguments: { title: "t" } };
    const { streamFn, seen } = scriptedStream([assistantToolUse([call]), assistantText("好的，不写了")]);
    const harness = makeHarness(session, tools, streamFn);
    harness.on("tool_call", (event) =>
      event.toolName === "write_doc" ? { block: true, reason: "用户拒绝：先别建" } : undefined,
    );
    await harness.prompt("建文档");
    expect(log).toEqual([]);
    const toolResult = seen[1].messages[seen[1].messages.length - 1] as { role: string; isError: boolean; content: Array<{ text?: string }> };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain("用户拒绝：先别建");
  });
});
