/**
 * rundown 版面的语义锁。
 *
 * 中心命题：**版面归 organizer，不归个人**，而且它是 (event, group) 这一层的事。
 *
 *   1. 同一个组在不同 event 的版面里可以排不同位置（这是这层存在的唯一理由）
 *   2. 列身份按 group/地点 认，不按前端 id 认——否则每次保存都变成删光重建
 *   3. 全量覆盖：移除的列真的删掉
 *   4. 列二选一：绑组或给地点
 *   5. 跨 event / 跨剧组的引用一律拒
 *   6. 条目表现：颜色 + 钉列；钉列引用必须是本 event 的列
 *   7. 条目被删 → 表现行自动清掉（两个可空 FK 换来的，多态列做不到）
 *   8. 组作为版面的列也是活引用，挡住删组
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createProductionEvent, createScheduleItem, createEventTechReq } from "@/lib/event-db";
import { createEventGroup, deleteEventGroup, EventGroupError } from "@/lib/event-group-db";
import {
  getRundownTags, listRundownColumns, listRundownPlacements, RundownConflictError, RundownError,
  setRundownColumns, setRundownPlacements,
} from "@/lib/event-rundown-db";

let prodId: string, otherProdId: string;
let ownerId: string, deptId: string;
let eventA: string, eventB: string;
let groupX: string, groupY: string;

async function makeEvent(title: string) {
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title,
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: ownerId,
  });
  return ev.id;
}

async function makeItem(evId: string, location = "") {
  const it = await createScheduleItem({
    id: `si_${shortId()}`, eventId: evId, title: "流程项", itemType: "custom",
    startTime: null, endTime: null, location, orderIndex: 0,
    targetSceneId: null, targetBlockId: null, notes: "",
  });
  return it.id;
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `版面主${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  ({ prodId: otherProdId } = await makeProduction(ownerId));

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `版面部门${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
    [prodId, deptId, ownerId],
  );

  eventA = await makeEvent("上海站");
  eventB = await makeEvent("北京站");

  // 两个项目级（B 型）组：跨 event 共享，正是要验的场景
  groupX = (await createEventGroup({
    productionId: prodId, eventId: null, name: `进场对光小组${shortId()}`,
    members: [{ kind: "dept", id: deptId }], poc: { kind: "dept", id: deptId },
    createdBy: ownerId,
  })).id;
  groupY = (await createEventGroup({
    productionId: prodId, eventId: null, name: `音响组${shortId()}`,
    members: [{ kind: "dept", id: deptId }], poc: null, createdBy: ownerId,
  })).id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 同一个组在不同 event 排不同位置", () => {
  it("上海站 X 在前，北京站 X 在后——互不影响", async () => {
    await setRundownColumns(eventA, prodId, [{ groupId: groupX }, { groupId: groupY }]);
    await setRundownColumns(eventB, prodId, [{ groupId: groupY }, { groupId: groupX }]);

    const a = await listRundownColumns(eventA);
    const b = await listRundownColumns(eventB);
    expect(a.map(c => c.groupId)).toEqual([groupX, groupY]);
    expect(b.map(c => c.groupId)).toEqual([groupY, groupX]);
  });
});

describe("2. 列身份按 group 认，不按前端 id 认", () => {
  it("重复保存同一份版面，列 id 保持不变（不是删光重建）", async () => {
    await setRundownColumns(eventA, prodId, [{ groupId: groupX }, { groupId: groupY }]);
    const before = (await listRundownColumns(eventA)).map(c => c.id);

    // 前端再保存一次（它手里的本地 id 是 `custom-<ts>`，这里根本不传）
    await setRundownColumns(eventA, prodId, [{ groupId: groupX, isPinned: true }, { groupId: groupY }]);
    const after = await listRundownColumns(eventA);

    expect(after.map(c => c.id)).toEqual(before);   // id 稳定 → 条目上的钉列引用不会被 CASCADE 掉
    expect(after[0].isPinned).toBe(true);
  });

  it("visible / pinned 都存得住", async () => {
    await setRundownColumns(eventA, prodId, [
      { groupId: groupX, isVisible: false, isPinned: true },
      { groupId: groupY, isVisible: true, isPinned: false },
    ]);
    const cols = await listRundownColumns(eventA);
    expect(cols[0]).toMatchObject({ isVisible: false, isPinned: true });
    expect(cols[1]).toMatchObject({ isVisible: true, isPinned: false });
  });
});

describe("3. 全量覆盖", () => {
  it("这次没给的列被删掉", async () => {
    await setRundownColumns(eventA, prodId, [{ groupId: groupX }, { groupId: groupY }]);
    await setRundownColumns(eventA, prodId, [{ groupId: groupX }]);
    expect((await listRundownColumns(eventA)).map(c => c.groupId)).toEqual([groupX]);
  });
});

describe("4. 列二选一：绑组或给地点", () => {
  it("地点列存得住；两个都给 / 都不给都拒", async () => {
    await setRundownColumns(eventA, prodId, [
      { groupId: groupX },
      { matchLocation: "主剧场" },
    ]);
    const cols = await listRundownColumns(eventA);
    expect(cols[1]).toMatchObject({ groupId: null, matchLocation: "主剧场" });

    await expect(setRundownColumns(eventA, prodId, [{ groupId: groupX, matchLocation: "主剧场" }]))
      .rejects.toThrow(RundownError);
    await expect(setRundownColumns(eventA, prodId, [{}]))
      .rejects.toThrow(RundownError);
  });
});

describe("5. 跨 event / 跨剧组引用一律拒", () => {
  it("别的剧组的组不能进这个 event 的版面", async () => {
    const foreign = await createEventGroup({
      productionId: otherProdId, eventId: null, name: `外组${shortId()}`,
      members: [], poc: null, createdBy: ownerId,
    });
    await expect(setRundownColumns(eventA, prodId, [{ groupId: foreign.id }]))
      .rejects.toThrow(RundownError);
  });

  it("A 型组（绑死在别的 event）不能进这个 event 的版面", async () => {
    const aType = await createEventGroup({
      productionId: prodId, eventId: eventB, name: `北京专属${shortId()}`,
      members: [], poc: null, createdBy: ownerId,
    });
    await expect(setRundownColumns(eventA, prodId, [{ groupId: aType.id }]))
      .rejects.toThrow(RundownError);
    // 它自己那场可以
    await setRundownColumns(eventB, prodId, [{ groupId: aType.id }]);
    expect((await listRundownColumns(eventB)).map(c => c.groupId)).toEqual([aType.id]);
  });
});

describe("6. 条目表现", () => {
  it("颜色 + 钉列存得住；钉了不属于本 event 版面的列则拒", async () => {
    const ev = await makeEvent("表现场");
    const item = await makeItem(ev);
    await setRundownColumns(ev, prodId, [{ groupId: groupX }, { groupId: groupY }]);
    const [colX, colY] = await listRundownColumns(ev);

    await setRundownPlacements(ev, [
      { entryType: "item", entryId: item, color: "#f2e4d9", pinnedColumnIds: [colX.id, colY.id] },
    ]);
    const [p] = await listRundownPlacements(ev);
    expect(p).toMatchObject({ entryType: "item", entryId: item, color: "#f2e4d9" });
    expect(p.pinnedColumnIds.sort()).toEqual([colX.id, colY.id].sort());

    // 别的 event 的列
    const otherCols = await listRundownColumns(eventB);
    await expect(setRundownPlacements(ev, [
      { entryType: "item", entryId: item, pinnedColumnIds: [otherCols[0].id] },
    ])).rejects.toThrow(RundownError);
  });

  it("不属于本 event 的条目被拒", async () => {
    const ev = await makeEvent("越界场");
    const foreignItem = await makeItem(eventA);
    await expect(setRundownPlacements(ev, [{ entryType: "item", entryId: foreignItem }]))
      .rejects.toThrow(RundownError);
  });

  it("task 条目同样存得住", async () => {
    const ev = await makeEvent("任务表现场");
    const t = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: ev, scheduleItemIds: [],
      title: "对光", description: "", presetMinutes: null,
      departmentId: deptId, assignees: [], createdBy: ownerId,
    });
    await setRundownPlacements(ev, [{ entryType: "task", entryId: t.id, color: "#eee" }]);
    const [p] = await listRundownPlacements(ev);
    expect(p).toMatchObject({ entryType: "task", entryId: t.id, color: "#eee" });
  });
});

describe("7. 条目被删 → 表现行自动清掉", () => {
  it("删掉流程项，它的颜色/钉列不留孤儿（两个可空 FK 换来的）", async () => {
    const ev = await makeEvent("孤儿场");
    const item = await makeItem(ev);
    await setRundownColumns(ev, prodId, [{ groupId: groupX }]);
    const [col] = await listRundownColumns(ev);
    await setRundownPlacements(ev, [
      { entryType: "item", entryId: item, color: "#abc", pinnedColumnIds: [col.id] },
    ]);
    expect(await listRundownPlacements(ev)).toHaveLength(1);

    await getPool().query("DELETE FROM event_schedule_item WHERE id = $1", [item]);
    expect(await listRundownPlacements(ev)).toHaveLength(0);

    // 关联行也要跟着走（CASCADE 链：item → placement → placement_column）
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_rundown_placement_column pc
        JOIN event_rundown_placement p ON p.id = pc.placement_id
       WHERE p.event_id = $1`,
      [ev],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("8. 组作为版面的列也是活引用", () => {
  it("组还是某个 event 的列时删不掉——否则 organizer 排好的列会悄悄消失", async () => {
    const ev = await makeEvent("守卫场");
    const g = await createEventGroup({
      productionId: prodId, eventId: null, name: `列引用组${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: null, createdBy: ownerId,
    });
    await setRundownColumns(ev, prodId, [{ groupId: g.id }]);

    await expect(deleteEventGroup(g.id, prodId)).rejects.toThrow(EventGroupError);

    await setRundownColumns(ev, prodId, []);
    await deleteEventGroup(g.id, prodId);
  });
});

describe("9. 并发覆盖保护", () => {
  it("拿旧列指纹保存会冲突，不覆盖别人刚排好的顺序", async () => {
    const ev = await makeEvent("并发列场");
    await setRundownColumns(ev, prodId, [{ groupId: groupX }, { groupId: groupY }]);
    const { columnsTag } = await getRundownTags(ev);

    await setRundownColumns(
      ev, prodId, [{ groupId: groupY }, { groupId: groupX }], columnsTag,
    );
    await expect(setRundownColumns(
      ev, prodId, [{ groupId: groupX }], columnsTag,
    )).rejects.toThrow(RundownConflictError);

    expect((await listRundownColumns(ev)).map(c => c.groupId)).toEqual([groupY, groupX]);
  });

  it("拿旧事项指纹保存会冲突，不覆盖别人刚改的颜色", async () => {
    const ev = await makeEvent("并发事项场");
    const first = await makeItem(ev);
    const second = await makeItem(ev);
    const { placementsTag } = await getRundownTags(ev);

    await setRundownPlacements(
      ev, [{ entryType: "item", entryId: first, color: "#111" }], placementsTag,
    );
    await expect(setRundownPlacements(
      ev, [{ entryType: "item", entryId: second, color: "#222" }], placementsTag,
    )).rejects.toThrow(RundownConflictError);

    expect(await listRundownPlacements(ev)).toEqual([
      { entryType: "item", entryId: first, color: "#111", pinnedColumnIds: [] },
    ]);
  });
});
