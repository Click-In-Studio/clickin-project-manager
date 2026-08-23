/**
 * 用户组冻结的语义锁。
 *
 * 中心命题：**冻结之后，组可以独立更改，但不影响这个 event。**
 * 每条都成对写「冻之前会变 / 冻之后不变」，因为冻结的价值全在那个「不变」上。
 *
 *   1. 冻的是 event × group，不是 group 本身（B 型组冻了这场不影响那场）
 *   2. 完整快照：人 + 他当时以什么身份在场（via_dept_*）+ 当时的 POC
 *   3. 冻结后成员不再随部门变动（活引用被切断）
 *   4. POC 分裂：追责读快照那位；组换 POC 不影响已冻 event 的 task 权限
 *   5. 权限不自动漂移：快照 POC 失效也不会自动落到别人头上
 *   6. refreeze 追加不覆盖，历史留存
 *   7. deadline：end_time + 宽限期，cron 幂等
 *   8. 解散守卫只挡未冻结引用
 *   9. 关系视图只给陈述不给结论
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, getProductionPermissionContext } from "@/lib/db";
import {
  createProductionEvent, createScheduleItem, createEventTechReq, getTechReqByProduction,
} from "@/lib/event-db";
import { createEventGroup, deleteEventGroup, EventGroupError, setScheduleItemGroups } from "@/lib/event-group-db";
import {
  FREEZE_GRACE_DAYS, describeFrozenGroups, freezeEventGroups, freezeExpiredEventGroups,
  frozenGroupPocUserIds, frozenGroupUserIds, isEventFrozen, isGroupFrozenForEvent,
  unfreezeEventGroups,
} from "@/lib/event-group-freeze";
import { canEnterEvent } from "@/lib/event-permissions";
import { isTaskPoc } from "@/lib/task-poc";
import { toActor } from "@/lib/grant-check";

let prodId: string;
let ownerId: string, organizerId: string, pocId: string, newbieId: string, runnerId: string, laterId: string;
let eventId: string, otherEventId: string, deptId: string;

async function actorOf(userId: string) {
  const access = await getProductionPermissionContext(userId, false, prodId);
  return toActor({ userId }, access!.permCtx);
}

async function makeEvent(title: string, endTime: string | null = null) {
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title,
    eventType: "rehearsal", location: "", startTime: null, endTime,
    description: "", createdBy: organizerId,
  });
  return ev.id;
}

async function bindGroupToNewItem(evId: string, groupId: string) {
  const item = await createScheduleItem({
    id: `si_${shortId()}`, eventId: evId, title: "对光", itemType: "custom",
    startTime: null, endTime: null, location: "", orderIndex: 0,
    targetSceneId: null, targetBlockId: null, notes: "",
  });
  await setScheduleItemGroups(item.id, evId, prodId, [groupId]);
  return item.id;
}

beforeAll(async () => {
  ownerId     = (await upsertFeishuUser(`test-open-${shortId()}`, `冻主${shortId()}`, null, false)).userId;
  organizerId = (await upsertFeishuUser(`test-open-${shortId()}`, `冻组织${shortId()}`, null, false)).userId;
  pocId       = (await upsertFeishuUser(`test-open-${shortId()}`, `冻灯POC${shortId()}`, null, false)).userId;
  newbieId    = (await upsertFeishuUser(`test-open-${shortId()}`, `冻新POC${shortId()}`, null, false)).userId;
  runnerId    = (await upsertFeishuUser(`test-open-${shortId()}`, `冻runner${shortId()}`, null, false)).userId;
  laterId     = (await upsertFeishuUser(`test-open-${shortId()}`, `冻后来者${shortId()}`, null, false)).userId;

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [organizerId, pocId, newbieId, runnerId, laterId]) await addProductionMember(prodId, u);

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `冻灯光${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
     VALUES ($1,$2,$3,true), ($1,$2,$4,false)`,
    [prodId, deptId, pocId, newbieId],
  );

  eventId = await makeEvent("上海站进场");
  otherEventId = await makeEvent("北京站进场");
});

afterAll(async () => {
  await getPool().query(
    "DELETE FROM production_event WHERE production_id = $1", [prodId],
  ).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

/** 项目级（B 型）组：灯光部 + 一个 runner，POC 是灯光部 */
async function makeBGroup(name: string) {
  return createEventGroup({
    productionId: prodId, eventId: null, name: `${name}${shortId()}`,
    members: [{ kind: "dept", id: deptId }, { kind: "user", id: runnerId }],
    poc: { kind: "dept", id: deptId },
    createdBy: ownerId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 冻的是 event × group，不是 group 本身", () => {
  it("同一个 B 型组，这场冻了那场没冻", async () => {
    const g = await makeBGroup("跨场组");
    await bindGroupToNewItem(eventId, g.id);
    await bindGroupToNewItem(otherEventId, g.id);

    await freezeEventGroups(eventId, organizerId);

    expect(await isGroupFrozenForEvent(eventId, g.id)).toBe(true);
    expect(await isGroupFrozenForEvent(otherEventId, g.id)).toBe(false);
    expect(await isEventFrozen(otherEventId)).toBe(false);

    await unfreezeEventGroups(eventId);
  });
});

describe("2. 完整快照：人 + 身份 + 当时的 POC", () => {
  it("直接成员与部门带入的人各留一行，部门那行记得下 via_dept_*", async () => {
    const ev = await makeEvent("快照场");
    const g = await makeBGroup("快照组");
    await bindGroupToNewItem(ev, g.id);
    await freezeEventGroups(ev, organizerId);

    const [snap] = await describeFrozenGroups(ev);
    expect(snap.groupName).toContain("快照组");

    const direct = snap.members.find(m => m.userId === runnerId);
    expect(direct?.viaDeptId).toBeNull();   // 直接个人成员

    const viaDept = snap.members.find(m => m.userId === pocId);
    expect(viaDept?.viaDeptId).toBe(deptId);
    expect(viaDept?.viaDeptName).toBeTruthy();  // 「他当时以灯光部的身份在场」
    expect(viaDept?.wasPoc).toBe(true);
    expect(direct?.wasPoc).toBe(false);

    // POC 部门型：部门与「当时该部门的实际 POC 那个人」都冻下来
    expect(snap.pocDeptId).toBe(deptId);
    expect(snap.pocUserId).toBe(pocId);
    expect(snap.pocUserName).toBeTruthy();
  });

  it("部门有多个 POC 时全部写入快照并获得冻结后的 POC 权限", async () => {
    const ev = await makeEvent("多 POC 快照场");
    const g = await makeBGroup("多 POC 组");
    await bindGroupToNewItem(ev, g.id);
    await getPool().query(
      `UPDATE production_dept_member SET is_poc = true
        WHERE production_id = $1 AND dept_id = $2 AND user_id = $3`,
      [prodId, deptId, newbieId],
    );

    try {
      await freezeEventGroups(ev, organizerId);
      const pocIds = await frozenGroupPocUserIds(ev, g.id);
      expect(new Set(pocIds)).toEqual(new Set([pocId, newbieId]));

      const [snap] = await describeFrozenGroups(ev);
      const markedPocs = snap.members.filter(m => m.wasPoc).map(m => m.userId);
      expect(new Set(markedPocs)).toEqual(new Set([pocId, newbieId]));
    } finally {
      await getPool().query(
        `UPDATE production_dept_member SET is_poc = (user_id = $3)
          WHERE production_id = $1 AND dept_id = $2`,
        [prodId, deptId, pocId],
      );
    }
  });
});

describe("3. 冻结后成员不再随部门变动", () => {
  it("冻之前加人会进组；冻之后加人不进这个 event 的名单", async () => {
    const ev = await makeEvent("活引用切断场");
    const g = await makeBGroup("切断组");
    await bindGroupToNewItem(ev, g.id);

    // 冻之前：后来者加入灯光部 → 立刻可见这个 event
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,false)`,
      [prodId, deptId, laterId],
    );
    expect(await canEnterEvent(await actorOf(laterId), prodId, ev)).toBe(true);

    await freezeEventGroups(ev, organizerId);
    const frozenIds = await frozenGroupUserIds(ev, g.id);
    expect(frozenIds).toContain(laterId);

    // 冻之后再退出部门 → 快照里仍在（历史事实不被改写）
    await getPool().query(
      `DELETE FROM production_dept_member WHERE production_id = $1 AND dept_id = $2 AND user_id = $3`,
      [prodId, deptId, laterId],
    );
    expect(await frozenGroupUserIds(ev, g.id)).toContain(laterId);
    expect(await canEnterEvent(await actorOf(laterId), prodId, ev)).toBe(true);
  });
});

describe("4. POC 分裂：追责读快照那位", () => {
  it("组换 POC 不影响已冻 event 的 task 权限", async () => {
    const ev = await makeEvent("POC分裂场");
    const g = await makeBGroup("分裂组");
    const task = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: ev, scheduleItemIds: [],
      title: "对光", description: "", presetMinutes: null,
      departmentId: null, groupId: g.id, assignees: [], createdBy: organizerId,
    });

    expect(await isTaskPoc(prodId, task, pocId)).toBe(true);
    await freezeEventGroups(ev, organizerId);
    expect(await frozenGroupPocUserIds(ev, g.id)).toEqual([pocId]);

    // 灯光部换 POC —— 未冻的场会跟随，已冻的这场不跟随
    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, newbieId],
    );
    const after = (await getTechReqByProduction(task.id, prodId))!;
    expect(await isTaskPoc(prodId, after, pocId)).toBe(true);     // 当时那位仍认
    expect(await isTaskPoc(prodId, after, newbieId)).toBe(false); // 现任不自动接手

    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, pocId],
    );
  });
});

describe("5. 权限不自动漂移", () => {
  it("快照 POC 已离项目，权限也不会自动落到部门现任 POC 头上", async () => {
    const ev = await makeEvent("不漂移场");
    const g = await createEventGroup({
      productionId: prodId, eventId: null, name: `个人POC组${shortId()}`,
      members: [{ kind: "dept", id: deptId }, { kind: "user", id: runnerId }],
      poc: { kind: "user", id: runnerId },   // 个人型 POC，像「助理舞监」
      createdBy: ownerId,
    });
    const task = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: ev, scheduleItemIds: [],
      title: "lightwright 修改", description: "", presetMinutes: null,
      departmentId: null, groupId: g.id, assignees: [], createdBy: organizerId,
    });
    await freezeEventGroups(ev, organizerId);

    // 助理舞监合约结束，退出项目
    await getPool().query(
      "DELETE FROM production_member WHERE production_id = $1 AND user_id = $2",
      [prodId, runnerId],
    );
    const after = (await getTechReqByProduction(task.id, prodId))!;
    // 机器不替人决定善后：灯光部现任 POC 不会自动获得这条 task 的 POC 权
    expect(await isTaskPoc(prodId, after, pocId)).toBe(false);

    // 但关系还在，人看得见：POC 已离项目、灯光部仍在且现任 POC 是谁
    const [snap] = await describeFrozenGroups(ev);
    expect(snap.pocUserName).toBeTruthy();
    expect(snap.pocUserStillMember).toBe(false);
    expect(snap.members.some(m => m.viaDeptId === deptId)).toBe(true);

    await addProductionMember(prodId, runnerId);
  });
});

describe("6. refreeze 追加不覆盖", () => {
  it("解冻→改名单→再冻，两版都留着", async () => {
    const ev = await makeEvent("追加场");
    const g = await makeBGroup("追加组");
    await bindGroupToNewItem(ev, g.id);
    await freezeEventGroups(ev, organizerId);

    const v1 = (await describeFrozenGroups(ev))[0].frozenAt;
    expect(await unfreezeEventGroups(ev)).toEqual({ released: 1 });
    expect(await isEventFrozen(ev)).toBe(false);

    await freezeEventGroups(ev, organizerId);
    const v2 = (await describeFrozenGroups(ev))[0].frozenAt;
    expect(v2).not.toBe(v1);

    // 旧版没被删——「某人以灯光部参加上海站进场」那条事实要留得住
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_group_freeze WHERE event_id = $1", [ev],
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe("7. deadline 由 cron 物化", () => {
  it("end_time 过了宽限期才冻，且幂等可重跑", async () => {
    const g = await makeBGroup("到期组");

    const fresh = await makeEvent("刚结束", new Date(Date.now() - 3600_000).toISOString());
    await bindGroupToNewItem(fresh, g.id);

    const stale = await makeEvent(
      "早结束",
      new Date(Date.now() - (FREEZE_GRACE_DAYS + 1) * 86_400_000).toISOString(),
    );
    await bindGroupToNewItem(stale, g.id);

    await freezeExpiredEventGroups();
    expect(await isEventFrozen(stale)).toBe(true);
    expect(await isEventFrozen(fresh)).toBe(false);   // 还在宽限期内

    // 重跑不产生第二版
    await freezeExpiredEventGroups();
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_group_freeze WHERE event_id = $1", [stale],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("8. 解散守卫只挡未冻结引用", () => {
  it("活引用挡住；引用全冻结之后可以删，且快照仍解析得出", async () => {
    const ev = await makeEvent("守卫场");
    const g = await makeBGroup("待删组");
    await bindGroupToNewItem(ev, g.id);

    await expect(deleteEventGroup(g.id, prodId)).rejects.toThrow(EventGroupError);

    await freezeEventGroups(ev, organizerId);
    await deleteEventGroup(g.id, prodId);   // 引用已冻 → 放行

    const [snap] = await describeFrozenGroups(ev);
    expect(snap.groupStillExists).toBe(false);
    expect(snap.groupName).toContain("待删组");        // 组没了，名字还在
    expect(snap.members.length).toBeGreaterThan(0);   // 名单也还在
  });
});

describe("9. 关系视图只给陈述", () => {
  it("回的是节点当前有效性，不是「该找谁」的结论", async () => {
    const ev = await makeEvent("视图场");
    const g = await makeBGroup("视图组");
    await bindGroupToNewItem(ev, g.id);
    await freezeEventGroups(ev, organizerId);

    const [snap] = await describeFrozenGroups(ev);
    expect(snap.pocDeptStillExists).toBe(true);
    expect(snap.pocDeptCurrentPocUserIds).toContain(pocId);
    // 没有「建议联系人」这类字段——那是 PSM 的判断
    expect(snap).not.toHaveProperty("fallbackPocUserId");
    expect(snap).not.toHaveProperty("suggestedContact");
  });
});
