import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredModels,
  hiddenModelCandidates,
  modelApiKey,
  llmRuntime,
  resolveModel,
  validateModelSelection,
} from "@/lib/agent/runtime/config";
import type { MediaContent } from "../../vendor/openclaw/packages/llm-core/src/types";
const media = (type: MediaContent["type"], mimeType: string): MediaContent => ({
  type,
  mimeType,
  data: "AQID",
  attachmentId: "a",
  source: { kind: "attachment", sha256: "a".repeat(64) },
  budget: {
    bytes: 3,
    base64Chars: 4,
    estimatedTokens: 1200,
    basis: "测试尺寸",
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("模型请求协议与目录", () => {
  it("隐藏调用登记跨厂商真实模型，共用百炼凭据但不出现在聊天选择器", () => {
    vi.stubEnv("EMBEDDING_API_KEY", "test-qwen-key");
    const models = hiddenModelCandidates();
    expect(models.map(model => model.id)).toEqual(["deepseek-flash", "qwen3.8-flash"]);
    expect(models.map(model => model.provider)).toEqual(["deepseek", "qwen"]);
    expect(modelApiKey(models[1])).toBe("test-qwen-key");
    expect(configuredModels().map(model => model.key)).toEqual(["deepseek-flash", "deepseek-pro", "resonance", "inspiration"]);
  });
  it("只登记已实现的模态与思考档，别名不改变真实 API id", () => {
    expect(resolveModel("resonance").id).toBe("qwen3.8-omni-flash");
    expect(resolveModel("inspiration").id).toBe("gemini-3.8-flash");
    expect(
      configuredModels().find((item) => item.key === "deepseek-pro")!.input,
    ).toEqual(["text"]);
    expect(() =>
      validateModelSelection({
        modelKey: "inspiration",
        thinkingLevel: "off",
        disabledSubagentModels: [],
      }),
    ).toThrow();
    expect(() =>
      validateModelSelection({
        modelKey: "unknown",
        thinkingLevel: "low",
        disabledSubagentModels: [],
      }),
    ).toThrow();
  });
  it("共鸣的真实 SDK 序列化音频、工具定义及思考参数，保留用量", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        const data = {
          id: "test",
          choices: [
            { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
        return new Response(
          `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const model = resolveModel("resonance");
    const result = await llmRuntime().completeSimple(
      model,
      {
        systemPrompt: "服务端系统前缀",
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: [
              { type: "text", text: "听音频" },
              media("audio", "audio/wav"),
            ],
          },
        ],
        tools: [
          {
            name: "echo",
            description: "回显",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {
        apiKey: "test",
        reasoning: "low",
        maxTokens: 100,
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(body).toMatchObject({
      model: "qwen3.8-omni-flash",
      enable_thinking: true,
      reasoning_effort: "low",
      max_tokens: 100,
    });
    expect(JSON.stringify(body.messages)).toContain('"input_audio"');
    expect(JSON.stringify(body.messages)).toContain("data:;base64,AQID");
    expect((body.messages as Array<{ role: string }>)[0].role).toBe("system");
    expect(result.usage.input).toBe(10);
  });
  it("灵光的真实 Google SDK 保留原 PDF 与工具媒体，媒体没有被转成标记文本", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        body = String(init?.body);
        const data = {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "已读" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            totalTokenCount: 12,
          },
        };
        return new Response(`data: ${JSON.stringify(data)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const result = await llmRuntime().completeSimple(
      resolveModel("inspiration"),
      {
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: [media("file", "application/pdf")],
          },
        ],
      },
      {
        apiKey: "test",
        reasoning: "low",
        maxTokens: 100,
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(result.stopReason).toBe("stop");
    expect(body).toContain("application/pdf");
    expect(body).toContain("AQID");
    expect(body).not.toContain("clickin-media:");
  });
});
