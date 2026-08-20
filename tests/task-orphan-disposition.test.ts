/**
 * 孤儿任务处置（#236 形状 L，M-15(e)）。
 *
 * task 失去最后一个宿主 event 时怎么办，由 policy.orphan_task_disposition 决定。
 * 三档：keep（一律留）/ delete_untouched（默认：没人动过的删、开过工的留并标记）/
 * delete_all（一律删）。
 *
 * 几条容易搞反的地方，都在下面有例子钉住：
 *   - **删 event 的 FK 是 ON DELETE SET NULL**，数据库层会静默把 task 变成孤儿，
 *     应用代码事后查不到——处置必须在删除**之前**捞人、同事务内执行。
 *   - **删 schedule item 不构成失去宿主**：那是宿主内的细锚点（多对多），
 *     `task.event_id` 纹丝不动。判据是**宿主集合降为空**，不是边计数归零。
 *   - **重新绑定要清标记**：orphaned_at 记的是「当前没有宿主」，不是历史。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getPool } from "@/lib/pg";
import {
  createProductionEvent, deleteProductionEvent, createEventTechReq,
  upsertAwaitingTechReqs, updateTaskByProduction, getTechReqByProduction,
  setTechReqAssignees, createScheduleItem, deleteScheduleItem,
} from "@/lib/event-db";
import { setPolicies } from "@/lib/policy-db";
import {
  ORPHAN_TASK_KEEP, ORPHAN_TASK_MIDDLE, ORPHAN_TASK_DELETE,
} from "@/lib/policy-keys";

let prodId: string;
let ownerId: string;
let deptId: string;

const KEY = "policy.orphan_task_disposition";

async function setDisposition(v: string): Promise<void> {
  await setPolicies(prodId, { [KEY]: v }, ownerId);
}

async function makeEvent(): Promise<string> {
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: `孤儿${shortId()}`,
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: ownerId,
  });
  return ev.id;
}

/** 「没人动过」的空白占位——upsertAwaitingTechReqs 建出来就是这个形态。 */
async function makeUntouched(eventId: string): Promise<string> {
  const [req] = await upsertAwaitingTechReqs(eventId, [deptId]);
  expect(req.status).toBe("awaiting");
  return req.id;
}

/** 「已开工」——有正文。 */
async function makeTouched(eventId: string): Promise<string> {
  const req = await createEventTechReq({
    id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [],
    title: `已开工${shortId()}`, description: "部门填的技术需求正文",
    presetMinutes: null, departmentId: deptId, assignees: [], createdBy: ownerId,
  });
  return req.id;
}

async function orphanedAt(taskId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ orphaned_at: Date | null }>(
    `SELECT orphaned_at FROM task WHERE id = $1`, [taskId],
  );
  return rows[0]?.orphaned_at ? rows[0].orphaned_at.toISOString() : null;
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `孤儿owner${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `孤儿部门${shortId()}`],
  ));
});

afterAll(async () => {
  await getPool().query("DELETE FROM task WHERE production_id = $1", [prodId]).catch(() => {});
  await getPool().query("DELETE FROM production_event WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("默认档 delete_untouched", () => {
  it("删 event：没人动过的被删、已开工的留下并标记待处理", async () => {
    await setDisposition(ORPHAN_TASK_MIDDLE);
    const eventId = await makeEvent();
    const untouched = await makeUntouched(eventId);
    const touched = await makeTouched(eventId);

    await deleteProductionEvent(eventId, prodId);

    expect(await getTechReqByProduction(untouched, prodId)).toBeNull();
    const kept = await getTechReqByProduction(touched, prodId);
    expect(kept).not.toBeNull();
    expect(kept!.eventId).toBeNull();          // FK 已 SET NULL
    expect(await orphanedAt(touched)).not.toBeNull();  // 标记待处理
  });

  it("被指派过也算开过工——即便还是 awaiting、正文为空", async () => {
    await setDisposition(ORPHAN_TASK_MIDDLE);
    const eventId = await makeEvent();
    const t = await makeUntouched(eventId);
    await setTechReqAssignees(t, [{ userId: ownerId, name: "被指派" }]);

    await deleteProductionEvent(eventId, prodId);

    expect(await getTechReqByProduction(t, prodId)).not.toBeNull();
    expect(await orphanedAt(t)).not.toBeNull();
  });
});

describe("另外两档", () => {
  it("keep：一律留为孤儿，连标记都不打", async () => {
    await setDisposition(ORPHAN_TASK_KEEP);
    const eventId = await makeEvent();
    const untouched = await makeUntouched(eventId);

    await deleteProductionEvent(eventId, prodId);

    expect(await getTechReqByProduction(untouched, prodId)).not.toBeNull();
    expect(await orphanedAt(untouched)).toBeNull();
  });

  it("delete_all：已开工的也删", async () => {
    await setDisposition(ORPHAN_TASK_DELETE);
    const eventId = await makeEvent();
    const touched = await makeTouched(eventId);

    await deleteProductionEvent(eventId, prodId);

    expect(await getTechReqByProduction(touched, prodId)).toBeNull();
  });
});

describe("解绑与重绑", () => {
  it("PATCH { eventId: null } 走同一处置（解绑也是失去宿主）", async () => {
    await setDisposition(ORPHAN_TASK_MIDDLE);
    const eventId = await makeEvent();
    const untouched = await makeUntouched(eventId);

    await updateTaskByProduction(untouched, prodId, { eventId: null });
    expect(await getTechReqByProduction(untouched, prodId)).toBeNull();
  });

  it("重新绑定事件 ⇒ 清除孤儿标记（记的是当前状态，不是历史）", async () => {
    await setDisposition(ORPHAN_TASK_MIDDLE);
    const first = await makeEvent();
    const t = await makeTouched(first);

    await updateTaskByProduction(t, prodId, { eventId: null });
    expect(await orphanedAt(t)).not.toBeNull();

    const second = await makeEvent();
    await updateTaskByProduction(t, prodId, { eventId: second });
    expect(await orphanedAt(t)).toBeNull();
  });
});

describe("M-15(e)：判据是宿主集合降为空，不是边计数归零", () => {
  it("删 schedule item 不触发处置——那是宿主内的细锚点，event 宿主还在", async () => {
    await setDisposition(ORPHAN_TASK_DELETE);   // 最激进档，若误触发必然删掉
    const eventId = await makeEvent();
    const item = await createScheduleItem({
      id: `si_${shortId()}`, eventId, title: `细锚点${shortId()}`, itemType: "rehearsal",
      startTime: null, endTime: null, location: "", orderIndex: 0,
      targetSceneId: null, targetBlockId: null, notes: "",
    });
    const t = await makeUntouched(eventId);
    await getPool().query(
      `INSERT INTO task_schedule_item (task_id, item_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [t, item.id],
    );

    await deleteScheduleItem(item.id, eventId);

    const still = await getTechReqByProduction(t, prodId);
    expect(still).not.toBeNull();
    expect(still!.eventId).toBe(eventId);   // 宿主纹丝不动
    expect(await orphanedAt(t)).toBeNull();
    await setDisposition(ORPHAN_TASK_MIDDLE);
  });
});
