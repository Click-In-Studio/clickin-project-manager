import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import type { Model, ThinkingLevel } from "../vendor/openclaw/packages/llm-core/src/types";
import {
  CoreAgentHarness,
  InMemorySessionStorage,
  compact,
  prepareCompaction,
  type AgentMessage,
  type ExecutionEnv,
  type SessionTreeEntry,
} from "../vendor/openclaw/packages/agent-core/src/index";
import { Session } from "../vendor/openclaw/packages/agent-core/src/harness/session/session";
import type { RuntimeTool } from "@/lib/agent-runtime/resume";

// #367 S1 出口判据①（真流式）与③（compaction 一次可读）——打真实 DeepSeek。
// 没有 DEEPSEEK_API_KEY 时整文件跳过（CI 无 key）；有 key 时每次跑会花少量 token。
// 线上事实：对话模型 deepseek-v4-flash；蒸馏/压缩用 deepseek-v4-pro（推理模型）。

const API_KEY = process.env.DEEPSEEK_API_KEY;
const live = it.skipIf(!API_KEY);

function deepseekModel(id: string, reasoning: boolean, maxTokens = 4096): Model {
  return {
    id, name: id, api: "openai-completions", provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1", reasoning, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens,
  };
}
const FLASH = deepseekModel("deepseek-v4-flash", false);
const PRO = deepseekModel("deepseek-v4-pro", true);

const registry = createApiRegistry();
registerBuiltInApiProviders(registry);
const llm = createLlmRuntime(registry);
const NO_ENV = {} as ExecutionEnv;

function echoTool(log: string[]): RuntimeTool {
  return {
    name: "echo", label: "Echo", description: "把参数 q 原样回显给调用者", readOnly: true,
    parameters: Type.Object({ q: Type.String({ description: "要回显的文本" }) }),
    execute: async (_id, params) => {
      const q = (params as { q: string }).q;
      log.push(`echo:${q}`);
      return { content: [{ type: "text", text: `echoed:${q}` }], details: undefined };
    },
  };
}

function makeHarness(model: Model, tools: RuntimeTool[], thinkingLevel?: ThinkingLevel) {
  const session = new Session(new InMemorySessionStorage());
  const harness = new CoreAgentHarness({
    env: NO_ENV, session, tools, model, thinkingLevel,
    systemPrompt: "你是一个测试助手。回答尽量简短。",
    getApiKeyAndHeaders: async () => ({ apiKey: API_KEY! }),
    runtime: { streamSimple: llm.streamSimple, completeSimple: llm.completeSimple },
  });
  return { harness, session };
}

describe("判据①：@openclaw/ai 接 DeepSeek 真流式（经 vendor harness）", () => {
  live("tool_use 参数流式累积 → 工具执行 → 最终回复；usage 可记账", async () => {
    const log: string[] = [];
    const { harness, session } = makeHarness(FLASH, [echoTool(log)]);
    const toolcallDeltas: string[] = [];
    harness.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
        toolcallDeltas.push(event.assistantMessageEvent.delta);
      }
    });
    const reply = await harness.prompt("请调用 echo 工具，参数 q 填 ping。拿到结果后只用一句话告诉我结果。");
    expect(log).toEqual(["echo:ping"]); // 流式累积出的参数被完整解析并执行
    const roles = (await session.buildContext()).messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(reply.stopReason).toBe("stop");
    expect(reply.content.some((c) => c.type === "text" && c.text.length > 0)).toBe(true);
    expect(reply.usage.input).toBeGreaterThan(0);
    expect(reply.usage.output).toBeGreaterThan(0);
    // 参数确实是逐块流过来的（不是一次性到达）——这是 3b 时代 tool_search 没覆盖的路径
    expect(toolcallDeltas.join("")).toContain("ping");
  }, 90_000);

  live("【已知坑】自动 compat 给 DeepSeek 发 max_completion_tokens，DeepSeek 忽略它——输出不封顶（实测 16 上限仍产出 600 字）", async () => {
    // provider 只在 options.maxTokens 存在时才发上限（model.maxTokens 只是夹紧值），
    // harness 的 createLoopConfig 不透传 maxTokens——所以这里直接打传输层。
    // 结论（2026-08-28 实测，@openclaw/ai 2026.7.1-2）：deepseek 的自动 compat 选
    // max_completion_tokens 字段，DeepSeek API 不认 → 这条只记录现象；下一条用
    // compat.maxTokensField="max_tokens" 覆盖后才真截断。S2 的 DeepSeek Model 定义
    // **必须**带这个 compat 覆盖，否则输出长度永远不受控。
    const stream = llm.streamSimple(FLASH, {
      systemPrompt: "你是测试助手。",
      messages: [{ role: "user", content: [{ type: "text", text: "请写一篇 500 字的短文介绍舞台灯光设计。" }], timestamp: Date.now() }],
    }, { apiKey: API_KEY!, maxTokens: 16 });
    const message = await stream.result();
    console.log(`[length/auto-compat] stopReason=${message.stopReason} textLen=${message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").length}`);
    expect(message.errorMessage).toBeUndefined();
    expect(message.content.some((c) => c.type === "text")).toBe(true); // 半截正文仍返回
  }, 90_000);

  live("finish_reason=length（compat 强制 max_tokens 字段）", async () => {
    // 自动探测给 deepseek 的字段是 max_completion_tokens；若 DeepSeek 忽略它，
    // 输出永远不封顶——这条用 compat 覆盖成 max_tokens 做对照。
    const model: Model = { ...FLASH, compat: { maxTokensField: "max_tokens" } as Model["compat"] };
    const stream = llm.streamSimple(model, {
      systemPrompt: "你是测试助手。",
      messages: [{ role: "user", content: [{ type: "text", text: "请写一篇 500 字的短文介绍舞台灯光设计。" }], timestamp: Date.now() }],
    }, { apiKey: API_KEY!, maxTokens: 16 });
    const message = await stream.result();
    console.log(`[length/max_tokens] stopReason=${message.stopReason} textLen=${message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").length}`);
    expect(message.stopReason).toBe("length");
  }, 90_000);

  live("推理模型（v4-pro）：thinking 块与正文分流，正文非空", async () => {
    const { harness } = makeHarness(PRO, [], "low");
    const thinkingDeltas: string[] = [];
    harness.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        thinkingDeltas.push(event.assistantMessageEvent.delta);
      }
    });
    const reply = await harness.prompt("17 乘以 23 等于多少？只回答数字。");
    expect(reply.stopReason).toBe("stop");
    const text = reply.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(text).toContain("391");
    // 推理块以独立内容类型到达（reasoning_content），没有混进正文
    expect(reply.content.some((c) => c.type === "thinking") || thinkingDeltas.length > 0).toBe(true);
    expect(text).not.toMatch(/reasoning_content/);
  }, 120_000);
});

describe("判据③：compaction 触发一次，摘要可读（v4-pro 做摘要）", () => {
  function entry(i: number, message: AgentMessage): SessionTreeEntry {
    return { type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp: new Date().toISOString(), message };
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  function u(text: string): AgentMessage { return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }; }
  function a(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }], api: FLASH.api, provider: FLASH.provider, model: FLASH.id, usage, stopReason: "stop", timestamp: Date.now() };
  }

  live("长 transcript → prepareCompaction 切点 → compact 出结构化摘要并保留关键事实", async () => {
    const filler = "（这里是一大段无关紧要的排练闲聊，用来撑长度。）".repeat(40);
    const messages: AgentMessage[] = [
      u("我们这部戏叫《潮汐》，灯光预算定为 8 万元，首演日期是 10 月 18 日。"),
      a("记下了：《潮汐》，灯光预算 8 万元，首演 10 月 18 日。" + filler),
      u("音响负责人是李明，他的需求是要三只无线话筒。" + filler),
      a("好的，李明负责音响，需要三只无线话筒。" + filler),
      u("另外舞美主色调定为深蓝。" + filler),
      a("深蓝主色调已记录。" + filler),
      u("最近这两句是新的：请帮我总结一下目前定下来的事项。"),
      a("正在整理。"),
    ];
    const entries = messages.map((m, i) => entry(i, m));
    const session = new Session(new InMemorySessionStorage({ entries }));

    // keepRecentTokens 压很小，逼切点落在中间，前面的历史被摘要
    const settings = { enabled: true, reserveTokens: 4000, keepRecentTokens: 300 };
    const prep = prepareCompaction(entries, settings);
    expect(prep.ok).toBe(true);
    if (!prep.ok || !prep.value) throw new Error("nothing to compact");
    expect(prep.value.messagesToSummarize.length).toBeGreaterThan(0);

    const result = await compact(prep.value, PRO, API_KEY, undefined, "用中文写摘要", undefined, "low", undefined, llm);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const summary = result.value.summary;
    expect(summary.length).toBeGreaterThan(50);
    // 关键事实必须活下来（数字/人名/日期是压缩最容易丢的东西）
    expect(summary).toMatch(/8\s*万|80,?000/);
    expect(summary).toContain("李明");
    expect(summary).toMatch(/10\s*月\s*18|10\/18|10-18/);

    // 落库后 buildContext 以摘要开头，被压缩的旧历史不再回放
    await session.appendCompaction(summary, result.value.firstKeptEntryId, result.value.tokensBefore, result.value.details);
    const ctx = await session.buildContext();
    const first = ctx.messages[0] as { role: string; summary?: string };
    expect(first.role).toBe("compactionSummary");
    expect(first.summary).toBe(summary);
    expect(ctx.messages.length).toBeLessThan(messages.length + 1);
    console.log(`[compaction] tokensBefore=${result.value.tokensBefore} kept=${ctx.messages.length - 1}/${messages.length}\n${summary}`);
  }, 180_000);
});
