/**
 * lib/llm-chat.ts（原 agent/llm.ts）的预算语义（2026-08-17 线上事故）。
 *
 * DEEPSEEK_MODEL=deepseek-v4-pro 是推理模型，`max_tokens` 是 **CoT + 正文的
 * 总预算**。记忆蒸馏按正文估传了 2000，实测 reasoning_tokens=1874（94%）、
 * finish_reason=length、content 为空 —— 每天的蒸馏都以
 * "LLM returned empty response" 失败，而错误信息完全看不出跟预算有关。
 *
 * 更险的是隔壁分支：content 被截断但非空时，原实现照常返回，
 * distillUser 拿半截摘要覆盖写 MEMORY.md —— 长期记忆被替换成残文。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chat } from "@/lib/llm-chat";

type Body = { max_tokens: number };

const calls: Body[] = [];
let savedEnv: Record<string, string | undefined>;

/** 造一个 OpenAI 兼容返回体；reasoning 非空即模拟推理模型。 */
function completion(opts: {
  content: string; reasoning?: string; finishReason?: string; reasoningTokens?: number;
}) {
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: { content: opts.content, reasoning_content: opts.reasoning ?? "" },
        finish_reason: opts.finishReason ?? "stop",
      }],
      usage: { completion_tokens_details: { reasoning_tokens: opts.reasoningTokens ?? 0 } },
    }),
  };
}

/** 依次返回给定的响应；记录每次请求的 max_tokens。 */
function stubFetch(responses: ReturnType<typeof completion>[]) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as Body);
    return responses[Math.min(i++, responses.length - 1)];
  }));
}

beforeEach(() => {
  calls.length = 0;
  savedEnv = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  };
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const MSGS = [{ role: "user" as const, content: "整理一下" }];

describe("chat — 推理模型的预算语义", () => {
  it("CoT 吃光预算导致正文为空时，按推理上限重试一次", async () => {
    stubFetch([
      completion({ content: "", reasoning: "想了很久", finishReason: "length", reasoningTokens: 1874 }),
      completion({ content: "整理好的摘要" }),
    ]);

    await expect(chat(MSGS, { maxTokens: 2000 })).resolves.toBe("整理好的摘要");
    expect(calls.map((c) => c.max_tokens)).toEqual([2000, 8000]);
  });

  it("普通模型（无 reasoning_content）不触发重试，只打一次", async () => {
    stubFetch([completion({ content: "", finishReason: "length" })]);

    await expect(chat(MSGS, { maxTokens: 2000 })).rejects.toThrow(/empty response/);
    expect(calls).toHaveLength(1);
  });

  it("重试后仍为空 → 报错带 finish_reason 与 reasoning_tokens，能一眼看出是预算问题", async () => {
    stubFetch([
      completion({ content: "", reasoning: "想", finishReason: "length", reasoningTokens: 1900 }),
      completion({ content: "", reasoning: "还在想", finishReason: "length", reasoningTokens: 7900 }),
    ]);

    await expect(chat(MSGS, { maxTokens: 2000 })).rejects.toThrow(
      /empty response.*model=deepseek-v4-pro.*finish_reason=length.*max_tokens=8000.*reasoning_tokens=7900/,
    );
  });

  it("已经按上限调用的不再重试（避免无谓的第二次）", async () => {
    stubFetch([completion({ content: "", reasoning: "想", finishReason: "length" })]);

    await expect(chat(MSGS, { maxTokens: 8000 })).rejects.toThrow(/empty response/);
    expect(calls).toHaveLength(1);
  });
});

describe("chat — rejectTruncated", () => {
  it("默认放行截断内容（既有调用点的行为不变）", async () => {
    stubFetch([completion({ content: "半截", finishReason: "length" })]);
    await expect(chat(MSGS, { maxTokens: 100 })).resolves.toBe("半截");
  });

  // 蒸馏会用返回值覆盖 MEMORY.md，半截等于毁掉既有长期记忆
  it("rejectTruncated=true 时截断按失败处理，不返回半截内容", async () => {
    stubFetch([completion({ content: "半截摘要", finishReason: "length" })]);
    await expect(chat(MSGS, { maxTokens: 100, rejectTruncated: true }))
      .rejects.toThrow(/truncated.*content_len=4/);
  });

  it("rejectTruncated + 推理模型截断：重试拿到完整正文即成功", async () => {
    stubFetch([
      completion({ content: "半截", reasoning: "想", finishReason: "length", reasoningTokens: 1874 }),
      completion({ content: "完整摘要", finishReason: "stop" }),
    ]);
    await expect(chat(MSGS, { maxTokens: 2000, rejectTruncated: true })).resolves.toBe("完整摘要");
    expect(calls.map((c) => c.max_tokens)).toEqual([2000, 8000]);
  });

  it("正常结束的内容照常返回，不受影响", async () => {
    stubFetch([completion({ content: "完整", finishReason: "stop" })]);
    await expect(chat(MSGS, { maxTokens: 100, rejectTruncated: true })).resolves.toBe("完整");
    expect(calls).toHaveLength(1);
  });
});
