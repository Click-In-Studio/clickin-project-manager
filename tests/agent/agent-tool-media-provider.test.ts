import { afterEach, describe, expect, it, vi } from "vitest";
import { llmRuntime, resolveModel } from "@/lib/agent/runtime/config";
import type { Context, MediaContent, Model } from "../../vendor/openclaw/packages/llm-core/src/types";

type WireMessage = {
  role: string;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
};
type GooglePart = {
  inlineData?: { mimeType: string; data: string };
  functionResponse?: { name: string; parts?: GooglePart[] };
};
type Payload = {
  messages?: WireMessage[];
  contents?: Array<{ role: string; parts: GooglePart[] }>;
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function media(type: MediaContent["type"] = "image", index = 0): MediaContent {
  return { type, mimeType: { image: "image/png", audio: "audio/wav", video: "video/mp4", file: "application/pdf" }[type],
    data: Buffer.from(`media-${index}`).toString("base64"), assetId: `asset-${index}`,
    budget: { bytes: 7, base64Chars: 12, estimatedTokens: 1200, width: 1, height: 1, pages: 1, durationSeconds: 1, basis: "测试尺寸" } };
}

function batch(model: Model, results: MediaContent[][], prefix = "call"): Context["messages"] {
  return [
    { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      stopReason: "toolUse", timestamp: 1, usage,
      content: results.map((_, i) => ({ type: "toolCall", id: `${prefix}_${i}`, name: "read_media", arguments: {} })) },
    ...results.map((parts, i) => ({ role: "toolResult" as const, toolCallId: `${prefix}_${i}`, toolName: "read_media",
      isError: false, timestamp: 2, content: [{ type: "text" as const, text: `结果 ${prefix}_${i}` }, ...parts] })),
  ];
}

async function capture(model: Model, messages: Context["messages"]): Promise<Payload> {
  let body: Payload | undefined;
  const fetch = vi.fn(() => { throw new Error("请求不得联网"); });
  vi.stubGlobal("fetch", fetch);
  const reply = await llmRuntime().completeSimple(model, { messages,
    tools: [{ name: "read_media", description: "读取原件", parameters: { type: "object", properties: {} } }],
  }, { apiKey: "fixture-key", reasoning: "low", maxTokens: 100,
    onPayload: (payload) => { body = payload as Payload; throw new Error("请求体已捕获"); },
  });
  expect(reply.stopReason).toBe("error");
  expect(body).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(body)).not.toContain("clickin-media:");
  return body!;
}

function expectCompleteToolBatches(messages: WireMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      expect(pending.has(message.tool_call_id!), "工具结果必须对应本批调用").toBe(true);
      pending.delete(message.tool_call_id!);
    } else {
      expect([...pending], "同批工具结果收齐前不能插入其他角色消息").toEqual([]);
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  expect([...pending]).toEqual([]);
}

afterEach(() => vi.unstubAllGlobals());

describe("#1050 工具媒体的真实 SDK 请求顺序", () => {
  it.each(["deepseek-flash", "resonance"] as const)("%s：四个图片工具的响应连续，图片原件完整", async (key) => {
    const model = resolveModel(key);
    const pictures = Array.from({ length: 4 }, (_, i) => media("image", i));
    const payload = await capture(model, batch(model, pictures.map(picture => [picture])));
    expectCompleteToolBatches(payload.messages!);
    expect(payload.messages!.map(message => message.role)).toEqual(["assistant", "tool", "tool", "tool", "tool", "user"]);
    for (const picture of pictures) expect(JSON.stringify(payload)).toContain(`data:${picture.mimeType};base64,${picture.data}`);
  });

  it.each([false, true])("图片工具与纯文字工具混合，图片是否在最后：%s", async (last) => {
    const model = resolveModel("deepseek-flash");
    const results = last ? [[], [media()]] : [[media()], []];
    const payload = await capture(model, batch(model, results));
    expectCompleteToolBatches(payload.messages!);
    expect(payload.messages!.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
  });

  it("单工具多图与上一轮图片工具历史回放都保留各自批次", async () => {
    const model = resolveModel("deepseek-flash");
    const pictures = [media("image", 0), media("image", 1), media("image", 2)];
    const messages: Context["messages"] = [
      ...batch(model, [pictures.slice(0, 2)], "old"),
      { role: "user", timestamp: 3, content: "继续读取下一张" },
      ...batch(model, [[pictures[2]]], "new"),
    ];
    const before = JSON.stringify(messages);
    const payload = await capture(model, messages);
    expectCompleteToolBatches(payload.messages!);
    expect(payload.messages!.map(message => message.role)).toEqual(["assistant", "tool", "user", "user", "assistant", "tool", "user"]);
    for (const picture of pictures) expect(JSON.stringify(payload)).toContain(picture.data);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("Gemini 图片由 SDK 留在各自的 functionResponse 内", async () => {
    const model = resolveModel("inspiration");
    const pictures = Array.from({ length: 4 }, (_, i) => media("image", i));
    const payload = await capture(model, batch(model, pictures.map(picture => [picture])));
    expect(payload.contents).toHaveLength(2);
    const results = payload.contents![1].parts.map(part => part.functionResponse);
    expect(results).toHaveLength(4);
    results.forEach((result, i) => expect(result?.parts).toEqual([
      { inlineData: { mimeType: pictures[i].mimeType, data: pictures[i].data } },
    ]));
  });

  it.each(["audio", "video"] as const)("共鸣的图片、%s 与纯文字结果混合时不打断工具响应", async (kind) => {
    const model = resolveModel("resonance");
    const extra = media(kind, 1);
    const payload = await capture(model, batch(model, [[media(), extra], []]));
    expectCompleteToolBatches(payload.messages!);
    expect(JSON.stringify(payload)).toContain(extra.data);
    expect(JSON.stringify(payload)).toContain(kind === "audio" ? "input_audio" : "video_url");
  });

  it("Gemini 工具 PDF 延后发送，不拆散同批 functionResponse", async () => {
    const model = resolveModel("inspiration");
    const pdf = media("file", 1);
    const payload = await capture(model, batch(model, [[pdf], [media()]]));
    expect(payload.contents![1].parts.filter(part => part.functionResponse)).toHaveLength(2);
    expect(JSON.stringify(payload.contents!.slice(2))).toContain(pdf.data);
    expect(JSON.stringify(payload)).toContain("application/pdf");
  });
});
