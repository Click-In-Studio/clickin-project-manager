import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  listEventTaskCounts,
  listScheduleItemsWithParticipants,
  createProductionEvent,
} from "@/lib/event-db";
import { filterDraftVisibleEvents } from "@/lib/event-permissions";
import { createProductionDept } from "@/lib/dept-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// UI v3 计划面板数据层（PR #233 review 1/2/4）：
// listEventTaskCounts 聚合隔离、schedule enriched 形状、draft 可见性共享 helper 三分支

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let otherProdId: string;
let userId: string;
let eventA: string;
let eventB: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  ({ prodId: otherProdId } = await makeProduction());
  userId = await newUser();
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [prodId, userId],
  );

  const evA = await createProductionEvent({
    id: `ev${shortId()}`, productionId: prodId, title: "任务计数A",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: userId,
  });
  eventA = evA.id;
  const evB = await createProductionEvent({
    id: `ev${shortId()}`, productionId: prodId, title: "零任务B",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: userId,
  });
  eventB = evB.id;
  // 另一 production 的 event+task（隔离对照）
  const evX = await createProductionEvent({
    id: `ev${shortId()}`, productionId: otherProdId, title: "隔离X",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: userId,
  });
  await getPool().query(
    `INSERT INTO task (id, production_id, event_id, title, status) VALUES
       ($1, $4, $3, '任务1', 'pending'), ($2, $4, $3, '任务2', 'pending')`,
    [`r${shortId()}`, `r${shortId()}`, eventA, prodId],
  );
  await getPool().query(
    `INSERT INTO task (id, production_id, event_id, title, status) VALUES ($1, $3, $2, '别家任务', 'pending')`,
    [`r${shortId()}`, evX.id, otherProdId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

describe("listEventTaskCounts", () => {
  it("按 event 聚合且 production 隔离；零任务事件不出现在 map", async () => {
    const counts = await listEventTaskCounts(prodId);
    expect(counts[eventA]).toBe(2);
    expect(counts[eventB]).toBeUndefined();
    expect(Object.keys(counts)).toHaveLength(1);  // 别家 production 的不混入
  });
});

describe("listScheduleItemsWithParticipants（schedule GET 契约形状）", () => {
  it("携带 participants 与 departmentIds 字段", async () => {
    const dept = await createProductionDept({ productionId: prodId, name: `泳道${shortId()}` });
    const { rows: [{ id: itemId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO event_schedule_item (id, event_id, title, start_time, end_time)
       VALUES ($1, $2, '走位', NOW(), NOW() + interval '30 min') RETURNING id`,
      [`si${shortId()}`, eventA],
    );
    await getPool().query(
      "INSERT INTO schedule_item_department (item_id, dept_id) VALUES ($1, $2)",
      [itemId, dept.id],
    );
    await getPool().query(
      "INSERT INTO schedule_item_participant (item_id, user_id, name) VALUES ($1, $2, '参与者')",
      [itemId, userId],
    );
    const items = await listScheduleItemsWithParticipants(eventA);
    const item = items.find(i => i.id === itemId)!;
    expect(item).toBeDefined();
    expect(item.departmentIds).toContain(dept.id);
    expect(item.participants.map(p => p.userId)).toContain(userId);
  });
});

describe("filterDraftVisibleEvents（事件页/计划页共享三分支）", () => {
  const mk = (id: string, status: string) => ({ id, status });
  const list = [mk("e-pub", "published"), mk("e-draft", "draft"), mk("e-done", "completed")];

  it("admin/owner 旁路：全量可见", async () => {
    const admin = await filterDraftVisibleEvents({ userId, isAdmin: true, isOwner: false }, prodId, list);
    expect(admin).toHaveLength(3);
    const owner = await filterDraftVisibleEvents({ userId, isAdmin: false, isOwner: true }, prodId, list);
    expect(owner).toHaveLength(3);
  });

  it("无行成员：仅 published/completed", async () => {
    const res = await filterDraftVisibleEvents({ userId, isAdmin: false, isOwner: false }, prodId, list);
    expect(res.map(e => e.id).sort()).toEqual(["e-done", "e-pub"]);
  });

  it("实例 publication@view 行：对应 draft 进入可见集", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'event', 'e-draft', 'publication', 'view', 'direct')`,
      [prodId, userId],
    );
    const res = await filterDraftVisibleEvents({ userId, isAdmin: false, isOwner: false }, prodId, list);
    expect(res.map(e => e.id).sort()).toEqual(["e-done", "e-draft", "e-pub"]);
  });
});
