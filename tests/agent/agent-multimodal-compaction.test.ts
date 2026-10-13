import { describe, expect, it } from "vitest";
import { Session } from "../../vendor/openclaw/packages/agent-core/src/harness/session/session";
import { InMemorySessionStorage } from "../../vendor/openclaw/packages/agent-core/src/index";
import { convertToLlm } from "../../vendor/openclaw/packages/agent-core/src/harness/messages";
import type {
  AssistantMessage,
  MediaContent,
} from "../../vendor/openclaw/packages/llm-core/src/types";
import { compactRequestContext } from "@/lib/agent/runtime/request-compaction";
import { resolveModel } from "@/lib/agent/runtime/config";
import { durableMediaEntry } from "@/lib/agent/runtime/media-transcript";
import { estimateRequestBudget } from "@/lib/agent/runtime/context-budget";
const model = resolveModel("inspiration");
function answer(
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: 2,
    content: [
      { type: "text", text: "已分析图片，舞台用红光；复核须按附件身份重读。" },
    ],
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const image: MediaContent = {
  type: "image",
  mimeType: "image/png",
  attachmentId: "test-image",
  data: "AQID",
  source: { kind: "attachment", sha256: "a".repeat(64) },
  budget: {
    bytes: 3,
    base64Chars: 4,
    estimatedTokens: 1200,
    basis: "实测尺寸",
    width: 10,
    height: 10,
  },
};
async function sessionWithMedia(processed: boolean) {
  const session = new Session(new InMemorySessionStorage());
  await session.appendMessage({
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "舞台资料".repeat(3000) }, image],
  });
  await session.appendMessage(answer(processed ? "stop" : "error"));
  for (let i = 0; i < 3; i++) {
    await session.appendMessage({
      role: "user",
      timestamp: 3 + i,
      content: "其他已处理材料".repeat(2000),
    });
    await session.appendMessage(answer(processed ? "stop" : "error"));
  }
  await session.appendMessage({
    role: "user",
    timestamp: 8,
    content: "继续讨论",
  });
  return session;
}
describe("多模态压缩与持久化", () => {
  it("原件不写入 transcript，尺寸与版本身份仍保留；base64长度不冒充文本token", async () => {
    const session = await sessionWithMedia(true);
    const entry = (await session.getBranch())[0];
    const persisted = JSON.stringify(durableMediaEntry(entry));
    expect(persisted).not.toContain('"data":"AQID"');
    expect(persisted).toContain('"sha256"');
    expect(persisted).toContain('"width":10');
    const context = {
      messages: [{ role: "user" as const, timestamp: 1, content: [image] }],
    };
    const small = estimateRequestBudget(model, context);
    const large = estimateRequestBudget(model, {
      messages: [
        {
          ...context.messages[0],
          content: [{ ...image, data: "A".repeat(100000) }],
        },
      ],
    });
    expect(large.estimatedInputTokens).toBe(small.estimatedInputTokens);
    expect(small.mediaTokens).toBe(1200);
  });
  it("已处理可回查媒体进入摘要证据；未成功分析媒体必须保留原块", async () => {
    for (const processed of [true, false]) {
      const session = await sessionWithMedia(processed);
      let sawOriginal = false;
      const result = await compactRequestContext({
        session,
        model,
        apiKey: "test",
        signal: new AbortController().signal,
        context: {
          systemPrompt: "真实系统前缀",
          messages: convertToLlm((await session.buildContext()).messages),
        },
        trigger: "pressure",
        shouldCompact: () => true,
        completeSimple: async (_model, context) => {
          sawOriginal = JSON.stringify(context.messages).includes(
            '"data":"AQID"',
          );
          return answer();
        },
      });
      expect(sawOriginal).toBe(true);
      const compacted = (await session.getBranch()).findLast(
        (entry) => entry.type === "compaction",
      );
      expect(compacted?.type).toBe("compaction");
      if (compacted?.type !== "compaction") throw new Error("未提交摘要");
      const details = compacted.details as {
        media: MediaContent[];
        mediaReferences: MediaContent[];
      };
      if (processed) {
        expect(details.mediaReferences).toEqual([
          { ...image, data: undefined },
        ]);
        expect(details.media).toEqual([]);
        expect(compacted.summary).toContain("test-image");
      } else {
        expect(details.media).toEqual([image]);
        expect(JSON.stringify(result.messages)).toContain('"data":"AQID"');
      }
    }
  });
  it("摘要截断或保留媒体后仍超预算，不提交任何检查点", async () => {
    const session = await sessionWithMedia(false);
    const before = (await session.getBranch()).length;
    const context = {
      messages: convertToLlm((await session.buildContext()).messages),
    };
    await compactRequestContext({
      session,
      model,
      apiKey: "test",
      signal: new AbortController().signal,
      context,
      trigger: "pressure",
      shouldCompact: () => true,
      completeSimple: async () => answer("length"),
    });
    expect((await session.getBranch()).length).toBe(before);
    const tiny = { ...model, contextTokens: 1000, maxTokens: 100 };
    await expect(
      compactRequestContext({
        session,
        model: tiny,
        apiKey: "test",
        signal: new AbortController().signal,
        context,
        trigger: "context-overflow",
        completeSimple: async () => answer(),
      }),
    ).rejects.toThrow("超过预算");
    expect((await session.getBranch()).length).toBe(before);
  });
});
