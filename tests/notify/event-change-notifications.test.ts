import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { selfFollowEvent } from "@/lib/ops/event-db";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { PATCH as patchEvent } from "@/app/api/production/[id]/events/[eventId]/route";
import {
  dispatchEventChangeNotification,
  scheduleEventChangeNotification,
  type EventChangeBaseline,
} from "@/lib/notify/event-change";
import { dispatchEventPublishNotifications } from "@/lib/notify/notify";
import { getJobHandlerDef } from "@/lib/job/handlers";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

// 使用未来活动，避免真实读取路径将已过期的 published 活动自动完成。
const EVENT_START_MS = Date.now() + 24 * 60 * 60_000;
const OLD_START = new Date(EVENT_START_MS).toISOString();
const OLD_END = new Date(EVENT_START_MS + 2 * 60 * 60_000).toISOString();
const NEW_START = new Date(EVENT_START_MS + 60 * 60_000).toISOString();
const NEW_END = new Date(EVENT_START_MS + 3 * 60 * 60_000).toISOString();

let prodId: string;
let ownerId: string;
let participantId: string;
let followerId: string;
let callOnlyId: string;
let outsiderId: string;
const eventIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  return (await upsertFeishuUser(`notify-${tag}-${shortId()}`, `${tag}-${shortId()}`, null, false)).userId;
}

async function makeEvent(status: "published" | "cancelled" | "completed" | "draft") {
  const eventId = `ev_${shortId()}`;
  eventIds.push(eventId);
  await getPool().query(
    `INSERT INTO production_event
       (id, production_id, title, location, start_time, end_time, status, created_by)
     VALUES ($1, $2, '晚排', '一号排练厅', $3, $4, $5, $6)`,
    [eventId, prodId, OLD_START, OLD_END, status, ownerId],
  );
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name, role)
     VALUES ($1, $2, $3, '参与者', 'participant')`,
    [`ep_${shortId()}`, eventId, participantId],
  );
  await selfFollowEvent(eventId, followerId, "关注者");
  const callId = `ct_${shortId()}`;
  await getPool().query(
    `INSERT INTO event_call_time
       (id, event_id, user_id, name, call_at, confirmed_at)
     VALUES ($1, $2, $3, 'Call成员', $4, now())`,
    [callId, eventId, callOnlyId, OLD_START],
  );
  await getPool().query(
    `INSERT INTO event_call_time
       (id, event_id, user_id, name, call_at, confirmed_at)
     VALUES ($1, $2, $3, '参与且有Call', $4, now())`,
    [`ct_${shortId()}`, eventId, participantId, OLD_START],
  );
  return { eventId, callId };
}

const baseline = (): EventChangeBaseline => ({
  status: "published",
  startTime: OLD_START,
  endTime: OLD_END,
  location: "一号排练厅",
});

function patchRequest(body: Record<string, unknown>): NextRequest {
  const req = new NextRequest("http://localhost/api/event", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  req.cookies.set(SESSION_COOKIE, createSession({
    userId: ownerId, name: "owner", avatarUrl: null, isAdmin: false,
  }));
  return req;
}

beforeAll(async () => {
  [ownerId, participantId, followerId, callOnlyId, outsiderId] = await Promise.all([
    makeUser("owner"), makeUser("participant"), makeUser("follower"),
    makeUser("call"), makeUser("outsider"),
  ]);
  ({ prodId } = await makeProduction(ownerId));
  await getPool().query(
    `INSERT INTO notification_subscription (user_id, notification_type, enabled)
     SELECT unnest($1::uuid[]), 'event_publish', false
     ON CONFLICT (user_id, notification_type) DO UPDATE SET enabled = false`,
    [[participantId, followerId, callOnlyId, outsiderId]],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM job WHERE dedupe_key LIKE 'event_change_notify:%'").catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [
    [ownerId, participantId, followerId, callOnlyId, outsiderId],
  ]).catch(() => {});
});

async function notifications(eventId: string) {
  return (await getPool().query<{
    user_id: string; title: string; body: string; category: string;
    action_required: boolean; actions: unknown[];
  }>(
    `SELECT user_id, title, body, category, action_required, actions
     FROM user_notification WHERE kind = 'event_publish'
       AND (entity_id = $1 OR entity_id IN (SELECT id FROM event_call_time WHERE event_id = $1))`,
    [eventId],
  )).rows;
}

describe("已发布活动变更通知（#547）", () => {
  it("首次发布覆盖参与者、关注者和 Call Time 成员，重叠身份只收一条", async () => {
    const { eventId } = await makeEvent("published");
    await dispatchEventPublishNotifications(eventId);

    const rows = await notifications(eventId);
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [participantId, followerId, callOnlyId].sort(),
    );
    expect(rows.find((row) => row.user_id === callOnlyId)?.action_required).toBe(true);
    expect(rows.find((row) => row.user_id === participantId)?.action_required).toBe(true);
    expect(rows.find((row) => row.user_id === followerId)?.action_required).toBe(false);
  });

  it("取消通知参与者、关注者和 Call Time 成员，醒目但不要求操作", async () => {
    const { eventId } = await makeEvent("cancelled");
    const result = await dispatchEventChangeNotification({ eventId, before: baseline() });
    expect(result).toMatchObject({ sent: 3, cancelled: true });

    const rows = await notifications(eventId);
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [participantId, followerId, callOnlyId].sort(),
    );
    expect(rows.every((row) => row.title.includes("已取消"))).toBe(true);
    expect(rows.every((row) => row.category === "warning")).toBe(true);
    expect(rows.every((row) => !row.action_required && row.actions.length === 0)).toBe(true);
    expect(rows.some((row) => row.user_id === outsiderId)).toBe(false);
  });

  it("改期和改地点合成新旧值；Call Time 成员清空确认并收到新确认动作", async () => {
    const { eventId, callId } = await makeEvent("published");
    await getPool().query(
      `UPDATE production_event SET start_time = $2, end_time = $3, location = '二号排练厅'
       WHERE id = $1`,
      [eventId, NEW_START, NEW_END],
    );

    const result = await dispatchEventChangeNotification({ eventId, before: baseline() });
    expect(result).toMatchObject({ sent: 3, cancelled: false, changes: 3 });

    const rows = await notifications(eventId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.body.includes("一号排练厅 → 二号排练厅"))).toBe(true);
    const callNotice = rows.find((row) => row.user_id === callOnlyId)!;
    expect(callNotice.category).toBe("action");
    expect(callNotice.action_required).toBe(true);
    expect(callNotice.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effects: expect.arrayContaining([expect.objectContaining({ entityId: callId })]),
      }),
    ]));
    expect(rows.find((row) => row.user_id === participantId)?.action_required).toBe(true);
    expect(rows.find((row) => row.user_id === followerId)?.action_required).toBe(false);

    const calls = await getPool().query<{ confirmed_at: Date | null }>(
      "SELECT confirmed_at FROM event_call_time WHERE event_id = $1", [eventId],
    );
    expect(calls.rows.every((row) => row.confirmed_at === null)).toBe(true);
  });

  it("改期时旧 Call Time 动作统一失效，再生成一份可操作的新确认", async () => {
    const { eventId } = await makeEvent("published");
    await dispatchEventPublishNotifications(eventId);
    await getPool().query(
      `UPDATE production_event SET location = '二号排练厅' WHERE id = $1`,
      [eventId],
    );
    await dispatchEventChangeNotification({ eventId, before: baseline() });

    const actionRows = await getPool().query<{ title: string; expired_at: Date | null }>(
      `SELECT title, expired_at FROM user_notification
       WHERE action_required = true
         AND entity_id IN (SELECT id FROM event_call_time WHERE event_id = $1)`,
      [eventId],
    );
    expect(actionRows.rows.filter((row) => row.title.includes("已发布")))
      .toHaveLength(2);
    expect(actionRows.rows.filter((row) => row.title.includes("已发布"))
      .every((row) => row.expired_at !== null)).toBe(true);
    expect(actionRows.rows.filter((row) => row.title.includes("安排有变")))
      .toHaveLength(2);
    expect(actionRows.rows.filter((row) => row.title.includes("安排有变"))
      .every((row) => row.expired_at === null)).toBe(true);
  });

  it.each(["completed", "draft"] as const)("当前状态为 %s 时零通知", async (status) => {
    const { eventId } = await makeEvent(status);
    const result = await dispatchEventChangeNotification({ eventId, before: baseline() });
    expect(result).toEqual({ skipped: status });
    expect(await notifications(eventId)).toEqual([]);
  });

  it("净变化为零时不通知", async () => {
    const { eventId } = await makeEvent("published");
    expect(await dispatchEventChangeNotification({ eventId, before: baseline() }))
      .toEqual({ skipped: "no_net_change" });
    expect(await notifications(eventId)).toEqual([]);
  });

  it("同一事件 5 分钟窗口只保留首笔基线，且 handler 已接入生产注册表", async () => {
    const { eventId } = await makeEvent("published");
    const saved = process.env.JOB_WORKER;
    process.env.JOB_WORKER = "1";
    try {
      await scheduleEventChangeNotification(eventId, baseline());
      await scheduleEventChangeNotification(eventId, { ...baseline(), location: "中间地点" });
    } finally {
      if (saved === undefined) delete process.env.JOB_WORKER;
      else process.env.JOB_WORKER = saved;
    }

    const jobs = await getPool().query<{ payload: { before: EventChangeBaseline }; run_after: Date; created_at: Date }>(
      `SELECT payload, run_after, created_at FROM job
       WHERE dedupe_key = $1 AND status = 'queued'`,
      [`event_change_notify:${eventId}`],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].payload.before.location).toBe("一号排练厅");
    expect(jobs.rows[0].run_after.getTime() - jobs.rows[0].created_at.getTime()).toBeGreaterThanOrEqual(299_000);
    expect(getJobHandlerDef("event_change_notify")).not.toBeNull();
  });

  it("PATCH 只为取消或净时间地点变更排任务，完成不排", async () => {
    const saved = process.env.JOB_WORKER;
    process.env.JOB_WORKER = "1";
    try {
      const cancelled = await makeEvent("published");
      const cancelRes = await patchEvent(patchRequest({ status: "cancelled" }), {
        params: Promise.resolve({ id: prodId, eventId: cancelled.eventId }),
      });
      expect(cancelRes.status).toBe(200);

      const changed = await makeEvent("published");
      const changeRes = await patchEvent(patchRequest({ location: "新地点" }), {
        params: Promise.resolve({ id: prodId, eventId: changed.eventId }),
      });
      expect(changeRes.status).toBe(200);

      const completed = await makeEvent("published");
      const completeRes = await patchEvent(patchRequest({ status: "completed" }), {
        params: Promise.resolve({ id: prodId, eventId: completed.eventId }),
      });
      expect(completeRes.status).toBe(200);

      const jobs = await getPool().query<{ key: string }>(
        `SELECT dedupe_key AS key FROM job WHERE dedupe_key = ANY($1::text[])`,
        [[cancelled.eventId, changed.eventId, completed.eventId].map((id) => `event_change_notify:${id}`)],
      );
      expect(jobs.rows.map((row) => row.key).sort()).toEqual([
        `event_change_notify:${cancelled.eventId}`,
        `event_change_notify:${changed.eventId}`,
      ].sort());
    } finally {
      if (saved === undefined) delete process.env.JOB_WORKER;
      else process.env.JOB_WORKER = saved;
    }
  });
});
