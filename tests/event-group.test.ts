/**
 * 用户组（event_group）的语义锁。
 *
 * 每个 describe 对应一条设计定谳，改坏了要能立刻看出改的是哪一条：
 *   1. 两型分道：A 型门 = 该 event 的内容编辑权；B 型门 = node:user_group/*
 *   2. POC 必须是本组成员（「以其中的一个部门/人为 POC」）
 *   3. 成员是活引用：部门加人自动进组
 *   4. POC 是活引用：部门换 POC 自动跟随
 *   5. 用 ≠ 改：organizer 能把 B 型组排进自己的 rundown，但改不了它
 *   6. A 型组不能被别的 event 引用
 *   7. 在用户组里参加 = 原来的直接参加（Type B，不落 grant 行）
 *   8. 组 POC 没有 schedule assign 权（组被排进 rundown ≠ 能改 rundown）
 *   9. 解散守卫：还挂在流程项上的组不许删
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, getProductionPermissionContext } from "@/lib/db";
import { createProductionEvent, createScheduleItem } from "@/lib/event-db";
import { toActor } from "@/lib/grant-check";
import { canEnterEvent, isEventGroupParticipant } from "@/lib/event-permissions";
import {
  createEventGroup, deleteEventGroup, EventGroupError, getEventGroup, isGroupPoc,
  listEventGroups, resolveGroupPocUserIds, resolveGroupUserIds, setScheduleItemGroups,
  updateEventGroup, userGroupIdsInEvent, groupScope,
} from "@/lib/event-group-db";
import {
  canBindGroupToSchedule, canCreateEventGroup, canEditEventGroup, canSetEventGroupPoc,
} from "@/lib/event-group-perm";

let prodId: string;
let ownerId: string;
let organizerId: string;   // 建了 event → 拿到该 event 的 manage 行集（含 details@edit）
let outsiderId: string;    // 普通成员，无任何 event 行
let deptPocId: string;     // 灯光部 POC
let deptNewbieId: string;  // 建组之后才加入灯光部的人（验活引用）
let assistantId: string;   // 助理舞监——直接成员，可当个人型 POC
let eventId: string;
let otherEventId: string;
let deptId: string;

async function actorOf(userId: string) {
  const access = await getProductionPermissionContext(userId, false, prodId);
  return toActor({ userId }, access!.permCtx);
}

beforeAll(async () => {
  ownerId       = (await upsertFeishuUser(`test-open-${shortId()}`, `组主${shortId()}`, null, false)).userId;
  organizerId   = (await upsertFeishuUser(`test-open-${shortId()}`, `组织者${shortId()}`, null, false)).userId;
  outsiderId    = (await upsertFeishuUser(`test-open-${shortId()}`, `路人${shortId()}`, null, false)).userId;
  deptPocId     = (await upsertFeishuUser(`test-open-${shortId()}`, `灯光POC${shortId()}`, null, false)).userId;
  deptNewbieId  = (await upsertFeishuUser(`test-open-${shortId()}`, `后来的${shortId()}`, null, false)).userId;
  assistantId   = (await upsertFeishuUser(`test-open-${shortId()}`, `助理舞监${shortId()}`, null, false)).userId;

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [organizerId, outsiderId, deptPocId, deptNewbieId, assistantId]) {
    await addProductionMember(prodId, u);
  }

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `灯光${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
    [prodId, deptId, deptPocId],
  );

  // organizer 建 event → writeEventGrants 发创建者行集（含 details@edit）
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "进场对光",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: organizerId,
  });
  eventId = ev.id;
  const other = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "另一场",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: organizerId,
  });
  otherEventId = other.id;
});

afterAll(async () => {
  for (const id of [eventId, otherEventId]) {
    await getPool().query("DELETE FROM production_event WHERE id = $1", [id]).catch(() => {});
  }
  await cleanupProduction(prodId).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 两型分道", () => {
  it("A 型（event 绑定）：organizer 建得了；B 型（项目级）：同一个 organizer 建不了", async () => {
    const actor = await actorOf(organizerId);
    const draftGate = { eventId, status: "draft" };

    expect(await canCreateEventGroup(actor, prodId, draftGate)).toBe(true);
    // B 型要 node:user_group/*@create，organizer 的 event 行集里没有这枚
    expect(await canCreateEventGroup(actor, prodId, null)).toBe(false);
    // owner 旁路两型都能建
    expect(await canCreateEventGroup(await actorOf(ownerId), prodId, null)).toBe(true);
  });

  it("groupScope 只看 eventId，不另设 type 列", async () => {
    expect(groupScope({ eventId: null })).toBe("production");
    expect(groupScope({ eventId })).toBe("event");
  });
});

describe("2. POC 必须是本组成员", () => {
  it("把非成员设为 POC 直接拒绝（建组时与改组时都拒）", async () => {
    await expect(createEventGroup({
      productionId: prodId, eventId, name: `非法POC${shortId()}`,
      members: [{ kind: "dept", id: deptId }],
      poc: { kind: "user", id: assistantId },   // assistant 不在成员里
      createdBy: organizerId,
    })).rejects.toThrow(EventGroupError);

    const g = await createEventGroup({
      productionId: prodId, eventId, name: `合法组${shortId()}`,
      members: [{ kind: "dept", id: deptId }, { kind: "user", id: assistantId }],
      poc: { kind: "user", id: assistantId },
      createdBy: organizerId,
    });
    // 把 POC 本人从成员里摘掉 → 同一事务里校验，拒绝
    await expect(updateEventGroup(g.id, prodId, {
      members: [{ kind: "dept", id: deptId }],
    })).rejects.toThrow(EventGroupError);
  });
});

describe("3. 成员是活引用：部门加人自动进组", () => {
  it("建组后才加入灯光部的人，也在组里", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `活引用${shortId()}`,
      members: [{ kind: "dept", id: deptId }, { kind: "user", id: assistantId }],
      poc: { kind: "user", id: assistantId },
      createdBy: organizerId,
    });
    expect(await resolveGroupUserIds(g.id)).toEqual(
      expect.arrayContaining([deptPocId, assistantId]),
    );
    expect(await resolveGroupUserIds(g.id)).not.toContain(deptNewbieId);

    // 组一个字没改，只往灯光部加了个人
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,false)`,
      [prodId, deptId, deptNewbieId],
    );
    expect(await resolveGroupUserIds(g.id)).toContain(deptNewbieId);
  });
});

describe("4. POC 是活引用：部门换 POC 自动跟随", () => {
  it("dept 型 POC 解析成该部门的现任 POC", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `部门POC${shortId()}`,
      members: [{ kind: "dept", id: deptId }],
      poc: { kind: "dept", id: deptId },
      createdBy: organizerId,
    });
    expect(await resolveGroupPocUserIds(g.id)).toEqual([deptPocId]);
    expect(await isGroupPoc(g.id, deptPocId)).toBe(true);
    expect(await isGroupPoc(g.id, deptNewbieId)).toBe(false);

    // 部门把 POC 换成后来那位——组一个字没改
    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, deptNewbieId],
    );
    expect(await resolveGroupPocUserIds(g.id)).toEqual([deptNewbieId]);
    expect(await isGroupPoc(g.id, deptPocId)).toBe(false);

    // 还原，别影响后面的用例
    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, deptPocId],
    );
  });
});

describe("5. 用 ≠ 改", () => {
  it("organizer 能把 B 型组排进自己的 rundown，但改不了它的成员与 POC", async () => {
    const bGroup = await createEventGroup({
      productionId: prodId, eventId: null, name: `项目级${shortId()}`,
      members: [{ kind: "dept", id: deptId }],
      poc: { kind: "dept", id: deptId },
      createdBy: ownerId,
    });
    const actor = await actorOf(organizerId);
    const gate = { eventId, status: "draft" };

    expect(await canBindGroupToSchedule(actor, prodId, gate)).toBe(true);   // 用：可以
    expect(await canEditEventGroup(actor, prodId, bGroup, null)).toBe(false); // 改：不行
    expect(await canSetEventGroupPoc(actor, prodId, bGroup, null)).toBe(false);
  });

  it("A 型组的 @edit 只认它自己所属的那个 event 的编辑权", async () => {
    const aGroup = await createEventGroup({
      productionId: prodId, eventId, name: `A型${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: null, createdBy: organizerId,
    });
    const actor = await actorOf(organizerId);
    expect(await canEditEventGroup(actor, prodId, aGroup, { eventId, status: "draft" })).toBe(true);
    // 拿另一个 event 的门来改它 → 拒绝（否则 event B 的 organizer 能改 event A 的组）
    expect(await canEditEventGroup(actor, prodId, aGroup, { eventId: otherEventId, status: "draft" })).toBe(false);
  });
});

describe("6. A 型组不能被别的 event 引用", () => {
  it("把 event A 的组挂到 event B 的流程项上 → 拒绝；B 型组两边都能挂", async () => {
    const aGroup = await createEventGroup({
      productionId: prodId, eventId, name: `专属${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: null, createdBy: organizerId,
    });
    const bGroup = await createEventGroup({
      productionId: prodId, eventId: null, name: `通用${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: null, createdBy: ownerId,
    });
    const itemInOther = await createScheduleItem({
      id: `si_${shortId()}`, eventId: otherEventId, title: "别的场的流程项",
      itemType: "custom", startTime: null, endTime: null, location: "",
      orderIndex: 0, targetSceneId: null, targetBlockId: null, notes: "",
    });

    await expect(
      setScheduleItemGroups(itemInOther.id, otherEventId, prodId, [aGroup.id]),
    ).rejects.toThrow(EventGroupError);

    await setScheduleItemGroups(itemInOther.id, otherEventId, prodId, [bGroup.id]);
    expect(await resolveGroupUserIds(bGroup.id)).toContain(deptPocId);
  });
});

describe("7. 在用户组里参加 = 原来的直接参加", () => {
  it("组成员对该 event 恒可进；不落 grant 行，部门加人自动跟踪", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `参与${shortId()}`,
      members: [{ kind: "user", id: outsiderId }], poc: null, createdBy: organizerId,
    });
    const item = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "对光", itemType: "custom",
      startTime: null, endTime: null, location: "", orderIndex: 0,
      targetSceneId: null, targetBlockId: null, notes: "",
    });

    // 还没把组挂上流程项 → 不算参与
    expect(await isEventGroupParticipant(eventId, outsiderId)).toBe(false);

    await setScheduleItemGroups(item.id, eventId, prodId, [g.id]);
    expect(await isEventGroupParticipant(eventId, outsiderId)).toBe(true);
    expect(await userGroupIdsInEvent(eventId, outsiderId)).toContain(g.id);
    expect(await canEnterEvent(await actorOf(outsiderId), prodId, eventId)).toBe(true);

    // 判定端算出来的，不是落的行
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant
        WHERE production_id = $1 AND user_id = $2 AND resource_type = 'event' AND resource_id = $3`,
      [prodId, outsiderId, eventId],
    );
    expect(rows).toHaveLength(0);

    // 无关的人不受影响
    expect(await isEventGroupParticipant(otherEventId, outsiderId)).toBe(false);
  });
});

describe("8. 组 POC 没有 schedule assign 权", () => {
  it("组被排进 rundown 不等于组 POC 能改 rundown（用户定谳）", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `POC无排权${shortId()}`,
      members: [{ kind: "dept", id: deptId }],
      poc: { kind: "dept", id: deptId },
      createdBy: organizerId,
    });
    const item = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "对光2", itemType: "custom",
      startTime: null, endTime: null, location: "", orderIndex: 0,
      targetSceneId: null, targetBlockId: null, notes: "",
    });
    await setScheduleItemGroups(item.id, eventId, prodId, [g.id]);

    expect(await isGroupPoc(g.id, deptPocId)).toBe(true);
    // 是 POC，但没有该 event 的内容编辑权 → 排不了 rundown
    expect(await canBindGroupToSchedule(
      await actorOf(deptPocId), prodId, { eventId, status: "draft" },
    )).toBe(false);
  });
});

describe("9. 解散守卫", () => {
  it("还挂在流程项上的组不许删；摘下来之后可以", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `待删${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: null, createdBy: organizerId,
    });
    const item = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: "占用", itemType: "custom",
      startTime: null, endTime: null, location: "", orderIndex: 0,
      targetSceneId: null, targetBlockId: null, notes: "",
    });
    await setScheduleItemGroups(item.id, eventId, prodId, [g.id]);

    await expect(deleteEventGroup(g.id, prodId)).rejects.toThrow(EventGroupError);

    await setScheduleItemGroups(item.id, eventId, prodId, []);
    await deleteEventGroup(g.id, prodId);
    expect(await getEventGroup(g.id, prodId)).toBeNull();
  });
});

describe("列表口径", () => {
  it("给 eventId → 该 event 的 A 型组 + 全部 B 型组；不给 → 只有 B 型组", async () => {
    const withEvent = await listEventGroups(prodId, eventId);
    const productionOnly = await listEventGroups(prodId);

    expect(withEvent.every(g => g.eventId === null || g.eventId === eventId)).toBe(true);
    expect(productionOnly.every(g => g.eventId === null)).toBe(true);
    expect(withEvent.length).toBeGreaterThan(productionOnly.length);
  });
});
