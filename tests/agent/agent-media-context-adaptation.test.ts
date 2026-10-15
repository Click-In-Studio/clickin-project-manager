import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { InMemorySessionStorage } from "../../vendor/openclaw/packages/agent-core/src/index";
import { convertToLlm } from "../../vendor/openclaw/packages/agent-core/src/harness/messages";
import type { AssistantMessage, MediaContent, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import { resolveModel } from "@/lib/agent/runtime/config";
import { compactRequestContext } from "@/lib/agent/runtime/request-compaction";
import { estimateRequestBudget } from "@/lib/agent/runtime/context-budget";
import { restoreModelMedia, attachmentReadNeeded } from "@/lib/agent/runtime/model-media-state";
import { durableMediaEntry } from "@/lib/agent/runtime/media-transcript";

const state = vi.hoisted(() => ({ ready: true }));
vi.mock("@/lib/agent/attachment-db", () => ({
  listAttachmentsForSession: async () => [{ id: "old-sound", status: state.ready ? "ready" : "expired" }],
  getReadyAttachments: async (ids: string[]) => state.ready && ids.includes("old-sound") ? [{ id: "old-sound" }] : [],
  recordAttachmentAccess: vi.fn(),
}));
const sourceModel = resolveModel("inspiration");
const targetModel = resolveModel("deepseek-flash");
const input = { userId: "u", sessionId: "s", productionId: null, runId: "r", model: targetModel, signal: new AbortController().signal };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (model: Model, text: string, error = false): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2,
  content: [{ type: "text", text }], stopReason: error ? "error" : "stop", usage,
});
function sound(bytes = 3): MediaContent {
  return { type: "audio", attachmentId: "old-sound", fileName: "排练.wav", mimeType: "audio/wav",
    data: Buffer.alloc(bytes).toString("base64"), source: { kind: "attachment", sha256: "a".repeat(64) },
    budget: { bytes, base64Chars: 4 * Math.ceil(bytes / 3), estimatedTokens: 1200, durationSeconds: 1, basis: "实测音轨" } };
}
async function setup(media: MediaContent, processed = true, pending?: MediaContent) {
  const session = new Session(new InMemorySessionStorage());
  await session.appendMessage({ role: "user", timestamp: 1, content: [{ type: "text", text: "分析排练录音" }, media] });
  await session.appendMessage(answer(sourceModel, "录音说明：开场后第二声敲击进入。", !processed));
  await session.appendMessage({ role: "user", timestamp: 3, content: [{ type: "text", text: "继续讨论开场，不改之前的约束。" }, ...(pending ? [pending] : [])] });
  return session;
}
afterEach(() => { state.ready = true; vi.restoreAllMocks(); });

describe("#967 请求边界媒体适配", () => {
  it("长度放得下仍检测到模态不匹配；历史单件超预算也不能被低 token 估算掩盖", () => {
    const audio = sound();
    const budget = estimateRequestBudget(targetModel, { messages: [{ role: "user", timestamp: 1, content: [audio] }] });
    expect(budget.textFits).toBe(true);
    expect(budget.fits).toBe(false);
    expect(budget.mediaReasons.join()).toContain("未接入");
    const qwen = estimateRequestBudget(resolveModel("resonance"), { messages: [{ role: "user", timestamp: 1, content: [sound(8 * 1024 * 1024)] }] });
    expect(qwen.textFits).toBe(true);
    expect(qwen.mediaFits).toBe(false);
  });

  it.each([targetModel, resolveModel("resonance")])("旧音频触发适配，使用能读原件的历史模型并保留新图：$id", async (target) => {
    const old = sound(8 * 1024 * 1024);
    const picture: MediaContent = { type: "image", mimeType: "image/jpeg", data: "AQID",
      budget: { bytes: 3, base64Chars: 4, estimatedTokens: 1200, width: 1, height: 1, basis: "实测图片" } };
    const session = await setup(old, true, picture);
    const select = vi.fn(async () => ({ model: sourceModel, apiKey: "source-key" }));
    const complete = vi.fn(async (model: Model, context, options) => {
      expect(model.id).toBe(sourceModel.id);
      expect(options.apiKey).toBe("source-key");
      expect(JSON.stringify(context.messages)).toContain(old.data);
      expect(JSON.stringify(context.messages)).not.toContain("image/jpeg");
      return answer(sourceModel, "开场后第二声敲击进入。保留录音身份，精确复核再读取。");
    });
    const next = await compactRequestContext({ session, context: { messages: convertToLlm((await session.buildContext()).messages) },
      model: target, apiKey: "target-key", signal: input.signal, trigger: "pressure", completeSimple: complete,
      selectSummaryModel: select });
    expect(select).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(estimateRequestBudget(target, next).fits).toBe(true);
    expect(JSON.stringify(next)).not.toContain("audio/wav\",\"data");
    expect(JSON.stringify(next)).toContain("image/jpeg");
    const checkpoint = (await session.getBranch()).find((entry) => entry.type === "compaction");
    expect(checkpoint?.type === "compaction" && checkpoint.summary).toContain("old-sound");
    expect(checkpoint?.type === "compaction" && checkpoint.details).toMatchObject({ media: [], mediaReferences: [expect.objectContaining({ attachmentId: "old-sound" })] });
  });

  it("适配成功不强求 token 减少；没有切模型不匹配时则不额外压缩", async () => {
    const old = sound();
    const session = await setup(old);
    const original = { messages: convertToLlm((await session.buildContext()).messages) };
    const complete = vi.fn(async () => answer(sourceModel, "完整保留开场约束。".repeat(300)));
    const common = { session, context: original, apiKey: "test", signal: input.signal, trigger: "pressure" as const, completeSimple: complete };
    await compactRequestContext({ ...common, model: sourceModel });
    expect(complete).not.toHaveBeenCalled();
    const next = await compactRequestContext({ ...common, model: targetModel,
      selectSummaryModel: async () => ({ model: sourceModel, apiKey: "test" }) });
    expect(estimateRequestBudget(targetModel, next).estimatedInputTokens).toBeGreaterThan(estimateRequestBudget(targetModel, original).estimatedInputTokens);
    expect(estimateRequestBudget(targetModel, next).fits).toBe(true);
  });

  it("同模型下仅历史媒体数量超限也压缩旧原件，保留本轮未处理的媒体", async () => {
    const model = { ...sourceModel, nativeMedia: sourceModel.nativeMedia!.map((capability) => ({ ...capability, maxCount: 1 })) };
    const old = sound();
    const fresh = { ...sound(), attachmentId: "new-sound", fileName: "新录音.wav" };
    const session = await setup(old, true, fresh);
    const context = { messages: convertToLlm((await session.buildContext()).messages) };
    expect(estimateRequestBudget(model, context).textFits).toBe(true);
    expect(estimateRequestBudget(model, context).mediaFits).toBe(false);
    const complete = vi.fn(async (usedModel: Model, request) => {
      expect(usedModel).toBe(model);
      expect(JSON.stringify(request)).toContain("old-sound");
      expect(JSON.stringify(request)).not.toContain("new-sound");
      return answer(model, "开场后第二声敲击进入。需要细节时读取旧录音。");
    });
    const next = await compactRequestContext({ session, context, model, apiKey: "test", signal: input.signal,
      trigger: "pressure", completeSimple: complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(estimateRequestBudget(model, next).fits).toBe(true);
    const raw = next.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "audio");
    expect(raw).toEqual([fresh]);
  });

  it("摘要失败或旧媒体尚未成功分析时，不提交检查点、不沿用不兼容请求", async () => {
    for (const processed of [true, false]) {
      const session = await setup(sound(), processed);
      const before = (await session.getBranch()).length;
      await expect(compactRequestContext({ session, context: { messages: convertToLlm((await session.buildContext()).messages) },
        model: targetModel, apiKey: "test", signal: input.signal, trigger: "pressure",
        selectSummaryModel: async () => ({ model: sourceModel, apiKey: "test" }),
        completeSimple: async () => answer(sourceModel, processed ? "" : "摘要"),
      })).rejects.toThrow();
      expect((await session.getBranch()).length).toBe(before);
    }
  });

  it("完整原件已在请求时省略读取工具；压缩成引用后同一 run 必须重新可读", async () => {
    const old = sound();
    expect(await attachmentReadNeeded([{ role: "user", timestamp: 1, content: [old] }], input)).toBe(false);
    const archived = [{ role: "compactionSummary" as const, timestamp: 1, tokensBefore: 1200, summary: "开场第二声敲击进入。",
      details: { mediaReferences: [{ ...old, data: undefined }] } }];
    const restored = await restoreModelMedia(archived, input);
    expect(await attachmentReadNeeded(restored, input)).toBe(true);
    expect(JSON.stringify(restored)).toContain("my.attachment_read");
    expect(JSON.stringify(restored)).not.toContain('"data":');
    state.ready = false;
    expect(await attachmentReadNeeded(restored, input)).toBe(false);
    const unavailable = await restoreModelMedia(archived, input);
    expect(JSON.stringify(unavailable)).toContain("原件当前不可读");
  });

  it("素材原件也仅保存稳定身份，base64 不进入持久轨迹", async () => {
    const session = await setup({ ...sound(), attachmentId: undefined, assetId: "asset-1", source: { kind: "asset", fileId: "file-1", sha256: "a".repeat(64) } });
    const entry = durableMediaEntry((await session.getBranch())[0]);
    expect(JSON.stringify(entry)).not.toContain('"data":');
    expect(JSON.stringify(entry)).toContain('"assetId":"asset-1"');
    expect(JSON.stringify(entry)).toContain('"fileId":"file-1"');
  });
});
