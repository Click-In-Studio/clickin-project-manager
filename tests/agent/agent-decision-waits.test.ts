import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { awaitApproval } from "@/lib/agent/runtime/approvals";
import { awaitQuestion } from "@/lib/agent/runtime/questions";

const notifications = vi.hoisted(() => ({
  wake: () => {},
  subscribed: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/lib/agent/runtime/events", () => ({
  EVENT_CHANNEL: "agent_events",
  subscribeDecisionEvents: async (kind: string, id: string, fn: () => void) => {
    notifications.wake = fn;
    await notifications.subscribed(kind, id);
    return notifications.unsubscribe;
  },
}));

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  notifications.subscribed.mockReset();
  notifications.unsubscribe.mockReset();
  notifications.wake = () => {};
});
afterEach(() => vi.useRealTimers());

describe.each([
  { kind: "approval", wait: awaitApproval, status: "allowed", outcome: { kind: "allowed", decision: "allow-once" } },
  { kind: "question", wait: awaitQuestion, status: "answered", outcome: { kind: "answered", answers: { q1: ["继续"] } } },
])("$kind 通知等待", ({ kind, wait, status, outcome }) => {
  function fixture(ttl = 60_000) {
    const row = { status: "pending", decision: null, reason: null, answer: { q1: ["继续"] }, expires_at: new Date(Date.now() + ttl) };
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ ...row }] : [], rowCount: 1 }));
    return { row, query, pool: { query } as unknown as Pool };
  }

  it("先订阅再读状态，订阅期间已决议也立即返回", async () => {
    const f = fixture();
    notifications.subscribed.mockImplementation(() => {
      expect(f.query).not.toHaveBeenCalled();
      f.row.status = status;
    });
    expect(await wait("card", undefined, f.pool)).toEqual(outcome);
    expect(notifications.subscribed).toHaveBeenCalledWith(kind, "card");
    expect(notifications.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("等待期间决议立即唤醒，无需推进兜底时钟", async () => {
    const f = fixture();
    const done = wait("card", undefined, f.pool);
    await flush();
    expect(f.query).toHaveBeenCalledTimes(1);
    f.row.status = status;
    notifications.wake();
    expect(await done).toEqual(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("读库期间的通知不丢失，多次通知合并为一次补读", async () => {
    const f = fixture();
    let release!: (value: { rows: typeof f.row[]; rowCount: number }) => void;
    f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const done = wait("card", undefined, f.pool);
    await flush();
    const pending = { ...f.row };
    f.row.status = status;
    for (let i = 0; i < 30; i++) notifications.wake();
    release({ rows: [pending], rowCount: 1 });
    expect(await done).toEqual(outcome);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("空闲时不做 400ms 查询；漏通知由 5 秒兜底发现", async () => {
    const f = fixture();
    const done = wait("card", undefined, f.pool);
    await flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.query).toHaveBeenCalledTimes(1);
    f.row.status = status;
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual(outcome);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("到期早于兜底时刻时按截止时间处理", async () => {
    const f = fixture(750);
    const done = wait("card", undefined, f.pool);
    await flush();
    await vi.advanceTimersByTimeAsync(750);
    expect(await done).toEqual({ kind: "expired" });
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("status = 'expired'");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("停止立即唤醒并取消待答记录", async () => {
    const f = fixture();
    const abort = new AbortController();
    const done = wait("card", abort.signal, f.pool);
    await flush();
    abort.abort();
    expect(await done).toEqual(kind === "approval" ? { kind: "denied", reason: "本轮已中止" } : { kind: "cancelled" });
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("status = 'cancelled'");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("排水立即脱离，待答记录保持原状供接管", async () => {
    const f = fixture();
    const abort = new AbortController();
    const done = wait("card", abort.signal, f.pool, { isDetached: () => true });
    await flush();
    abort.abort();
    expect(await done).toEqual({ kind: "detached" });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(notifications.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("读库期间停止，即使读到已批准也不返回继续执行", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.query.mockImplementationOnce(async () => {
      abort.abort();
      return { rows: [{ ...f.row, status }], rowCount: 1 };
    });
    const result = await wait("card", abort.signal, f.pool);
    expect(result.kind).toBe(kind === "approval" ? "denied" : "cancelled");
  });
});
