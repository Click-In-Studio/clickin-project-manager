import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEventReport, updateEventReport, selfFollowEvent } from "@/lib/ops/event-db";
import { dispatchReportNotification } from "@/lib/notify/notify";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

// #546 回归：报告发布通知的收件人 = event_participant（含 role='follower'）∪ event_call_time。
// 「关注」没有独立表，是 event_participant 里的一行 role='follower'；收件人查询不按 role 过滤，
// 所以只关注、不参与、无 Call Time 的人也收 report_broadcast。这里把它锁住，防止将来有人
// 给收件人查询加上 role = 'participant'。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let eventId: string;
let reportId: string;
let author: string;
let followerOnly: string;
let participantWithCall: string;
let followerWithCall: string;
let outsider: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [author, followerOnly, participantWithCall, followerWithCall, outsider] =
    await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);

  eventId = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '排练', $3, 'published')`,
    [eventId, prodId, author],
  );
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name) VALUES ($1, $2, $3, '参与者')`,
    [`ep${shortId()}`, eventId, participantWithCall],
  );
  // 走真实的「关注」写点，而不是手插 role='follower'
  await selfFollowEvent(eventId, followerOnly, "只关注");
  await selfFollowEvent(eventId, followerWithCall, "关注且有CallTime");
  for (const uid of [participantWithCall, followerWithCall]) {
    await getPool().query(
      `INSERT INTO event_call_time (id, event_id, user_id, name, call_at) VALUES ($1, $2, $3, 'x', now())`,
      [`ct${shortId()}`, eventId, uid],
    );
  }

  reportId = `rp${shortId()}`;
  await createEventReport({ id: reportId, eventId, reportType: "rehearsal", title: "报告", body: "正文", createdBy: author });
  await updateEventReport(reportId, eventId, { publishedAt: new Date().toISOString() });
  // dryRun：不发外部消息，但 inbox 行照写——收件人集合以 user_notification 为判据
  const result = await dispatchReportNotification(reportId, eventId, prodId, true);
  expect(result.errors).toEqual([]);
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)",
    [[author, followerOnly, participantWithCall, followerWithCall, outsider]]).catch(() => {});
});

async function inboxCount(userId: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM user_notification
     WHERE user_id = $1 AND kind = 'report_broadcast' AND entity_type = 'report' AND entity_id = $2`,
    [userId, reportId],
  );
  return Number(res.rows[0].n);
}

describe("dispatchReportNotification recipients (#546)", () => {
  it("follower-only member (no participation, no call time) receives report_broadcast", async () => {
    expect(await inboxCount(followerOnly)).toBe(1);
  });

  it("participant who also has a call time receives exactly one", async () => {
    expect(await inboxCount(participantWithCall)).toBe(1);
  });

  it("follower who also has a call time receives exactly one", async () => {
    expect(await inboxCount(followerWithCall)).toBe(1);
  });

  it("member with no relation to the event receives nothing", async () => {
    expect(await inboxCount(outsider)).toBe(0);
  });
});
