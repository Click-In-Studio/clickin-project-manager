import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionPreparation,
} from "../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { compactionSettingsFor, estimateRequestBudget } from "@/lib/agent/runtime/context-budget";

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
    expect(withTransient.outputReserveTokens).toBe(200);
    expect(withTransient.pressureThreshold).toBe(700);
    expect(withTransient.pressured).toBe(true);
  });

  it("摘要余量和近期原文按有效窗口与本次输出预算派生，不沿用 Harness 默认值", () => {
    expect(compactionSettingsFor(MODEL, { maxTokens: 300 })).toEqual({
      enabled: true,
      reserveTokens: 200,
      keepRecentTokens: 180,
    });
    expect(compactionSettingsFor(MODEL, { maxTokens: 300 }, true)).toEqual({
      enabled: true,
      reserveTokens: 200,
      keepRecentTokens: 0,
    });
    expect(compactionSettingsFor({ ...MODEL, contextTokens: 2_000 }, { maxTokens: 300 }).keepRecentTokens).toBe(200);
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

  it("剧本、Wiki 与表格工具结果完整进入摘要请求，中段和重读定位不做通用截断", async () => {
    const toolCallId = "call-read-business-content";
    const messages: AgentMessage[] = [
      {
        ...completion("", "toolUse"),
        content: [{ type: "toolCall", id: toolCallId, name: "production.wiki_read", arguments: { wikiId: "wiki-1" } }],
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "production.wiki_read",
        content: [{ type: "text", text: [
          "开头说明",
          "[b:block-middle] 剧本中段关键调度",
          "wiki:/__cm__/wiki/wiki-1#block-42",
          "表格中段：第37行预算=65000",
          "续读定位：p12.8 / ¶41",
          "结尾说明",
        ].join("\n") }],
        isError: false,
        timestamp: 1,
      },
    ];
    let sent: Context | undefined;
    const result = await compact(
      { ...preparation(), messagesToSummarize: messages },
      { systemPrompt: "原系统指令", tools: [] },
      MODEL,
      "test-key",
      undefined,
      undefined,
      undefined,
      "low",
      undefined,
      { completeSimple: async (_model, context) => {
        sent = context;
        return completion("保留中段事实与重读定位。", "stop");
      } },
    );
    expect(result.ok).toBe(true);
    const request = JSON.stringify(sent?.messages);
    expect(request).toContain("[b:block-middle]");
    expect(request).toContain("第37行预算=65000");
    expect(request).toContain("p12.8 / ¶41");
    expect(request).toContain("structured context checkpoint");
  });
});
