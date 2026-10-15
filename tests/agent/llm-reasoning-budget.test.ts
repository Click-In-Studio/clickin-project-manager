import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ complete: vi.fn(), key: vi.fn() }));
vi.mock("@/lib/agent/runtime/config", () => ({
  hiddenModelCandidates: () => [
    { id: "deepseek-flash", provider: "deepseek" },
    { id: "qwen3.8-flash", provider: "qwen" },
  ],
  modelApiKey: mocks.key,
  llmRuntime: () => ({ completeSimple: mocks.complete }),
}));
import { chat, LlmBudgetError, LlmUnavailableError } from "@/lib/agent/llm-chat";
const messages = [{ role: "user" as const, content: "虚构材料" }];
const options = { purpose: "test", maxTokens: 1800, temperature: 0, parse: JSON.parse };
const reply = (text: string, stopReason = "stop") => ({
  content: [{ type: "text", text }], stopReason,
});
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.key.mockReturnValue("test"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function freshChat() { return (await import("@/lib/agent/llm-chat")).chat; }

describe("隐藏模型调用跨厂商接替", () => {
  it("首选成功时不调用备用，返回实际生成模型", async () => {
    mocks.complete.mockResolvedValueOnce(reply('{"ok":true}'));
    expect(await (await freshChat())(messages, options)).toMatchObject({ value: { ok: true }, provider: "deepseek", model: "deepseek-flash" });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0][2]).toMatchObject({ maxRetries: 0, maxTokens: 1800 });
  });
  it.each([429, 500, 502, 503, 401, 403])("HTTP %s 自动接替且不解析错误页", async status => {
    mocks.complete.mockImplementationOnce(async (_m, _c, o) => {
      await o.onResponse({ status, headers: {} });
      return { ...reply("", "error"), errorMessage: "provider error" };
    }).mockResolvedValueOnce(reply('["备用结果"]'));
    const run = await freshChat();
    expect(await run(messages, options)).toMatchObject({ value: ["备用结果"], model: "qwen3.8-flash" });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
  it("网络失败后短时绕开故障厂商，冷却后恢复探测", async () => {
    vi.useFakeTimers();
    const run = await freshChat();
    mocks.complete.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(reply('[]'));
    await run(messages, options);
    await run(messages, options);
    expect(mocks.complete.mock.calls.map(c => c[0].provider)).toEqual(["deepseek", "qwen", "qwen"]);
    await vi.advanceTimersByTimeAsync(60_001);
    await run(messages, options);
    expect(mocks.complete.mock.calls.at(-1)![0].provider).toBe("deepseek");
  });
  it("首选挂起也有超时，随后备用成功", async () => {
    vi.useFakeTimers();
    const run = await freshChat();
    mocks.complete.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(reply('[]'));
    const pending = run(messages, options);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await pending).toMatchObject({ provider: "qwen", value: [] });
  });
  it("两家都挂起时总耗时有界", async () => {
    vi.useFakeTimers();
    const run = await freshChat();
    mocks.complete.mockImplementation(() => new Promise(() => {}));
    const pending = expect(run(messages, options)).rejects.toMatchObject({ name: "LlmUnavailableError" });
    await vi.advanceTimersByTimeAsync(32_001);
    await pending;
  });
  it("凭据缺失不阻断另一家公司", async () => {
    mocks.key.mockImplementationOnce(() => { throw new Error("missing key"); }).mockReturnValue("qwen-key");
    mocks.complete.mockResolvedValue(reply('[]'));
    expect(await (await freshChat())(messages, options)).toMatchObject({ provider: "qwen" });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it.each([reply('not json'), reply('["半截"]', "length")])("非法或截断输出不能成为成功结果", async first => {
    mocks.complete.mockResolvedValueOnce(first).mockResolvedValueOnce(reply('["完整"]'));
    expect(await (await freshChat())(messages, options)).toMatchObject({ value: ["完整"], provider: "qwen" });
  });
  it("只有两家都是预算不足才允许业务缩小输入", async () => {
    mocks.complete.mockResolvedValue(reply('[]', "length"));
    await expect((await freshChat())(messages, options)).rejects.toMatchObject({ name: "LlmBudgetError" });
  });
  it("预算不足混合供应商故障，不得冒充纯预算问题而消费记忆材料", async () => {
    mocks.complete.mockResolvedValueOnce(reply('[]', "length")).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect((await freshChat())(messages, options)).rejects.toMatchObject({ name: "LlmUnavailableError" });
  });
  it("业务解析校验参与接替，落库不在重试入口中", async () => {
    mocks.complete.mockResolvedValueOnce(reply('["重复","重复"]')).mockResolvedValueOnce(reply('["有效"]'));
    const parse = (raw: string) => { const v = JSON.parse(raw) as string[]; if (new Set(v).size !== v.length) throw new Error("重复"); return v; };
    expect(await (await freshChat())(messages, { ...options, parse })).toMatchObject({ value: ["有效"] });
  });
  it("保留明确的错误类型", () => {
    expect(new LlmBudgetError("length", true).name).toBe("LlmBudgetError");
    expect(new LlmUnavailableError("暂不可用").name).toBe("LlmUnavailableError");
    expect(chat).toBeTypeOf("function");
  });
});
