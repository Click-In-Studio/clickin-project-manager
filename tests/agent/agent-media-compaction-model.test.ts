import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "@/lib/agent/runtime/config";
import { selectMediaCompactionModel } from "@/lib/agent/runtime/media-compaction-model";
import type { AssistantMessage, Context } from "../../vendor/openclaw/packages/llm-core/src/types";

const state = vi.hoisted(() => ({ available: true }));
vi.mock("@/lib/agent/runtime/model-settings-db", () => ({ modelCatalog: async () => [
  { key: "inspiration", available: state.available }, { key: "resonance", available: true },
] }));
vi.mock("@/lib/agent/runtime/config", async (original) => ({
  ...await original<typeof import("@/lib/agent/runtime/config")>(),
  modelApiKey: (model: { provider: string }) => `${model.provider}-own-key`,
}));

const source = resolveModel("inspiration");
const target = resolveModel("deepseek-pro");
const context: Context = { messages: [{ role: "user", timestamp: 1, content: [{
  type: "audio", mimeType: "audio/wav", attachmentId: "old-audio",
  budget: { bytes: 8 * 1024 * 1024, base64Chars: 4 * Math.ceil(8 * 1024 * 1024 / 3),
    estimatedTokens: 1200, durationSeconds: 1, basis: "历史实测" },
}] }] };
const processed = (model = source, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 2,
  content: [{ type: "text", text: "已读取录音" }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
afterEach(() => { state.available = true; });

describe("#967 摘要只回到实际承载过证据的合格模型", () => {
  it("跳过预算不足的近期模型，历史来源使用自己的 provider 密钥", async () => {
    const selected = await selectMediaCompactionModel([processed(), processed(resolveModel("resonance"))], context, target, "u", null);
    expect(selected.model.id).toBe(source.id);
    expect(selected.apiKey).toBe(`${source.provider}-own-key`);
    expect(selected.apiKey).not.toBe(`${target.provider}-own-key`);
  });

  it("历史模型失去当前资格后拒绝，不借用无关可用模型", async () => {
    state.available = false;
    await expect(selectMediaCompactionModel([processed()], context, target, "u", null))
      .rejects.toThrow("没有仍可用、有资格");
  });

  it.each(["error", "aborted"] as const)("历史请求 %s 不算成功承载过证据", async (reason) => {
    await expect(selectMediaCompactionModel([processed(source, reason)], context, target, "u", null))
      .rejects.toThrow("未提交摘要");
  });
});
