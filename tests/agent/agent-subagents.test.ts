import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type {
  StreamFn,
  AssistantMessage,
  ToolCall,
} from "../../vendor/openclaw/packages/llm-core/src/types";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import {
  makeProduction,
  cleanupProduction,
  shortId,
} from "../_support/factories";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { newRunId } from "@/lib/agent/runtime/ids";
import { CHAT_MODEL, RUNNER_OWNER } from "@/lib/agent/runtime/config";
import {
  exposedName,
  type RunHandle,
  TOOL_MCP_NAMES,
  RUNTIME_ONLY_TOOLS,
} from "@/lib/agent/runtime/tools";
import { tieredToolNames } from "@/lib/agent/runtime/tool-tiers";
import { TOOL_CATALOG } from "@/lib/agent/tools/tool-catalog";
import { SUBAGENT_TOOL_NAMES } from "@/lib/agent/runtime/subagent-types";
import {
  spawnSubagent,
  sendSubagent,
  stopSubagent,
  readSubagent,
  subagentRuntimeOverrides,
  waitSubagents,
  recoverSubagents,
} from "@/lib/agent/runtime/subagents";
import {
  listSubagents,
  claimSubagents,
  addTaskCost,
  queueSubagent,
  deliverSubagentNotifications,
} from "@/lib/agent/runtime/subagent-db";
import {
  runtimeOverrides,
  startRun,
  abortRun,
  waitForIdle,
  dispatchPendingSession,
  getHistory,
  listSessions,
} from "@/lib/agent/runtime/service";

import {
  checkpointChildUsage,
  recordChildUsage,
} from "@/lib/agent/runtime/subagent-usage-db";
import { grantExtraCredits, extraRemaining } from "@/lib/agent/ai-quota";
import { creditsFromUsd } from "@/lib/account/plan";
import { EventPublisher, readEventsSince } from "@/lib/agent/runtime/events";

const usage = {
  input: 7,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function model(
  script: Array<string | ToolCall[]>,
  seen: Array<{ messages: unknown[]; tools: string[] }> = [],
  gate?: Promise<void>,
): StreamFn {
  return (_model, context, options) => {
    seen.push({
      messages: structuredClone(context.messages),
      tools: context.tools?.map((t) => t.name) ?? [],
    });
    const stream = createAssistantMessageEventStream();
    let stopped = false;
    const base = {
      role: "assistant" as const,
      api: CHAT_MODEL.api,
      provider: CHAT_MODEL.provider,
      model: CHAT_MODEL.id,
      usage,
      timestamp: Date.now(),
    };
    options?.signal?.addEventListener(
      "abort",
      () => {
        if (stopped) return;
        stopped = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...base, content: [], stopReason: "aborted" },
        });
      },
      { once: true },
    );
    queueMicrotask(async () => {
      if (gate) await gate;
      if (stopped) return;
      const step = script.shift() ?? "汇总完成";
      const message: AssistantMessage = {
        ...base,
        content:
          typeof step === "string" ? [{ type: "text", text: step }] : step,
        stopReason: typeof step === "string" ? "stop" : "toolUse",
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({
        type: "done",
        reason: typeof step === "string" ? "stop" : "toolUse",
        message,
      });
    });
    return stream;
  };
}
async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待持久状态超时");
}

describe("持久子 Agent 基建", () => {
  let userId: string;
  let prodId: string;
  const parents: RunHandle[] = [];
  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(
      `subagent-${shortId()}`,
      "子 Agent 测试",
      null,
      false,
    ));
    ({ prodId } = await makeProduction(userId));
    runtimeOverrides.apiKey = "test-key";
    runtimeOverrides.mmpClient = null;
    runtimeOverrides.streamFn = model([]);
  });
  afterEach(async () => {
    for (const parent of parents) await stopSubagent(parent.sessionId);
    delete subagentRuntimeOverrides.streamFn;
    delete subagentRuntimeOverrides.timeoutMs;
    runtimeOverrides.streamFn = model([]);
  });
  afterAll(async () => {
    for (const parent of parents) {
      await waitForIdle(parent.sessionId);
      await getPool().query(
        "DELETE FROM agent_session WHERE parent_session_id=$1",
        [parent.sessionId],
      );
      await getPool().query("DELETE FROM agent_session WHERE id=$1", [
        parent.sessionId,
      ]);
    }
    await getPool().query("DELETE FROM ai_credit_grant WHERE user_id=$1", [
      userId,
    ]);
    delete runtimeOverrides.apiKey;
    delete runtimeOverrides.mmpClient;
    delete runtimeOverrides.streamFn;
    await cleanupProduction(prodId).catch(() => {});
  });
  async function parent(): Promise<RunHandle> {
    const sessionId = createNewSessionKey(userId, prodId);
    await PgSessionStorage.create({
      id: sessionId,
      userId,
      productionId: prodId,
    });
    const runId = newRunId();
    await getPool().query(
      "INSERT INTO agent_run(id,session_id,status,owner,heartbeat_at,model) VALUES($1,$2,'running',$3,now(),$4)",
      [runId, sessionId, RUNNER_OWNER, CHAT_MODEL.id],
    );
    const handle: RunHandle = {
      runId,
      sessionId,
      signal: new AbortController().signal,
      publish: () => {},
      setStatus: async () => {},
      isDetached: () => false,
    };
    parents.push(handle);
    return handle;
  }
  async function completed(p: RunHandle, id: string) {
    await eventually(async () => {
      const row = (await listSubagents(p.sessionId)).find((r) => r.id === id);
      return row?.status === "completed";
    });
    await eventually(
      async () =>
        !(
          await getPool().query(
            "SELECT 1 FROM agent_run WHERE subagent_id=$1 AND notification_delivered=false",
            [id],
          )
        ).rowCount,
    );
  }

  it("六个工具仅热层常驻；个人/制作会话无页面与召回信号也可见，目录不收录", () => {
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect(TOOL_MCP_NAMES).toContain(name);
      expect(RUNTIME_ONLY_TOOLS.has(name)).toBe(true);
      expect(TOOL_CATALOG.some((entry) => entry.name === name)).toBe(false);
      for (const hasProduction of [false, true])
        expect(
          tieredToolNames({
            hasProduction,
            pageKey: null,
            prompt: null,
            recalled: [],
            available: TOOL_MCP_NAMES,
          }).hot,
        ).toContain(name);
    }
  });

  it("独立上下文只读交接材料，保留来源和分段游标，幂等委托不重复执行", async () => {
    const p = await parent();
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    subagentRuntimeOverrides.streamFn = model(
      [
        [
          {
            type: "toolCall",
            id: "source-read",
            name: exposedName("material_read"),
            arguments: { sourceId: "scene-a" },
          },
        ],
        [
          {
            type: "toolCall",
            id: "source-read-next",
            name: exposedName("material_read"),
            arguments: { sourceId: "scene-a", offset: 12000 },
          },
        ],
        "结论：人物动机明确，依据 scene-a 第1场。",
      ],
      seen,
    );
    const input = {
      task: "研读第1场人物动机",
      sources: [
        {
          id: "scene-a",
          title: "第1场",
          locator: "剧本第一章第1场",
          content: "甲：我要留在这里。".repeat(3000),
        },
      ],
    };
    const output = await spawnSubagent(p, input, "delegate-1");
    const id = /as_[a-z0-9]+/.exec(output)![0];
    await completed(p, id);
    expect((await listSubagents(p.sessionId))[0].result).toContain("scene-a");
    expect(seen[0].tools.sort()).toEqual(
      [exposedName("material_read"), exposedName("need_context")].sort(),
    );
    const trace = JSON.parse(await readSubagent(p.sessionId, id));
    expect(JSON.stringify(trace)).toContain("剧本第一章第1场");
    expect(JSON.stringify(trace)).toContain("甲：我要留在这里");
    const offsets = trace.entries
      .filter(
        (e: { payload: { message?: { role: string } } }) =>
          e.payload.message?.role === "toolResult",
      )
      .map(
        (e: { payload: { message: { content: Array<{ text: string }> } } }) =>
          JSON.parse(e.payload.message.content[0].text).nextOffset,
      );
    expect(offsets).toEqual([12000, 24000]);
    expect(await spawnSubagent(p, input, "delegate-1")).toContain(id);
    expect(await listSubagents(p.sessionId)).toHaveLength(1);
    expect((await listSessions(userId)).map((s) => s.key)).not.toContain(id);
    expect(await getHistory(p.sessionId)).toEqual([]);
    await expect(readSubagent("其他会话", id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("完成后追问复用原阅读上下文，并串行追加到同一子会话", async () => {
    const p = await parent();
    subagentRuntimeOverrides.streamFn = model(["初步结论：动机来自家庭责任。"]);
    const id = /as_[a-z0-9]+/.exec(
      await spawnSubagent(p, { task: "研读人物" }),
    )![0];
    await completed(p, id);
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    subagentRuntimeOverrides.streamFn = model(
      ["进一步结论：第二场延续这个动机。"],
      seen,
    );
    await sendSubagent(
      p,
      id,
      "继续解释这个动机如何影响第二场",
      [],
      "follow-up",
    );
    await completed(p, id);
    expect(JSON.stringify(seen[0].messages)).toContain(
      "初步结论：动机来自家庭责任",
    );
    expect(JSON.stringify(seen[0].messages)).toContain("继续解释这个动机");
    expect(await listSubagents(p.sessionId)).toHaveLength(1);
    expect((await listSubagents(p.sessionId))[0].result).toContain(
      "进一步结论",
    );
  });

  it("need_context 持久交接并让 wait 返回，补给后继续；系统请求不会伪装成用户消息", async () => {
    const p = await parent();
    subagentRuntimeOverrides.streamFn = model([
      [
        {
          type: "toolCall",
          id: "context",
          name: exposedName("need_context"),
          arguments: { request: "请补第二场台词，用于核对动机" },
        },
      ],
      "等待第二场材料。",
    ]);
    const id = /as_[a-z0-9]+/.exec(
      await spawnSubagent(p, { task: "核对人物动机" }),
    )![0];
    await eventually(
      async () =>
        (await listSubagents(p.sessionId))[0].status === "awaiting_context",
    );
    const waited = await waitSubagents(
      p.sessionId,
      [id],
      1,
      new AbortController().signal,
    );
    expect(waited).toContain("请补第二场台词");
    await eventually(
      async () =>
        !!(
          await getPool().query(
            "SELECT 1 FROM agent_session_inbox WHERE session_id=$1 AND kind='subagent_event'",
            [p.sessionId],
          )
        ).rowCount,
    );
    await getPool().query(
      "UPDATE agent_run SET status='completed',ended_at=now() WHERE id=$1",
      [p.runId],
    );
    await dispatchPendingSession(p.sessionId);
    await waitForIdle(p.sessionId);
    const events = await getPool().query(
      "SELECT type,payload FROM agent_session_entry WHERE session_id=$1",
      [p.sessionId],
    );
    expect(events.rows.some((r) => r.type === "custom_message")).toBe(true);
    expect(events.rows.some((r) => r.payload.message?.role === "user")).toBe(
      false,
    );
    // 新的人类轮次发起补给，原子任务不会获得查库工具。
    const nextRun = newRunId();
    await getPool().query(
      "INSERT INTO agent_run(id,session_id,status) VALUES($1,$2,'running')",
      [nextRun, p.sessionId],
    );
    const next = { ...p, runId: nextRun };
    subagentRuntimeOverrides.streamFn = model(["资料齐全，结论已核对。"]);
    await sendSubagent(next, id, "第二场已补给", [
      {
        id: "scene-b",
        title: "第二场",
        locator: "剧本第二场",
        content: "乙：你答应过家里。",
      },
    ]);
    await completed(p, id);
    expect((await listSubagents(p.sessionId))[0].contextRequest).toBeNull();
  });

  it("并发认领不会突破名额，同子会话单写者，排队项可取消", async () => {
    const p = await parent();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        await queueSubagent({
          parentSessionId: p.sessionId,
          parentRunId: p.runId,
          task: `任务${i}`,
          message: `任务${i}`,
        }),
      );
    const claims = await Promise.all([
      claimSubagents(),
      claimSubagents(),
      claimSubagents(),
    ]);
    const jobs = claims.flat();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
    expect(jobs.map((j) => j.subagent_id)).toEqual(ids.slice(0, 2));
    await stopSubagent(p.sessionId, ids[4]);
    expect(
      (await listSubagents(p.sessionId)).find((r) => r.id === ids[4])?.status,
    ).toBe("stopped");
    await getPool().query(
      "UPDATE agent_run SET status='completed',ended_at=now() WHERE id=ANY($1::text[])",
      [jobs.map((j) => j.id)],
    );
    const refill = await claimSubagents();
    expect(refill.map((j) => j.subagent_id)).toEqual(ids.slice(2, 4));
    await getPool().query(
      "UPDATE agent_run SET status='completed',ended_at=now() WHERE id=ANY($1::text[])",
      [refill.map((j) => j.id)],
    );
  });

  it("后台子任务结束自动唤醒空闲主会话，多个任务合并交付且通知幂等", async () => {
    const p = await parent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    subagentRuntimeOverrides.streamFn = model(
      ["第一份证据", "第二份证据"],
      [],
      gate,
    );
    await spawnSubagent(p, { task: "调查第一场" });
    await spawnSubagent(p, { task: "调查第二场" });
    await getPool().query(
      "UPDATE agent_run SET status='completed',ended_at=now() WHERE id=$1",
      [p.runId],
    );
    release();
    await eventually(
      async () =>
        !!(
          await getPool().query(
            "SELECT 1 FROM agent_session_entry WHERE session_id=$1 AND type='custom_message'",
            [p.sessionId],
          )
        ).rowCount,
    );
    await waitForIdle(p.sessionId);
    const entries = await getPool().query(
      "SELECT payload FROM agent_session_entry WHERE session_id=$1 AND type='custom_message'",
      [p.sessionId],
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0].payload.details.events).toHaveLength(2);
    expect(await deliverSubagentNotifications()).toEqual([]);
    expect(
      (
        await getPool().query("SELECT id FROM agent_run WHERE session_id=$1", [
          p.sessionId,
        ])
      ).rows,
    ).toHaveLength(2);
  });

  it("停止执行中的子任务清掉通知且不重新唤醒，跨会话停止拒绝", async () => {
    const p = await parent();
    let release!: () => void;
    subagentRuntimeOverrides.streamFn = model(
      ["迟到结果"],
      [],
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const id = /as_[a-z0-9]+/.exec(
      await spawnSubagent(p, { task: "长调研" }),
    )![0];
    await eventually(
      async () => !!(await listSubagents(p.sessionId))[0]?.runId,
    );
    await expect(stopSubagent("其他会话", id)).rejects.toMatchObject({
      status: 403,
    });
    await stopSubagent(p.sessionId, id);
    release();
    expect((await listSubagents(p.sessionId))[0].status).toBe("stopped");
    expect(
      (
        await getPool().query(
          "SELECT id FROM agent_session_inbox WHERE session_id=$1",
          [p.sessionId],
        )
      ).rowCount,
    ).toBe(0);
    await expect(sendSubagent(p, id, "再次执行")).rejects.toThrow("已停止");
  });

  it("子轮次与主脑共用根预算，达到成本硬顶后不认领排队任务", async () => {
    const p = await parent();
    const id = await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      task: "预算测试",
      message: "测试",
    });
    const child = (
      await getPool().query<{ id: string }>(
        "SELECT id FROM agent_run WHERE subagent_id=$1",
        [id],
      )
    ).rows[0];
    expect(await addTaskCost(child.id, 1_000_000)).toBe(false);
    expect(await claimSubagents()).toEqual([]);
    expect(
      (
        await getPool().query(
          "SELECT task_credits FROM agent_run WHERE id=$1",
          [p.runId],
        )
      ).rows[0].task_credits,
    ).not.toBe("0");
  });
  it("取消同批一个子任务保留其他通知，并关闭所有执行名额", async () => {
    const p = await parent();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++)
      ids.push(
        await queueSubagent({
          parentSessionId: p.sessionId,
          parentRunId: p.runId,
          task: `证据${i}`,
          message: "核对",
        }),
      );
    await getPool().query(
      "INSERT INTO agent_session_inbox(id,session_id,message,kind,payload) VALUES($1,$2,'','subagent_event',$3)",
      [
        `ain_${shortId()}`,
        p.sessionId,
        JSON.stringify(
          ids.map((id) => ({
            subagentId: id,
            budgetRunId: p.runId,
            runId: "旧轮次",
            status: "completed",
            summary: "证据",
          })),
        ),
      ],
    );
    await stopSubagent(p.sessionId, ids[0]);
    const inbox = await getPool().query(
      "SELECT payload FROM agent_session_inbox WHERE session_id=$1",
      [p.sessionId],
    );
    expect(
      inbox.rows[0].payload.map((e: { subagentId: string }) => e.subagentId),
    ).toEqual([ids[1]]);
    expect(
      (
        await getPool().query(
          "SELECT status FROM agent_run WHERE subagent_id=$1",
          [ids[0]],
        )
      ).rows[0].status,
    ).toBe("aborted");
  });

  it("执行超时从认领时计起，并留下明确失败原因", async () => {
    const p = await parent();
    subagentRuntimeOverrides.timeoutMs = 40;
    subagentRuntimeOverrides.streamFn = model(
      [],
      [],
      new Promise<void>(() => {}),
    );
    const id = /as_[a-z0-9]+/.exec(
      await spawnSubagent(p, { task: "超时任务" }),
    )![0];
    await eventually(
      async () => (await listSubagents(p.sessionId))[0].status === "failed",
    );
    const view = (await listSubagents(p.sessionId))[0];
    expect(view.error).toContain("超时");
    expect(
      (
        await getPool().query(
          "SELECT execution_started_at,ended_at FROM agent_run WHERE subagent_id=$1",
          [id],
        )
      ).rows[0].execution_started_at,
    ).toBeTruthy();
  });

  it("恢复已写入最终结果的孤儿不重调模型，并补记用量与通知", async () => {
    const p = await parent();
    const id = await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      task: "恢复研读",
      message: "阅读交接",
    });
    const job = (await claimSubagents()).find((r) => r.subagent_id === id)!;
    const storage = (await PgSessionStorage.load(id))!;
    await storage.appendEntry({
      type: "message",
      id: `ain_child_${job.id}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "阅读交接", timestamp: Date.now() },
    });
    await storage.appendEntry({
      type: "message",
      id: `msg_${shortId()}`,
      parentId: `ain_child_${job.id}`,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已核对，来源 scene-a。" }],
        timestamp: Date.now(),
        api: CHAT_MODEL.api,
        model: CHAT_MODEL.id,
        provider: CHAT_MODEL.provider,
        usage,
        stopReason: "stop",
      },
    });
    await getPool().query(
      "UPDATE agent_run SET owner='旧进程',heartbeat_at=now()-interval '5 minutes' WHERE id=$1",
      [job.id],
    );
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    subagentRuntimeOverrides.streamFn = model([], seen);
    await recoverSubagents();
    await completed(p, id);
    expect(seen).toHaveLength(0);
    expect((await listSubagents(p.sessionId))[0].result).toContain("已核对");
    const recorded = (
      await getPool().query("SELECT input_tokens FROM agent_run WHERE id=$1", [
        job.id,
      ])
    ).rows[0].input_tokens;
    expect(recorded).toBe(usage.input);
    await checkpointChildUsage(job);
    expect(
      (
        await getPool().query(
          "SELECT input_tokens FROM agent_run WHERE id=$1",
          [job.id],
        )
      ).rows[0].input_tokens,
    ).toBe(recorded);
  });

  it("用量去重、根预算与额外额度扣款原子一致", async () => {
    const p = await parent();
    await getPool().query(
      "UPDATE agent_run SET paid_from='extra' WHERE id=$1",
      [p.runId],
    );
    await grantExtraCredits({ userId, credits: 10000, note: "子任务记账测试" });
    const before = await extraRemaining(userId);
    const id = await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      task: "计费研读",
      message: "测试",
    });
    const job = (await claimSubagents()).find((r) => r.subagent_id === id)!;
    const entryId = `acu_${shortId()}`;
    await Promise.all([
      recordChildUsage(job, entryId, {
        input: 10,
        output: 5,
        cacheRead: 2,
        usd: 0.001,
      }),
      recordChildUsage(job, entryId, {
        input: 10,
        output: 5,
        cacheRead: 2,
        usd: 0.001,
      }),
    ]);
    expect(await extraRemaining(userId)).toBe(before - creditsFromUsd(0.001));
    expect(
      (
        await getPool().query(
          "SELECT input_tokens FROM agent_run WHERE id=$1",
          [job.id],
        )
      ).rows[0].input_tokens,
    ).toBe(10);
    expect(
      Number(
        (
          await getPool().query(
            "SELECT task_credits FROM agent_run WHERE id=$1",
            [p.runId],
          )
        ).rows[0].task_credits,
      ),
    ).toBe(creditsFromUsd(0.001));
  });

  it("不同发布器并发写同会话事件仍保持唯一连续序号", async () => {
    const p = await parent();
    const publishers = Array.from(
      { length: 8 },
      () => new EventPublisher(p.sessionId, p.runId),
    );
    for (const publisher of publishers)
      publisher.publish({ type: "thinking", text: "核对来源" });
    await Promise.all(publishers.map((publisher) => publisher.drain()));
    expect(
      (await readEventsSince(p.sessionId, 0)).map((row) => row.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("同一子会话的追问只排队，不占第二个执行名额；队列满后明确拒绝", async () => {
    const p = await parent();
    const id = await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      task: "串行研读",
      message: "第一轮",
    });
    await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      id,
      message: "第二轮",
    });
    expect(
      (await claimSubagents()).filter((r) => r.subagent_id === id),
    ).toHaveLength(1);
    expect(
      (await claimSubagents()).filter((r) => r.subagent_id === id),
    ).toHaveLength(0);
    for (let i = 0; i < 7; i++)
      await queueSubagent({
        parentSessionId: p.sessionId,
        parentRunId: p.runId,
        id,
        message: `追问${i}`,
      });
    await expect(
      queueSubagent({
        parentSessionId: p.sessionId,
        parentRunId: p.runId,
        id,
        message: "超过上限",
      }),
    ).rejects.toThrow("排队已满");
  });

  it("跨主会话仍共用同一用户四个执行名额", async () => {
    const roots = [await parent(), await parent(), await parent()];
    const ids: string[] = [];
    for (const p of roots)
      for (let i = 0; i < 2; i++)
        ids.push(
          await queueSubagent({
            parentSessionId: p.sessionId,
            parentRunId: p.runId,
            task: "用户并发核对",
            message: "核对",
          }),
        );
    const claims = (await Promise.all([claimSubagents(), claimSubagents()]))
      .flat()
      .filter((r) => ids.includes(r.subagent_id));
    expect(claims).toHaveLength(4);
    expect(claims.some((r) => r.parent_session_id === roots[2].sessionId)).toBe(
      false,
    );
  });

  it("未交接的材料不会被读取，子任务也不能递归委托", async () => {
    const p = await parent();
    subagentRuntimeOverrides.streamFn = model([
      [
        {
          type: "toolCall",
          id: "outside",
          name: exposedName("material_read"),
          arguments: { sourceId: "未交接" },
        },
      ],
      "资料不足。",
    ]);
    const id = /as_[a-z0-9]+/.exec(
      await spawnSubagent(p, { task: "越界材料核对" }),
    )![0];
    await completed(p, id);
    const trace = JSON.parse(await readSubagent(p.sessionId, id));
    const result = trace.entries.find(
      (e: { payload: { message?: { role: string } } }) =>
        e.payload.message?.role === "toolResult",
    );
    expect(result.payload.message.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("不在此次交接范围");
    const job = (
      await getPool().query("SELECT id FROM agent_run WHERE subagent_id=$1", [
        id,
      ])
    ).rows[0];
    await expect(
      queueSubagent({
        parentSessionId: id,
        parentRunId: job.id,
        task: "递归",
        message: "递归",
      }),
    ).rejects.toThrow("交互主 Agent");
  });
  it("停止主任务同时停止子任务并清掉两侧待消费队列", async () => {
    const sessionId = createNewSessionKey(userId, prodId);
    runtimeOverrides.streamFn = model([], [], new Promise<void>(() => {}));
    const { runId } = await startRun({
      sessionId,
      userId,
      message: "研读全剧",
    });
    const p: RunHandle = {
      runId,
      sessionId,
      signal: new AbortController().signal,
      publish: () => {},
      setStatus: async () => {},
      isDetached: () => false,
    };
    parents.push(p);
    subagentRuntimeOverrides.streamFn = model(
      [],
      [],
      new Promise<void>(() => {}),
    );
    await spawnSubagent(p, { task: "核对第一场" });
    expect(await abortRun(sessionId)).toBe(true);
    await waitForIdle(sessionId);
    expect((await listSubagents(sessionId))[0].status).toBe("stopped");
    expect(
      (
        await getPool().query("SELECT status FROM agent_run WHERE id=$1", [
          runId,
        ])
      ).rows[0].status,
    ).toBe("aborted");
    expect(
      (
        await getPool().query(
          "SELECT id FROM agent_session_inbox WHERE session_id=$1",
          [sessionId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("孤儿中断在材料工具调用后时，只补读缺失结果，再继续模型轮次", async () => {
    const p = await parent();
    const id = await queueSubagent({
      parentSessionId: p.sessionId,
      parentRunId: p.runId,
      task: "中断研读",
      message: "研读",
      sources: [
        {
          id: "scene-a",
          title: "第一场",
          locator: "第一场第2段",
          content: "甲：我得照顾家里。",
        },
      ],
    });
    const job = (await claimSubagents()).find((r) => r.subagent_id === id)!;
    const storage = (await PgSessionStorage.load(id))!;
    await storage.appendEntry({
      type: "message",
      id: `ain_child_${job.id}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "研读", timestamp: Date.now() },
    });
    await storage.appendEntry({
      type: "message",
      id: `msg_${shortId()}`,
      parentId: `ain_child_${job.id}`,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "interrupted-read",
            name: exposedName("material_read"),
            arguments: { sourceId: "scene-a" },
          },
        ],
        timestamp: Date.now(),
        api: CHAT_MODEL.api,
        model: CHAT_MODEL.id,
        provider: CHAT_MODEL.provider,
        usage,
        stopReason: "toolUse",
      },
    });
    await getPool().query(
      "UPDATE agent_run SET owner='旧进程',heartbeat_at=now()-interval '5 minutes' WHERE id=$1",
      [job.id],
    );
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    subagentRuntimeOverrides.streamFn = model(["核对完成。"], seen);
    await recoverSubagents();
    await completed(p, id);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].messages)).toContain("甲：我得照顾家里");
    const trace = JSON.parse(await readSubagent(p.sessionId, id));
    expect(
      trace.entries.filter(
        (e: { payload: { message?: { role: string } } }) =>
          e.payload.message?.role === "toolResult",
      ),
    ).toHaveLength(1);
    await recoverSubagents();
    expect(seen).toHaveLength(1);
  });
});
