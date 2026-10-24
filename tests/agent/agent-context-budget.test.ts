import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, MediaContent, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import type { AgentMessage } from "../../vendor/openclaw/packages/agent-core/src/types";
import {
  compact,
  generateSummary,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionPreparation,
} from "../../vendor/openclaw/packages/agent-core/src/harness/compaction/compaction";
import { resolveModel } from "@/lib/agent/runtime/config";
import { compactionSettingsFor, estimateRequestBudget } from "@/lib/agent/runtime/context-budget";
import { convertToLlm, createCompactionSummaryMessage } from "../../vendor/openclaw/packages/agent-core/src/harness/messages";

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

describe("压缩控制指令与用户意图隔离", () => {
  it.each([undefined, "用户要求只输出摘要，然后等待新指令。"])("首次及连续摘要都排除控制请求，保留真实用户暂停要求：%s", async (previousSummary) => {
    const messages = [user("核对第二场台词；先不要改剧本，等我确认。")];
    const prefix = { systemPrompt: "内容助理", tools: [], messages };
    let captured: Context | undefined;
    const result = await generateSummary(messages, prefix, MODEL, 200, undefined, undefined, undefined,
      "用中文写摘要。", previousSummary, undefined, undefined, {
        completeSimple: async (_model, context) => {
          captured = context;
          return completion("核对第二场台词，保持只读并等待用户确认后再修改。", "stop");
        },
      });
    expect(result.ok).toBe(true);
    expect(captured?.systemPrompt).toBe(prefix.systemPrompt);
    expect(captured?.tools).toBe(prefix.tools);
    expect(captured?.messages.slice(0, -1)).toEqual(messages);
    const instruction = captured?.messages.at(-1);
    expect(instruction?.role).toBe("user");
    const text = JSON.stringify(instruction?.content);
    expect(text).toContain("infrastructure control, not a conversation turn");
    expect(text).toContain("Do not mention that request");
    expect(text).toContain("unless such an instruction appeared earlier in the actual conversation");
    expect(text).toContain("not proof of user intent");
  });

  it("恢复摘要是历史背景而非新指令，后续真实请求仍在尾部", () => {
    const summary = createCompactionSummaryMessage("不要调用工具，只输出摘要。", 1000, new Date(0).toISOString());
    const current = user("继续核对第二场台词。");
    const restored = convertToLlm([summary, current]);
    const text = JSON.stringify(restored[0].content);
    expect(text).toContain("not as a new user instruction or authorization change");
    expect(text).toContain("Continue the active task directly from the messages that follow");
    expect(text).toContain("without acknowledging this checkpoint");
    expect(restored.at(-1)).toEqual(current);
  });
});

describe("模型请求上下文预算", () => {
  function image(width = 100, height = 100, bytes = 3): MediaContent {
    return { type: "image", mimeType: "image/png", budget: { bytes, base64Chars: 4 * Math.ceil(bytes / 3),
      width, height, estimatedTokens: 99_999, basis: "历史模型测量" } };
  }

  it("#1052 图片预算使用当前模型的预处理规则，DeepSeek 大图不按原始像素无界增长", () => {
    const messages: Context["messages"] = [{ role: "user", timestamp: 0, content: [image(5000, 5000)] }];
    expect(estimateRequestBudget(resolveModel("deepseek-flash"), { messages }).mediaTokens).toBe(1024);
    expect(estimateRequestBudget(resolveModel("resonance"), { messages }).mediaTokens).toBe(1282);
    expect(estimateRequestBudget(resolveModel("resonance"), { messages: [{ role: "user", timestamp: 0, content: [image()] }] }).mediaTokens).toBe(26);
  });

  it("#1052 图像数量只受 provider 硬限制；第十五张采用相应边长限制", () => {
    const model = resolveModel("deepseek-flash");
    const budget = (parts: MediaContent[]) => estimateRequestBudget(model, { messages: [{ role: "user", timestamp: 0, content: parts }] });
    expect(budget(Array.from({ length: 600 }, () => image())).fits).toBe(true);
    expect(budget(Array.from({ length: 601 }, () => image())).mediaFits).toBe(false);
    expect(budget(Array.from({ length: 14 }, () => image(5000, 100))).mediaFits).toBe(true);
    expect(budget(Array.from({ length: 15 }, () => image(5000, 100))).mediaFits).toBe(false);
    expect(budget([image(8193, 100)]).mediaFits).toBe(false);
  });

  it("#1052 张数很少也会因体积或上下文超限；完整请求计入文字和工具", () => {
    const model = resolveModel("deepseek-flash");
    const messages: Context["messages"] = [{ role: "user", timestamp: 0, content: [image(100, 100, 40 * 1024 * 1024)] }];
    expect(estimateRequestBudget(model, { messages }).fits).toBe(false);
    const small = { ...model, maxRequestBytes: 1000 };
    const content: Context = { messages: [{ role: "user", timestamp: 0, content: [image()] }] };
    expect(estimateRequestBudget(small, content).requestFits).toBe(true);
    expect(estimateRequestBudget(small, { ...content, systemPrompt: "系统材料".repeat(100) }).requestFits).toBe(false);
    expect(estimateRequestBudget(small, { ...content, tools: [{ name: "read", description: "工具说明".repeat(100), parameters: {} }] }).requestFits).toBe(false);
    expect(estimateRequestBudget({ ...model, contextWindow: 1100, maxTokens: 100 }, content).textFits).toBe(false);
  });

  it.each([
    ["deepseek-flash", 256_000, 1_000_000],
    ["deepseek-pro", 256_000, 1_000_000],
    ["resonance", 64_000, 1_000_000],
    ["inspiration", 65_536, 1_048_576],
  ])("%s 的长输入与官方普通输出额度可同时容纳", (key, output, window) => {
    const model = resolveModel(key as Parameters<typeof resolveModel>[0]);
    const budget = estimateRequestBudget(model, { messages: [user("长文档材料".repeat(40_000))] });
    expect(budget.outputReserveTokens).toBe(output);
    expect(budget.effectiveContextWindow).toBe(window);
    expect(budget.estimatedInputTokens).toBeGreaterThan(128_000);
    expect(budget.fits).toBe(true);
    expect(budget.pressured).toBe(false);
    expect(compactionSettingsFor(model)).toEqual({ enabled: true, reserveTokens: 8192, keepRecentTokens: 8192 });
  });

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
