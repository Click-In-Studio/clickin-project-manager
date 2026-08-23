import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProductionMember, upsertFeishuUser } from "@/lib/db";
import { createProductionEvent, createScheduleItem, listMyScheduleRange } from "@/lib/event-db";
import { createEventGroup, setScheduleItemGroups } from "@/lib/event-group-db";
import { getPool } from "@/lib/pg";
import { cleanupProduction, makeProduction, shortId } from "./factories";

let prodId: string;
let ownerId: string;
let userId: string;
let outsiderId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `日历主${shortId()}`, null, false)).userId;
  userId = (await upsertFeishuUser(`test-open-${shortId()}`, `日历成员${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `日历路人${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, userId);
  await addProductionMember(prodId, outsiderId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("个人月历完整口径", () => {
  it("合并 call、参与事件、指派任务、直接/部门/用户组流程项", async () => {
    const eventId = `ev_${shortId()}`;
    const start = "2026-09-10T02:00:00.000Z";
    await createProductionEvent({
      id: eventId, productionId: prodId, title: "合成排练", eventType: "rehearsal",
      location: "主剧场", startTime: start, endTime: "2026-09-10T08:00:00.000Z",
      description: "整场", createdBy: ownerId,
    });
    await getPool().query(
      `INSERT INTO event_participant (id, event_id, user_id, name)
       VALUES ($1, $2, $3, '日历成员')`,
      [`ep_${shortId()}`, eventId, userId],
    );
    await getPool().query(
      `INSERT INTO event_call_time (id, event_id, user_id, name, call_at, notes)
       VALUES ($1, $2, $3, '日历成员', $4, '提前化妆')`,
      [`ct_${shortId()}`, eventId, userId, "2026-09-10T01:00:00.000Z"],
    );

    const directItem = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "直接点名流程", itemType: "custom",
      startTime: "2026-09-10T03:00:00.000Z", endTime: null, location: "台口",
      orderIndex: 0, targetSceneId: null, targetBlockId: null, notes: "",
    });
    await getPool().query(
      `INSERT INTO schedule_item_participant (item_id, user_id, name) VALUES ($1, $2, '日历成员')`,
      [directItem.id, userId],
    );

    const { rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
      [prodId, `日历部门${shortId()}`],
    );
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1, $2, $3)`,
      [prodId, deptId, userId],
    );
    const deptItem = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "部门流程", itemType: "custom",
      startTime: "2026-09-10T04:00:00.000Z", endTime: null, location: "侧台",
      orderIndex: 1, targetSceneId: null, targetBlockId: null, notes: "",
    });
    await getPool().query(
      `INSERT INTO schedule_item_department (item_id, dept_id) VALUES ($1, $2)`,
      [deptItem.id, deptId],
    );

    const group = await createEventGroup({
      productionId: prodId, eventId, name: `日历组${shortId()}`,
      members: [{ kind: "user", id: userId }], poc: null, createdBy: ownerId,
    });
    const groupItem = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "用户组流程", itemType: "custom",
      startTime: "2026-09-10T05:00:00.000Z", endTime: null, location: "后台",
      orderIndex: 2, targetSceneId: null, targetBlockId: null, notes: "",
    });
    await setScheduleItemGroups(groupItem.id, eventId, prodId, [group.id]);

    const taskId = `task_${shortId()}`;
    await getPool().query(
      `INSERT INTO task (id, production_id, event_id, title, start_time)
       VALUES ($1, $2, $3, '我的跟进任务', $4)`,
      [taskId, prodId, eventId, "2026-09-10T06:00:00.000Z"],
    );
    await getPool().query(
      `INSERT INTO task_assignee (task_id, user_id, name) VALUES ($1, $2, '日历成员')`,
      [taskId, userId],
    );

    // 仅在参与名单、既无我的 call 也无排给我的流程项的事件：兜底「参与事件」条目要出现
    const soloEventId = `ev_${shortId()}`;
    await createProductionEvent({
      id: soloEventId, productionId: prodId, title: "全组说明会", eventType: "meeting",
      location: "排练厅", startTime: "2026-09-10T09:00:00.000Z", endTime: "2026-09-10T10:00:00.000Z",
      description: "", createdBy: ownerId,
    });
    await getPool().query(
      `INSERT INTO event_participant (id, event_id, user_id, name)
       VALUES ($1, $2, $3, '日历成员')`,
      [`ep_${shortId()}`, soloEventId, userId],
    );

    const rows = await listMyScheduleRange(
      userId, new Date("2026-09-09T16:00:00.000Z"), new Date("2026-09-10T16:00:00.000Z"),
    );
    expect(new Set(rows.map(row => row.kind))).toEqual(new Set(["call", "event", "task", "schedule"]));
    // 折叠口径：合成排练已有我的 call 与流程项，「参与事件」兜底条目只剩说明会一条
    expect(rows.filter(row => row.kind === "event").map(row => row.title)).toEqual(["全组说明会"]);
    expect(rows.filter(row => row.kind === "schedule").map(row => row.title).sort())
      .toEqual(["直接点名流程", "用户组流程", "部门流程"].sort());
    expect(rows.find(row => row.kind === "call")?.notes).toBe("提前化妆");
    expect((await listMyScheduleRange(
      outsiderId, new Date("2026-09-09T16:00:00.000Z"), new Date("2026-09-10T16:00:00.000Z"),
    ))).toEqual([]);
  });
});
