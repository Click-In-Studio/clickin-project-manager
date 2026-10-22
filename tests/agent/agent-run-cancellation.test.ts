import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CoreAgentHarness } from "../../vendor/openclaw/packages/agent-core/src/harness/agent-harness";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { CHAT_MODEL } from "@/lib/agent/runtime/config";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { abortRun, runtimeOverrides, startRun, waitForIdle } from "@/lib/agent/runtime/service";
import { readEventsSince } from "@/lib/agent/runtime/events";
import { cleanupProduction, makeProduction, setProductionTier, shortId } from "../_support/factories";

describe("主任务取消终态", () => {
  let userId: string;
  let prodId: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`cancel-${shortId()}`, "取消测试", null, false));
    ({ prodId } = await makeProduction(userId));
    await setProductionTier(prodId, "pro");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.mmpClient = null;
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await abortRun(sessionId);
      await waitForIdle(sessionId);
      await getPool().query("DELETE FROM agent_session WHERE id=$1", [sessionId]);
    }
    delete runtimeOverrides.apiKey;
    delete runtimeOverrides.mmpClient;
    delete runtimeOverrides.streamFn;
    await cleanupProduction(prodId).catch(() => {});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("harness 建立内部取消控制器前停止，准备阶段错误不能覆盖用户取消", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const prompt = CoreAgentHarness.prototype.prompt;
    const abort = CoreAgentHarness.prototype.abort;
    // 真 harness 在该钩子之后才建立内部 AbortController；用屏障固定竞态窗口。
    const promptSpy = vi.spyOn(CoreAgentHarness.prototype, "prompt").mockImplementation(function (this: CoreAgentHarness, ...args) {
      this.on("before_agent_start", async () => {
        entered.resolve();
        await release.promise;
      });
      return prompt.apply(this, args);
    });
    const abortSpy = vi.spyOn(CoreAgentHarness.prototype, "abort").mockImplementation(function (this: CoreAgentHarness) {
      const result = abort.call(this);
      abortObserved.resolve();
      return result;
    });
    const provider = vi.fn(() => { throw new Error("取消后不应请求模型"); });
    runtimeOverrides.streamFn = provider;
    const sessionId = createNewSessionKey(userId, prodId);
    sessions.push(sessionId);
    try {
      const { runId } = await startRun({ sessionId, userId, message: "准备期间停止" });
      await entered.promise;
      const stopping = abortRun(sessionId);
      await abortObserved.promise;
      release.resolve();
      expect(await stopping).toBe(true);
      await waitForIdle(sessionId);
      expect(provider).not.toHaveBeenCalled();
      const row = (await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0];
      expect(row).toEqual({ status: "aborted", error: null });
      const lines = (await readEventsSince(sessionId, 0)).map(event => event.line);
      expect(lines.at(-1)?.type).toBe("aborted");
      expect(lines.some(line => line.type === "error")).toBe(false);
    } finally {
      release.resolve();
      promptSpy.mockRestore();
      abortSpy.mockRestore();
      await abortRun(sessionId);
      await waitForIdle(sessionId);
    }
  });

  it("未取消的真实模型错误仍记为失败并发出错误终态", async () => {
    runtimeOverrides.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error: {
        role: "assistant", api: CHAT_MODEL.api, provider: CHAT_MODEL.provider, model: CHAT_MODEL.id,
        content: [], timestamp: Date.now(), stopReason: "error", errorMessage: "模型请求失败夹具",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } }));
      return stream;
    };
    const sessionId = createNewSessionKey(userId, prodId);
    sessions.push(sessionId);
    const { runId } = await startRun({ sessionId, userId, message: "正常错误" });
    await waitForIdle(sessionId);
    expect((await getPool().query("SELECT status,error FROM agent_run WHERE id=$1", [runId])).rows[0])
      .toEqual({ status: "failed", error: "模型请求失败夹具" });
    expect((await readEventsSince(sessionId, 0)).at(-1)?.line).toEqual({ type: "error", error: "模型请求失败夹具" });
  });
});
