import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionPreparation,
} from "../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { estimateRequestBudget } from "@/lib/agent/runtime/context-budget";

const MODEL: Model = {
  id: "budget-test",
  name: "budget-test",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  contextTokens: 900,
  maxTokens: 200,
};

function user(text: string): Context["messages"][number] {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("模型请求上下文预算", () => {
  it("完整预算覆盖 system、工具、临时消息、有效窗口与输出预留", () => {
    const base = estimateRequestBudget(MODEL, { messages: [user("任务")] });
    const withSystem = estimateRequestBudget(MODEL, {
      systemPrompt: "系统约束".repeat(100),
      messages: [user("任务")],
    });
    const withTool = estimateRequestBudget(MODEL, {
      systemPrompt: "系统约束".repeat(100),
      tools: [{ name: "large_tool", description: "工具说明".repeat(100), parameters: {} }] as Context["tools"],
      messages: [user("任务")],
    });
    const withTransient = estimateRequestBudget(MODEL, {
      systemPrompt: "系统约束".repeat(100),
      tools: withTool.toolTokens ? ([{ name: "large_tool", description: "工具说明".repeat(100), parameters: {} }] as Context["tools"]) : [],
      messages: [user("临时召回".repeat(200)), user("任务")],
    }, { maxTokens: 300 });

    expect(withSystem.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens);
    expect(withTool.estimatedInputTokens).toBeGreaterThan(withSystem.estimatedInputTokens);
    expect(withTransient.estimatedInputTokens).toBeGreaterThan(withTool.estimatedInputTokens);
    expect(withTransient.effectiveContextWindow).toBe(900);
    expect(withTransient.outputReserveTokens).toBe(300);
    expect(withTransient.pressureThreshold).toBe(600);
    expect(withTransient.pressured).toBe(true);
  });
});

function preparation(text = "历史".repeat(4_000)): CompactionPreparation {
  return {
    firstKeptEntryId: "kept",
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 8_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: DEFAULT_COMPACTION_SETTINGS,
  };
}

function completion(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    stopReason,
    timestamp: 2,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("压缩结果护栏", () => {
  it.each([
    ["输出触顶", completion("截断摘要", "length"), "truncated"],
    ["空摘要", completion("", "stop"), "empty_summary"],
    ["摘要未缩短", completion("冗长".repeat(8_000), "stop"), "not_smaller"],
  ])("拒绝%s", async (_label, response, code) => {
    const result = await compact(
      preparation(),
      { systemPrompt: "原系统指令", tools: [] },
      MODEL,
      "test-key",
      undefined,
      undefined,
      undefined,
      "low",
      undefined,
      { completeSimple: async () => response },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});
