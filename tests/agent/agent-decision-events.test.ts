import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createApproval, resolveApproval } from "@/lib/agent/runtime/approvals";
import { createOrReuseQuestion, resolveQuestion } from "@/lib/agent/runtime/questions";
import { EVENT_CHANNEL, subscribeDecisionEvents, subscribeSessionEvents } from "@/lib/agent/runtime/events";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

describe("决议通知与现有事件分发", () => {
  let userId: string;
  let prodId: string;
  let sessionId: string;
  let runId: string;
  const releases: Array<() => void> = [];

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `decision-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
    sessionId = `session_${shortId()}`;
    runId = `run_${shortId()}`;
    await PgSessionStorage.create({ id: sessionId, userId, productionId: prodId });
    await getPool().query("INSERT INTO agent_run (id, session_id) VALUES ($1, $2)", [runId, sessionId]);
  });
  afterAll(async () => {
    for (const release of releases) release();
    await getPool().query("DELETE FROM agent_session WHERE id = $1", [sessionId]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  it("审批通知只唤醒该卡，重复决议不重复通知；session:0 仍到子任务消费者", async () => {
    const input = { sessionId, runId, tool: "test", args: {}, card: { title: "确认", description: "测试", severity: "warning" as const } };
    const a = await createApproval({ ...input, toolCallId: shortId() });
    const b = await createApproval({ ...input, toolCallId: shortId() });
    const seen: unknown[] = [];
    const unrelated = vi.fn();
    const session = vi.fn();
    releases.push(await subscribeDecisionEvents("approval", a.id, () => {
      void getPool().query("SELECT status, reason FROM agent_approval WHERE id = $1", [a.id]).then((r) => seen.push(r.rows[0]));
    }));
    releases.push(await subscribeDecisionEvents("approval", b.id, unrelated));
    releases.push(await subscribeSessionEvents(sessionId, session));
    expect(await resolveApproval(a.id, "deny", userId, "先别改")).toBe(true);
    await vi.waitFor(() => expect(seen).toEqual([{ status: "denied", reason: "先别改" }]));
    expect(await resolveApproval(a.id, "allow-once", userId)).toBe(false);
    await getPool().query("SELECT pg_notify($1, $2)", [EVENT_CHANNEL, `${sessionId}:0`]);
    await vi.waitFor(() => expect(session).toHaveBeenCalledWith(0));
    expect(unrelated).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    // 决议通知不伪造聊天事件，也不会顺带唤醒 session 的所有消费者。
    expect(session).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("回答/取消都通知且提交后才可见（cancel=%s）", async (cancel) => {
    const q = await createOrReuseQuestion({ sessionId, runId, toolCallId: shortId(), questions: [{ questionId: "q1", header: "选择", question: "继续吗", options: [{ label: "继续" }] }] });
    const seen: unknown[] = [];
    releases.push(await subscribeDecisionEvents("question", q.id, () => {
      void getPool().query("SELECT status, answer FROM agent_question WHERE id = $1", [q.id]).then((r) => seen.push(r.rows[0]));
    }));
    expect(await resolveQuestion(q.id, cancel ? { cancel: true } : { answers: { q1: ["继续"] } })).toBe(true);
    await vi.waitFor(() => expect(seen).toEqual([{ status: cancel ? "cancelled" : "answered", answer: cancel ? null : { q1: ["继续"] } }]));
    expect(await resolveQuestion(q.id, { cancel: true })).toBe(false);
  });

  it("决议和聊天订阅接入同一进程单例，不为每张卡创建 LISTEN 连接", () => {
    const source = readFileSync("lib/agent/runtime/events.ts", "utf8");
    expect(source).toContain("if (!g.__agentEventListener) g.__agentEventListener = new EventListener(getPool())");
    expect(source).toContain('return subscribeSessionEvents(`${kind}:${id}`, fn)');
    expect(source.match(/new EventListener\(/g)).toHaveLength(1);
  });
});
