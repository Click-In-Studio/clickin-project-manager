/**
 * task 责任主体泛化（部门 | 用户组）的语义锁。
 *
 * 这批断言守的是同一条中心命题：**换主体不换规则**。
 * 「指派归 POC」（2026-08-15 定谳）之所以在绑组之后依然成立，是因为组自带 POC——
 * 责任主体从「部门」变成「部门 | 用户组」时，POC 仍是唯一的责任单点，只是来源多了
 * 一支。所以下面每条都成对写：部门怎么样，组就该怎么样。
 *
 *   1. 主体二选一（DB CHECK + 路由 400）
 *   2. 组 POC == 部门 POC：可编辑内容、可推进状态、可指派
 *   3. 组 POC 是活引用：部门换 POC 自动跟随
 *   4. 组成员（非 POC）不因此获得编辑/指派权，只获得可见
 *   5. 绑组的 task 让组员看得见这个 event（不落 grant 行）
 *   6. 绑组 task 出现在组 POC 的「与我相关」里
 *   7. 主体解绑 / 组被删 → task 失去责任方，不连坐删
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, getProductionPermissionContext } from "@/lib/db";
import {
  createProductionEvent, createEventTechReq, getTechReqByProduction,
  listMyTechReqsFull, updateTaskByProduction,
} from "@/lib/event-db";
import { canAssignTechReq, canEditTechReq, canViewTechReq, canEnterEvent } from "@/lib/event-permissions";
import { createEventGroup, deleteEventGroup, EventGroupError } from "@/lib/event-group-db";
import { freezeEventGroups, unfreezeEventGroups } from "@/lib/event-group-freeze";
import { isTaskPoc, taskSubjectOf, parseTaskSubject, resolveSubjectPatch } from "@/lib/task-poc";
import { toActor } from "@/lib/grant-check";
import type { PermissionContext } from "@/lib/permissions";

let prodId: string;
let ownerId: string;
let organizerId: string;
let deptPocId: string;      // 灯光部 POC —— 组的 dept 型 POC 解析到他
let deptNewbieId: string;   // 后来才成为灯光部 POC 的人
let runnerId: string;       // 外场 runner：组成员，非 POC
let strangerId: string;     // 与组无关
let eventId: string;
let deptId: string;
let groupId: string;

async function ctxOf(userId: string): Promise<PermissionContext> {
  const access = await getProductionPermissionContext(userId, false, prodId);
  return access!.permCtx;
}
async function actorOf(userId: string) {
  return toActor({ userId }, await ctxOf(userId));
}

beforeAll(async () => {
  ownerId      = (await upsertFeishuUser(`test-open-${shortId()}`, `主体主${shortId()}`, null, false)).userId;
  organizerId  = (await upsertFeishuUser(`test-open-${shortId()}`, `主体组织${shortId()}`, null, false)).userId;
  deptPocId    = (await upsertFeishuUser(`test-open-${shortId()}`, `主体灯POC${shortId()}`, null, false)).userId;
  deptNewbieId = (await upsertFeishuUser(`test-open-${shortId()}`, `主体新POC${shortId()}`, null, false)).userId;
  runnerId     = (await upsertFeishuUser(`test-open-${shortId()}`, `主体runner${shortId()}`, null, false)).userId;
  strangerId   = (await upsertFeishuUser(`test-open-${shortId()}`, `主体路人${shortId()}`, null, false)).userId;

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [organizerId, deptPocId, deptNewbieId, runnerId, strangerId]) {
    await addProductionMember(prodId, u);
  }

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `主体灯光${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
     VALUES ($1,$2,$3,true), ($1,$2,$4,false)`,
    [prodId, deptId, deptPocId, deptNewbieId],
  );

  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "进场对光",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: organizerId,
  });
  eventId = ev.id;

  // 「进场对光小组」= 灯光部 + 一个外场 runner，POC 是灯光部
  const group = await createEventGroup({
    productionId: prodId, eventId, name: `进场对光小组${shortId()}`,
    members: [{ kind: "dept", id: deptId }, { kind: "user", id: runnerId }],
    poc: { kind: "dept", id: deptId },
    createdBy: organizerId,
  });
  groupId = group.id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

async function makeGroupTask(status = "pending") {
  const t = await createEventTechReq({
    id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [],
    title: `对光${shortId()}`, description: "", presetMinutes: null,
    departmentId: null, groupId, assignees: [], createdBy: organizerId,
  });
  if (status !== "pending") await updateTaskByProduction(t.id, prodId, { status });
  return (await getTechReqByProduction(t.id, prodId))!;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 责任主体二选一", () => {
  it("taskSubjectOf 认两种；DB CHECK 挡住同时给两个", async () => {
    expect(taskSubjectOf({ departmentId: deptId, groupId: null })).toEqual({ kind: "dept", id: deptId });
    expect(taskSubjectOf({ departmentId: null, groupId })).toEqual({ kind: "group", id: groupId });
    expect(taskSubjectOf({ departmentId: null, groupId: null })).toBeNull();

    await expect(getPool().query(
      `INSERT INTO task (id, production_id, title, department_id, group_id)
       VALUES ($1,$2,'两个主体',$3,$4)`,
      [`tr_${shortId()}`, prodId, deptId, groupId],
    )).rejects.toThrow(/task_subject_single/);
  });

  it("parseTaskSubject：两个都给回 400；跨剧组 id 回 400", async () => {
    const both = await parseTaskSubject(prodId, { departmentId: deptId, groupId });
    expect(both.ok).toBe(false);

    const { prodId: otherProd } = await makeProduction(ownerId);
    const cross = await parseTaskSubject(otherProd, { groupId });
    expect(cross.ok).toBe(false);
    await cleanupProduction(otherProd).catch(() => {});

    const good = await parseTaskSubject(prodId, { groupId });
    expect(good).toEqual({ ok: true, subject: { kind: "group", id: groupId } });
  });
});

describe("1b. PATCH 的主体语义：每个字段只清自己那一支", () => {
  /**
   * 这一条守的是一个真实的数据丢失：任务抽屉初始化时做
   * `setDrawerDeptId(task.departmentId ?? "")`，绑组的 task 在那里是空串，提交时
   * 就发 `departmentId: null`。若按「给了 departmentId 就重设整个主体」处理，
   * 任何人点一下「保存任务信息」——哪怕一个字没改——组绑定就没了，POC 随之消失，
   * 这条 task 谁都编辑不了。旧客户端不知道有组，不能让它的沉默变成删除。
   */
  it("绑组的 task 收到 departmentId:null 时，组绑定必须原样保留", async () => {
    const cur = { departmentId: null, groupId };
    const patch = await resolveSubjectPatch(prodId, { departmentId: null }, cur);
    expect(patch).toEqual({ ok: true, cols: { departmentId: null, groupId } });
  });

  it("要解绑组得显式发 groupId:null", async () => {
    const patch = await resolveSubjectPatch(prodId, { groupId: null }, { departmentId: null, groupId });
    expect(patch).toEqual({ ok: true, cols: { departmentId: null, groupId: null } });
  });

  it("设一支会顶掉另一支（互斥）", async () => {
    const toGroup = await resolveSubjectPatch(prodId, { groupId }, { departmentId: deptId, groupId: null });
    expect(toGroup).toEqual({ ok: true, cols: { departmentId: null, groupId } });
    const toDept = await resolveSubjectPatch(prodId, { departmentId: deptId }, { departmentId: null, groupId });
    expect(toDept).toEqual({ ok: true, cols: { departmentId: deptId, groupId: null } });
  });

  it("两个字段都没给 = 完全不动主体", async () => {
    const patch = await resolveSubjectPatch(prodId, {}, { departmentId: null, groupId });
    expect(patch).toEqual({ ok: true, cols: null });
  });

  it("两个都给非空值 → 400；跨剧组 id → 400", async () => {
    expect((await resolveSubjectPatch(prodId, { departmentId: deptId, groupId }, { departmentId: null, groupId: null })).ok).toBe(false);
    const { prodId: otherProd } = await makeProduction(ownerId);
    expect((await resolveSubjectPatch(otherProd, { groupId }, { departmentId: null, groupId: null })).ok).toBe(false);
    await cleanupProduction(otherProd).catch(() => {});
  });

  it("端到端：绑组的 task 走一次「只发 departmentId:null」的 PATCH，组还在", async () => {
    const task = await makeGroupTask();
    const patch = await resolveSubjectPatch(prodId, { departmentId: null, title: "改个名" } as never, task);
    expect(patch.ok).toBe(true);
    if (patch.ok && patch.cols) {
      await updateTaskByProduction(task.id, prodId, patch.cols);
    }
    const after = (await getTechReqByProduction(task.id, prodId))!;
    expect(after.groupId).toBe(groupId);                    // 组还在
    expect(await isTaskPoc(prodId, after, deptPocId)).toBe(true);  // POC 还认
  });
});

describe("2. 组 POC == 部门 POC", () => {
  it("可编辑内容、可指派；无关成员两样都不行", async () => {
    const task = await makeGroupTask();
    expect(await isTaskPoc(prodId, task, deptPocId)).toBe(true);
    expect(await canEditTechReq(await ctxOf(deptPocId), task.id, eventId, prodId)).toBe(true);
    expect(await canAssignTechReq(await ctxOf(deptPocId), task.id, prodId)).toBe(true);

    expect(await isTaskPoc(prodId, task, strangerId)).toBe(false);
    expect(await canAssignTechReq(await ctxOf(strangerId), task.id, prodId)).toBe(false);
  });

  it("organizer 仍然只能编辑内容、不能指派——定谳换主体后依旧成立", async () => {
    const task = await makeGroupTask();
    const organizerCtx = await ctxOf(organizerId);
    expect(await canEditTechReq(organizerCtx, task.id, eventId, prodId)).toBe(true);
    expect(await canAssignTechReq(organizerCtx, task.id, prodId)).toBe(false);
  });
});

describe("3. 组 POC 是活引用", () => {
  it("灯光部换 POC → 绑组 task 的 POC 自动跟随，task 一个字没改", async () => {
    const task = await makeGroupTask();
    expect(await isTaskPoc(prodId, task, deptPocId)).toBe(true);
    expect(await isTaskPoc(prodId, task, deptNewbieId)).toBe(false);

    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, deptNewbieId],
    );
    expect(await isTaskPoc(prodId, task, deptNewbieId)).toBe(true);
    expect(await isTaskPoc(prodId, task, deptPocId)).toBe(false);
    expect(await canAssignTechReq(await ctxOf(deptNewbieId), task.id, prodId)).toBe(true);

    await getPool().query(
      `UPDATE production_dept_member SET is_poc = (user_id = $3)
        WHERE production_id = $1 AND dept_id = $2`,
      [prodId, deptId, deptPocId],
    );
  });
});

describe("4. 组成员（非 POC）只得可见，不得编辑/指派", () => {
  it("runner 看得到已确认的绑组 task，但改不了也派不了", async () => {
    const task = await makeGroupTask("in_progress");
    const runnerCtx = await ctxOf(runnerId);

    expect(await canViewTechReq(runnerCtx, task.id, eventId, prodId, null, { participantDeptIds: [] })).toBe(true);
    expect(await canEditTechReq(runnerCtx, task.id, eventId, prodId)).toBe(false);
    expect(await canAssignTechReq(runnerCtx, task.id, prodId)).toBe(false);

    // 无关成员看不到
    const strangerCtx = await ctxOf(strangerId);
    expect(await canViewTechReq(strangerCtx, task.id, eventId, prodId, null, { participantDeptIds: [] })).toBe(false);
  });

  it("awaiting 的绑组 task 对普通组员不可见（与部门那支同一条门槛）", async () => {
    const task = await makeGroupTask("awaiting");
    const runnerCtx = await ctxOf(runnerId);
    expect(await canViewTechReq(runnerCtx, task.id, eventId, prodId, null, { participantDeptIds: [] })).toBe(false);
  });
});

describe("5. 绑组的 task 让组员看得见这个 event", () => {
  it("task 通道与 schedule 通道等价，且不落 grant 行", async () => {
    await makeGroupTask();
    expect(await canEnterEvent(await actorOf(runnerId), prodId, eventId)).toBe(true);

    const { rows } = await getPool().query(
      `SELECT 1 FROM production_member_grant
        WHERE production_id = $1 AND user_id = $2 AND resource_type = 'event' AND resource_id = $3`,
      [prodId, runnerId, eventId],
    );
    expect(rows).toHaveLength(0);

    expect(await canEnterEvent(await actorOf(strangerId), prodId, eventId)).toBe(false);
  });
});

describe("6. 绑组 task 出现在组 POC 的「与我相关」里", () => {
  it("组 POC 的任务页看得到它——少了这段任务会凭空消失", async () => {
    const task = await makeGroupTask();
    const mine = await listMyTechReqsFull(deptPocId);
    const row = mine.find(t => t.id === task.id);
    expect(row).toBeDefined();
    expect(row!.groupId).toBe(groupId);
    expect(row!.amPoc).toBe(true);

    // 非 POC 的组员不在「与我相关」里（与部门那支一致：只认 POC 与 assignee）
    expect((await listMyTechReqsFull(runnerId)).some(t => t.id === task.id)).toBe(false);
  });
});

describe("7. 主体消失不连坐删 task", () => {
  it("解绑主体 → task 还在，只是没有责任方", async () => {
    const task = await makeGroupTask();
    await updateTaskByProduction(task.id, prodId, { groupId: null });
    const after = (await getTechReqByProduction(task.id, prodId))!;
    expect(after.groupId).toBeNull();
    expect(taskSubjectOf(after)).toBeNull();
    expect(await isTaskPoc(prodId, after, deptPocId)).toBe(false);
  });

  it("被未冻结的 task 引用时删不掉；引用冻结后可删，task.group_id 置空但 task 还在", async () => {
    const g = await createEventGroup({
      productionId: prodId, eventId, name: `将被删${shortId()}`,
      members: [{ kind: "dept", id: deptId }], poc: { kind: "dept", id: deptId },
      createdBy: organizerId,
    });
    const t = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [],
      title: "随组消失的活", description: "", presetMinutes: null,
      departmentId: null, groupId: g.id, assignees: [], createdBy: organizerId,
    });

    // task 引用也是活引用：直接删会把这条 task 的责任主体静默清空，所以挡住
    await expect(deleteEventGroup(g.id, prodId)).rejects.toThrow(EventGroupError);

    // 冻结之后引用不再是活的（快照自带组名与 POC），放行
    await freezeEventGroups(eventId, organizerId);
    await deleteEventGroup(g.id, prodId);

    const after = await getTechReqByProduction(t.id, prodId);
    expect(after).not.toBeNull();          // ON DELETE SET NULL，不连坐删 task
    expect(after!.groupId).toBeNull();

    await unfreezeEventGroups(eventId);
  });
});
