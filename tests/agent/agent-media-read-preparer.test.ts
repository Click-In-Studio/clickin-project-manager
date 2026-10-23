import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Context, MediaContent, Model } from "../../vendor/openclaw/packages/llm-core/src/types";
import { createMediaReadPreparer } from "@/lib/agent/runtime/media-read-preparer";
import { resolveModel } from "@/lib/agent/runtime/config";
import { CompactionBudgetError } from "@/lib/agent/runtime/request-compaction";

const model = resolveModel("deepseek-flash");
function picture(id: string): MediaContent {
  return { type: "image", mimeType: "image/png", assetId: id, data: "AQID",
    budget: { bytes: 3, base64Chars: 4, width: 10, height: 10, estimatedTokens: 1024, basis: "测试实测" } };
}
function setup(target: Model = model, signal = new AbortController().signal) {
  const seen: MediaContent[][] = [];
  const prepareRequest = vi.fn(async (context: Context) => context);
  const preparer = createMediaReadPreparer({ model: target, signal,
    buildContext: async pending => {
      seen.push(pending);
      return { messages: [{ role: "user", timestamp: 0, content: pending }] };
    }, prepareRequest,
  });
  return { ...preparer, prepareRequest, seen };
}

describe("#1052 同一 run 的媒体准备", () => {
  it("同批预算累计预留，超过新图组合硬预算时只拒绝超出的读取", async () => {
    const target = { ...model, nativeMedia: model.nativeMedia!.map(capability => ({ ...capability, maxRequestBytes: 6 })) };
    const input = setup(target);
    expect(await Promise.all(["a", "b", "c"].map(id => input.prepare(picture(id))))).toEqual([true, true, false]);
    expect(input.seen.map(parts => parts.map(part => part.assetId))).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
    expect(input.prepareRequest).toHaveBeenCalledTimes(2);
    input.requestStarted();
    expect(await input.prepare(picture("d"))).toBe(true);
    expect(input.seen.at(-1)!.map(part => part.assetId)).toEqual(["d"]);
  });

  it("串行进入整理并在锁内重建上下文，同一原件不重复预留", async () => {
    const input = setup();
    let revision = 0;
    let active = 0;
    const revisions: number[] = [];
    input.prepareRequest.mockImplementation(async context => {
      expect(active++).toBe(0);
      revisions.push(revision);
      await new Promise(resolve => setTimeout(resolve, 5));
      revision++;
      active--;
      return context;
    });
    expect(await Promise.all(["a", "b", "a"].map(id => input.prepare(picture(id))))).toEqual([true, true, true]);
    expect(revisions).toEqual([0, 1, 2]);
    expect(input.seen.at(-1)!.map(part => part.assetId)).toEqual(["a", "b"]);
  });

  it("单次摘要失败不污染预留、不阻断后续读取，也不吞掉原始错误", async () => {
    const input = setup();
    input.prepareRequest.mockRejectedValueOnce(new Error("摘要服务不可用"));
    const first = input.prepare(picture("a"));
    const second = input.prepare(picture("b"));
    await expect(first).rejects.toThrow("摘要服务不可用");
    expect(await second).toBe(true);
    expect(input.seen.at(-1)!.map(part => part.assetId)).toEqual(["b"]);
  });

  it("确认必要媒体无法容纳时返回解析路径，后续队列仍可用", async () => {
    const input = setup();
    input.prepareRequest.mockRejectedValueOnce(new CompactionBudgetError("无法容纳"));
    expect(await input.prepare(picture("a"))).toBe(false);
    expect(await input.prepare(picture("b"))).toBe(true);
  });

  it("取消时在途与排队读取都退出，不再进入下一次整理", async () => {
    const abort = new AbortController();
    const input = setup(model, abort.signal);
    input.prepareRequest.mockImplementationOnce(async () => {
      abort.abort();
      abort.signal.throwIfAborted();
      throw new Error("不可达");
    });
    const outcomes = await Promise.allSettled([input.prepare(picture("a")), input.prepare(picture("b"))]);
    expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
    expect(input.prepareRequest).toHaveBeenCalledOnce();
  });

  it("不同 run 的整理可并发，队列不成为全局锁", async () => {
    const first = setup();
    const second = setup();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    first.prepareRequest.mockImplementationOnce(async context => { await waiting; return context; });
    const slow = first.prepare(picture("a"));
    try { expect(await second.prepare(picture("b"))).toBe(true); }
    finally { finish(); }
    expect(await slow).toBe(true);
  });

  it("主助理和子助理都接入执行实例的协调器，工具阶段不嵌套占用 LLM 名额", () => {
    for (const file of ["service", "subagents"]) {
      const source = readFileSync(`lib/agent/runtime/${file}.ts`, "utf8");
      expect(source).toContain("const mediaReads = createMediaReadPreparer(");
      expect(source).toContain("if (!pendingMedia) mediaReads.requestStarted()");
      expect(source).toContain("mediaReads.prepare");
    }
    expect(readFileSync("lib/agent/runtime/model-read.ts", "utf8")).not.toContain('"llm"');
    expect(readFileSync("lib/agent/runtime/request-compaction.ts", "utf8")).toContain("await budgetedComplete(model, request, summaryOptions");
  });
});
