import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, getProductionPermissionContext } from "@/lib/db";
import {
  createProductionEvent, createEventTechReq, upsertAwaitingTechReqs,
  setTechReqAssignees, updateTaskByProduction, isUserDeptPoc, isUserDeptMember,
} from "@/lib/event-db";
import { canAssignTechReq, canEditTechReq, canViewTechReq } from "@/lib/event-permissions";
import { getPool } from "@/lib/pg";
import type { PermissionContext } from "@/lib/permissions";

// task 自动授权规则（用户规范）：
//   1. 不论路径与进度：关联部门的 POC 可编辑内容+推进状态（上下文判定）
//   2. 不论路径与进度：assignee 可见+可推进进度（上下文判定）
//   3. 已确认（非 awaiting）+ 关联部门 → 部门全员可见（上下文判定）
//   4. 删除权按路径：explicit 创建 POC 无自动删除权；dept_auto 有（created_via 列）

let prodId: string;
let ownerId: string;
let pocId: string;
let memberId: string;
let assigneeId: string;
let eventId: string;
let deptId: string;

async function ctxOf(userId: string): Promise<PermissionContext> {
  const access = await getProductionPermissionContext(userId, false, prodId);
  return access!.permCtx;
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `规则甲${shortId()}`, null, false)).userId;
  pocId = (await upsertFeishuUser(`test-open-${shortId()}`, `部门POC${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `部门成员${shortId()}`, null, false)).userId;
  assigneeId = (await upsertFeishuUser(`test-open-${shortId()}`, `被指派${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  for (const u of [ownerId, pocId, memberId, assigneeId]) await addProductionMember(prodId, u);

  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "task规则",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: ownerId,
  });
  eventId = ev.id;

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `技术部${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1, $2, $3, true), ($1, $2, $4, false)`,
    [prodId, deptId, pocId, memberId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("规则1：关联部门的 POC 恒可编辑（不论路径/进度）", () => {
  it("explicitly created task with dept: POC can edit via contextual rule", async () => {
    const req = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [], title: "显式task",
      description: "", presetMinutes: null, departmentId: deptId,
      assignees: [], createdBy: ownerId,
    });
    expect(req.createdVia).toBe("explicit");
    expect(await canEditTechReq(await ctxOf(pocId), req.id, eventId, prodId)).toBe(true);
    // 非 POC 成员不能编辑
    expect(await canEditTechReq(await ctxOf(memberId), req.id, eventId, prodId)).toBe(false);
  });
});

describe("规则2：assignee 恒可见（不论路径/进度）", () => {
  it("assignee sees the task via contextual rule", async () => {
    const req = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [], title: "指派task",
      description: "", presetMinutes: null, departmentId: null,
      assignees: [], createdBy: ownerId,
    });
    await setTechReqAssignees(req.id, [{ userId: assigneeId, name: "被指派" }]);
    const visible = await canViewTechReq(
      await ctxOf(assigneeId), req.id, eventId, prodId, null, { participantDeptIds: [] },
    );
    expect(visible).toBe(true);
    // 被 assign 进 task ⇒ 自动获得 event meta+details@view（技术需求 call 同族）
    const { rows } = await getPool().query<{ resource_sub: string }>(
      `SELECT resource_sub FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2 AND resource_type = 'event'
         AND resource_id = $3 AND permission_level = 'view' AND NOT is_revoked`,
      [prodId, assigneeId, eventId],
    );
    expect(rows.map((r) => r.resource_sub).sort()).toEqual(["details", "meta", "publication"]);
  });
});

describe("规则3：已确认 + 关联部门 → 部门全员可见", () => {
  it("awaiting task hidden from plain member; confirmed task visible", async () => {
    const [req] = await upsertAwaitingTechReqs(eventId, [deptId]);
    expect(req.createdVia).toBe("dept_auto");
    expect(req.status).toBe("awaiting");
    const before = await canViewTechReq(
      await ctxOf(memberId), req.id, eventId, prodId, deptId, { participantDeptIds: [] },
    );
    expect(before).toBe(false);
    await updateTaskByProduction(req.id, prodId, { status: "pending" });
    const after = await canViewTechReq(
      await ctxOf(memberId), req.id, eventId, prodId, deptId, { participantDeptIds: [] },
    );
    expect(after).toBe(true);
  });
});

describe("路径三：POC 为本部门主动发起 task", () => {
  it("poc-created task is marked 'poc' and dept members see it once confirmed-by-nature", async () => {
    const req = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [], title: "服装对装",
      description: "", presetMinutes: null, departmentId: deptId,
      assignees: [], createdBy: pocId, createdVia: "poc",
    });
    expect(req.createdVia).toBe("poc");
    // POC 恒可编辑（规则1 同源）
    expect(await canEditTechReq(await ctxOf(pocId), req.id, eventId, prodId)).toBe(true);
    // 非 awaiting → 部门成员可见（规则3）
    const visible = await canViewTechReq(
      await ctxOf(memberId), req.id, eventId, prodId, deptId, { participantDeptIds: [] },
    );
    expect(visible).toBe(true);
  });
});

describe("规则5：指派面独立于 event 编辑级联（2026-08-15 定谳）", () => {
  it("organizer（event details@edit 级联）可编辑内容但不可指派；POC 可指派", async () => {
    const organizerId = (await upsertFeishuUser(`test-open-${shortId()}`, `组织者${shortId()}`, null, false)).userId;
    await addProductionMember(prodId, organizerId);
    // organizer 创建 event → writeEventGrants 发创建者 manage 行集（含 details@edit）
    const ev = await createProductionEvent({
      id: `ev_${shortId()}`, productionId: prodId, title: "指派面事件",
      eventType: "rehearsal", location: "", startTime: null, endTime: null,
      description: "", createdBy: organizerId,
    });
    const req = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: ev.id, scheduleItemIds: [],
      title: "指派面task", description: "", presetMinutes: null, departmentId: deptId,
      assignees: [], createdBy: organizerId,
    });
    const organizerCtx = await ctxOf(organizerId);
    // 内容编辑：event details@edit 级联保留
    expect(await canEditTechReq(organizerCtx, req.id, ev.id, prodId)).toBe(true);
    // 指派：级联不含——organizer 发部门、POC 分人
    expect(await canAssignTechReq(organizerCtx, req.id, prodId)).toBe(false);
    // 关联部门 POC 可指派（上下文判定 + writeTechReqGrants 的 assignees@edit 行）
    expect(await canAssignTechReq(await ctxOf(pocId), req.id, prodId)).toBe(true);
    // 无关成员不可指派
    expect(await canAssignTechReq(await ctxOf(memberId), req.id, prodId)).toBe(false);

    await getPool().query("DELETE FROM production_event WHERE id = $1", [ev.id]).catch(() => {});
  });
});

describe("规则4：created_via 路径落库", () => {
  it("helpers reflect dept relations", async () => {
    expect(await isUserDeptPoc(deptId, pocId)).toBe(true);
    expect(await isUserDeptPoc(deptId, memberId)).toBe(false);
    expect(await isUserDeptMember(deptId, memberId)).toBe(true);
  });
});
