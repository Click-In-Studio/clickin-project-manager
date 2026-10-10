import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createRunnerStreamResponse } from "@/lib/agent/runtime/dispatch";
import type { EventRow } from "@/lib/agent/runtime/events";

const state = vi.hoisted(() => ({
  wake: () => {},
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  read: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@/lib/agent/runtime/events", () => ({
  readEventsSince: (...args: unknown[]) => state.read(...args),
  subscribeSessionEvents: async (_id: string, fn: () => void) => {
    state.wake = fn;
    await state.subscribe();
    return state.unsubscribe;
  },
}));
vi.mock("@/lib/pg", () => ({ getPool: () => ({ query: state.query }) }));
vi.mock("@/lib/agent/runtime/service", () => ({ SessionBusyError: class extends Error {} }));
vi.mock("@/lib/agent/runtime/client", () => ({ startRun: vi.fn() }));

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.subscribe.mockReset();
  state.read.mockReset().mockResolvedValue([]);
  state.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes("MAX(seq)") ? [{ seq: "10" }] : sql.includes("FROM agent_run") ? [{ status: "running" }] : [],
  }));
});
afterEach(() => vi.useRealTimers());

function open(startRun?: () => Promise<{ runId: string }>) {
  const abort = new AbortController();
  const req = new NextRequest("http://localhost/api/agent/chat/stream", { signal: abort.signal });
  const response = createRunnerStreamResponse(req, "session", { startRun });
  const frames: unknown[] = [];
  const reader = response.body!.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const frame = await reader.read();
      if (frame.done) return;
      frames.push(JSON.parse(decoder.decode(frame.value).slice(6)));
    }
  })();
  return { abort, reader, frames, done };
}

describe("聊天通知驱动读取", () => {
  it("订阅间隙的 final 不等兜底就补读，并关闭流", async () => {
    state.subscribe.mockImplementation(() => {
      state.read.mockResolvedValue([{ seq: 11, line: { type: "final", text: "完成" } }]);
    });
    const s = open();
    await s.done;
    expect(state.read).toHaveBeenCalledWith("session", 10);
    expect(s.frames.at(-1)).toEqual({ type: "final", text: "完成" });
    expect(state.unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("启动时先发 session，再输出正文与终态", async () => {
    state.read.mockResolvedValue([{ seq: 11, line: { type: "final", text: "完成" } }]);
    const s = open(async () => ({ runId: "run" }));
    await s.done;
    expect(s.frames).toEqual([{ type: "ping" }, { type: "session", key: "session", runId: "run" }, { type: "final", text: "完成" }]);
  });

  it("通知立即推进游标，读取期间的重复通知只补读一次", async () => {
    const s = open();
    await flush();
    expect(state.read).toHaveBeenCalledTimes(1);
    let release!: (rows: EventRow[]) => void;
    state.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    state.wake();
    await flush();
    for (let i = 0; i < 50; i++) state.wake();
    release([{ seq: 11, line: { type: "delta", text: "正在写" } }]);
    await flush();
    expect(state.read).toHaveBeenCalledTimes(3);
    expect(state.read).toHaveBeenLastCalledWith("session", 11);
    expect(s.frames).toContainEqual({ type: "delta", text: "正在写" });
    s.abort.abort();
    await s.done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("空闲 5 秒才兜底一次，持续通知不推迟 15 秒心跳", async () => {
    const s = open();
    await flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.read).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      state.wake();
      await flush();
    }
    expect(s.frames.filter((frame) => (frame as { type: string }).type === "ping")).toHaveLength(2);
    s.abort.abort();
    await s.done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attach 的补发卡与事件补读重叠时只展示一张审批卡", async () => {
    const approval = { id: "card", title: "确认", description: "修改", severity: "warning", allowedDecisions: ["allow-once", "deny"], toolCallId: "call" };
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("MAX(seq)") ? [{ seq: "10" }] : sql.includes("FROM agent_run") ? [{ status: "awaiting_approval" }] : [{ id: "card", tool_call_id: "call", preview: approval }],
    }));
    state.read.mockResolvedValue([
      { seq: 11, line: { type: "approval", approval } },
      { seq: 12, line: { type: "approval-resolved", id: "card", decision: "allow-once" } },
      { seq: 13, line: { type: "final", text: "完成" } },
    ]);
    const s = open();
    await s.done;
    expect(s.frames.filter((frame) => (frame as { type: string }).type === "approval")).toHaveLength(1);
    expect(s.frames).toContainEqual({ type: "approval-resolved", id: "card", decision: "allow-once" });
  });

  it("订阅尚未完成时断开，完成后仍释放订阅且不启动 run", async () => {
    let subscribed!: () => void;
    state.subscribe.mockImplementation(() => new Promise<void>((resolve) => { subscribed = resolve; }));
    const start = vi.fn(async () => ({ runId: "run" }));
    const s = open(start);
    await flush();
    s.abort.abort();
    subscribed();
    await flush();
    await s.done;
    expect(start).not.toHaveBeenCalled();
    expect(state.unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("读库期间客户端取消，结果回来后不再发送或留下计时器", async () => {
    let release!: (rows: EventRow[]) => void;
    state.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const s = open();
    await flush();
    await s.reader.cancel();
    release([{ seq: 11, line: { type: "delta", text: "不应发送" } }]);
    await flush();
    await s.done;
    expect(s.frames).toEqual([{ type: "ping" }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
