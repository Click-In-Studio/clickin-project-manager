/**
 * listEditableTaskIds（#589）与单条门 canEditTechReq 的对拍。
 *
 * 计划页原来对每条 task 各跑一次 canEditTechReq（2 次 hasGrant + 读 task + POC 判定），
 * 200 条任务的剧组普通成员一次打开约 400–800 次查询。集合版把它压成常数次，但
 * 「集合 = 逐条」这条等式没有别的东西守：判定分支有五条（task 行 / event 级联 /
 * 部门 POC / 组现任 POC / 冻结快照 POC），任何一条口径漂了单测都不会报错，只会
 * 让某类人在日历抽屉里多看见或少看见一个「编辑」按钮。
 *
 * 所以这里用随机工厂数据把六种身份的人逐一对拍，另外固定几条 task 保证每个分支
 * 都真的被走到（随机数据可能恰好一条都不覆盖）。失败时用打印的 TEST_SEED 复现。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { createProductionEvent, createEventTechReq } from "@/lib/ops/event-db";
import { createEventGroup, updateEventGroup } from "@/lib/ops/event-group-db";
import { freezeEventGroups } from "@/lib/ops/event-group-freeze";
import { canEditTechReq, listEditableTaskIds } from "@/lib/ops/event-permissions";
import type { PermissionContext } from "@/lib/perm/permissions";

type Task = { id: string; eventId: string | null };

let prodId: string;
let ownerId: string;
/** 灯光部 POC，别的什么都没有 */
let deptPocId: string;
/** 组 1 建组时的 POC；ev1 冻结后组 1 换 POC，他只剩快照里的资格 */
let oldGroupPocId: string;
/** 组 1 成员，冻结后接任 POC；只对未冻结 event 的组 1 任务有资格 */
let newGroupPocId: string;
/** 只有已撤销 / 已过期的行，等于什么都没有 */
let deadRowsId: string;
/** 两个随机身份：随机 POC + 随机 grant 行 */
let randomA: string;
let randomB: string;

let dept1: string; let dept2: string; let dept3: string;
let ev1: string; let ev2: string; let ev3: string;
let group1: string; let group2: string;

const tasks: Task[] = [];
let taskFrozenGroup: string;   // 组 1 + ev1（冻结）
let taskLiveGroup: string;     // 组 1 + ev2（未冻结）
let taskDept1: string;         // 灯光部，无 event
let taskBare: string;          // 无主体无 event

async function ctxOf(userId: string): Promise<PermissionContext> {
  const access = await getProductionPermissionContext(userId, false, prodId);
  return access!.permCtx;
}

async function newUser(label: string): Promise<string> {
  const u = await upsertFeishuUser(`test-open-${shortId()}`, `${label}${shortId()}`, null, false);
  await addProductionMember(prodId, u.userId);
  return u.userId;
}

async function newDept(name: string): Promise<string> {
  const { rows: [{ id }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `${name}${shortId()}`],
  );
  return id;
}

async function setDeptMember(deptId: string, userId: string, isPoc: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,$4)`,
    [prodId, deptId, userId, isPoc],
  );
}

async function newEvent(title: string): Promise<string> {
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title,
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: ownerId,
  });
  return ev.id;
}

async function newTask(
  subject: { departmentId?: string; groupId?: string } | null,
  eventId: string | null,
): Promise<string> {
  const req = await createEventTechReq({
    id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [],
    title: `对拍${shortId()}`, description: "", presetMinutes: null,
    departmentId: subject?.departmentId ?? null, groupId: subject?.groupId ?? null,
    assignees: [], createdBy: ownerId,
  });
  tasks.push({ id: req.id, eventId });
  return req.id;
}

async function grant(
  userId: string, type: "task" | "event", resourceId: string, sub: string,
  opts: { revoked?: boolean; expired?: boolean } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by, is_revoked, revoked_reason, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'edit', 'direct', $2, $6, $7, $8)`,
    [prodId, userId, type, resourceId, sub,
     opts.revoked ?? false, opts.revoked ? "manual" : null,
     opts.expired ? new Date(Date.now() - 86_400_000).toISOString() : null],
  );
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `对拍主${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  deptPocId      = await newUser("灯光POC");
  oldGroupPocId  = await newUser("旧组POC");
  newGroupPocId  = await newUser("新组POC");
  deadRowsId     = await newUser("死行");
  randomA        = await newUser("随机甲");
  randomB        = await newUser("随机乙");

  [dept1, dept2, dept3] = await Promise.all([newDept("灯光"), newDept("音响"), newDept("舞美")]);
  await setDeptMember(dept1, deptPocId, true);
  await setDeptMember(dept1, oldGroupPocId, false);
  // 随机身份：每个人在音响 / 舞美各自随机是成员 / POC / 不在
  for (const u of [randomA, randomB]) {
    for (const d of [dept2, dept3]) {
      const role = faker.helpers.arrayElement(["none", "member", "poc"] as const);
      if (role !== "none") await setDeptMember(d, u, role === "poc");
    }
  }

  [ev1, ev2, ev3] = await Promise.all([newEvent("上海站"), newEvent("北京站"), newEvent("广州站")]);

  // 组 1：两个自然人成员，POC 是人；组 2：两个部门成员，POC 是音响部（部门型组 POC）
  group1 = (await createEventGroup({
    productionId: prodId, eventId: null, name: `对光组${shortId()}`,
    members: [{ kind: "user", id: oldGroupPocId }, { kind: "user", id: newGroupPocId }],
    poc: { kind: "user", id: oldGroupPocId }, createdBy: ownerId,
  })).id;
  group2 = (await createEventGroup({
    productionId: prodId, eventId: null, name: `装台组${shortId()}`,
    members: [{ kind: "dept", id: dept1 }, { kind: "dept", id: dept2 }],
    poc: { kind: "dept", id: dept2 }, createdBy: ownerId,
  })).id;

  // 固定 task：保证五条分支各有至少一条覆盖
  taskFrozenGroup = await newTask({ groupId: group1 }, ev1);
  taskLiveGroup   = await newTask({ groupId: group1 }, ev2);
  taskDept1       = await newTask({ departmentId: dept1 }, null);
  taskBare        = await newTask(null, null);
  // 随机 task：主体 × event 全组合里随机抽
  const subjects = [null, { departmentId: dept1 }, { departmentId: dept2 }, { departmentId: dept3 },
                    { groupId: group1 }, { groupId: group2 }];
  const eventIds = [null, ev1, ev2, ev3];
  for (let i = 0; i < 24; i++) {
    await newTask(faker.helpers.arrayElement(subjects), faker.helpers.arrayElement(eventIds));
  }

  // ev1 冻结（快照里组 1 的 POC 是旧 POC），然后组 1 换 POC → 两个 event 里的组 1 任务分道
  await freezeEventGroups(ev1, ownerId);
  await updateEventGroup(group1, prodId, { poc: { kind: "user", id: newGroupPocId } });

  // grant 行：随机身份各随机发几行；死行用户只有撤销 / 过期行
  for (const u of [randomA, randomB]) {
    if (faker.datatype.boolean(0.3)) await grant(u, "task", "*", "*");
    if (faker.datatype.boolean(0.3)) await grant(u, "event", "*", "details");
    for (const t of faker.helpers.arrayElements(tasks, 3)) await grant(u, "task", t.id, "*");
    await grant(u, "event", faker.helpers.arrayElement([ev1, ev2, ev3]), "details");
    // 干扰行：别的动词 / 别的 sub 不该算
    await grant(u, "event", faker.helpers.arrayElement([ev1, ev2, ev3]), "publication");
  }
  await grant(deadRowsId, "task", "*", "*", { revoked: true });
  await grant(deadRowsId, "event", "*", "details", { expired: true });
  await grant(deadRowsId, "task", taskBare, "*", { expired: true });

  // 建任务那一刻 writeTechReqGrants 会给当时的责任主体 POC 自动发 task/<id>/*@edit 行。
  // 三位固定身份的这些行全部撤销，让他们的资格只剩上下文判定（部门 POC / 组现任 POC /
  // 冻结快照 POC）那一条——否则下面的夹具自检走的是行分支，证明不了 Type B 分支。
  // 随机甲乙保留自动行，让对拍多一种行来源。
  await getPool().query(
    `UPDATE production_member_grant SET is_revoked = true, revoked_reason = 'poc_change'
      WHERE production_id = $1 AND resource_type = 'task' AND user_id = ANY($2::uuid[])`,
    [prodId, [deptPocId, oldGroupPocId, newGroupPocId]],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

async function expectedByPerTaskGate(ctx: PermissionContext): Promise<string[]> {
  const out: string[] = [];
  for (const t of tasks) {
    if (await canEditTechReq(ctx, t.id, t.eventId, prodId)) out.push(t.id);
  }
  return out;
}

describe("listEditableTaskIds == 逐条 canEditTechReq", () => {
  it("六种身份逐一对拍，结果集合与顺序都一致", async () => {
    for (const [label, uid] of [
      ["灯光POC", deptPocId], ["旧组POC", oldGroupPocId], ["新组POC", newGroupPocId],
      ["死行", deadRowsId], ["随机甲", randomA], ["随机乙", randomB],
    ] as const) {
      const ctx = await ctxOf(uid);
      const expected = await expectedByPerTaskGate(ctx);
      const actual = await listEditableTaskIds(ctx, prodId, tasks.map(t => t.id));
      expect(actual, `${label} 的集合版与逐条门不一致`).toEqual(expected);
    }
  });

  it("owner 旁路：全部可编辑（与单条门一致，不读库）", async () => {
    const ctx = await ctxOf(ownerId);
    expect(ctx.isOwner).toBe(true);
    const ids = tasks.map(t => t.id);
    expect(await listEditableTaskIds(ctx, prodId, ids)).toEqual(ids);
  });

  it("夹具确实覆盖了每条分支（防止随机数据恰好一条都没走到）", async () => {
    // 部门 POC：灯光部任务可编，裸任务不可
    const dept = await listEditableTaskIds(await ctxOf(deptPocId), prodId, tasks.map(t => t.id));
    expect(dept).toContain(taskDept1);
    expect(dept).not.toContain(taskBare);
    // 冻结分裂：旧 POC 只剩冻结 event 里的组 1 任务；新 POC 只有未冻结 event 里的
    const old = await listEditableTaskIds(await ctxOf(oldGroupPocId), prodId, tasks.map(t => t.id));
    expect(old).toContain(taskFrozenGroup);
    expect(old).not.toContain(taskLiveGroup);
    const now = await listEditableTaskIds(await ctxOf(newGroupPocId), prodId, tasks.map(t => t.id));
    expect(now).toContain(taskLiveGroup);
    expect(now).not.toContain(taskFrozenGroup);
    // 死行：撤销 / 过期行一条都不算
    expect(await listEditableTaskIds(await ctxOf(deadRowsId), prodId, tasks.map(t => t.id))).toEqual([]);
  });
});

describe("集合版的自身契约", () => {
  it("查询次数与任务数无关（≤ 6 次），空入参零查询", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    try {
      const ctx = await ctxOf(randomA);
      spy.mockClear();
      await listEditableTaskIds(ctx, prodId, tasks.map(t => t.id));
      const forAll = spy.mock.calls.length;
      spy.mockClear();
      await listEditableTaskIds(ctx, prodId, tasks.slice(0, 2).map(t => t.id));
      const forTwo = spy.mock.calls.length;
      expect(forAll).toBeLessThanOrEqual(6);
      expect(forAll).toBeLessThanOrEqual(forTwo + 1);   // 至多多一次冻结快照查询
      spy.mockClear();
      expect(await listEditableTaskIds(ctx, prodId, [])).toEqual([]);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("保持入参顺序；不属于本剧组的 id 一律不给", async () => {
    const ctx = await ctxOf(deptPocId);
    const reversed = [...tasks].reverse().map(t => t.id);
    const got = await listEditableTaskIds(ctx, prodId, reversed);
    expect(got).toEqual(reversed.filter(id => got.includes(id)));
    expect(await listEditableTaskIds(ctx, prodId, [`tr_${shortId()}`, taskDept1])).toEqual([taskDept1]);
  });

  it("非成员（memberPermissions === null）恒空", async () => {
    const ctx: PermissionContext = { ...(await ctxOf(deptPocId)), memberPermissions: null };
    expect(await listEditableTaskIds(ctx, prodId, tasks.map(t => t.id))).toEqual([]);
  });
});
