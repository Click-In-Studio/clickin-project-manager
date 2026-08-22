/**
 * Phase（项目大阶段）：实体 CRUD 门 + 边表不变量。
 *
 * 设计定谳（feat/phase）：
 *   - milestone（点）与 phase（区间）平级，phase_milestone 多对多；task 挂 phase。
 *   - 可见性全员：GET 只要成员身份，无 grant 门。
 *   - 创建门 = phase/*@create（owner 旁路内建）∨ 部门 POC 建自己部门的 dept-level
 *     phase（policy.phase_dept_poc_create，形状 C 活引用判定）；edit/delete 对称。
 *   - deptId 仅限 kind='dept'（用户组不该有阶段）；跨剧组 milestone/phase id 静默丢弃。
 *   - 没头默认当天开始；end_date 可空=未定，且不得早于 start_date。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, createMilestone } from "@/lib/db";
import { createEventTechReq, setTaskPhases, getTechReqByProduction } from "@/lib/event-db";
import { listPhases, getPhase, setPhaseMilestones } from "@/lib/phase-db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { setPolicies } from "@/lib/policy-db";
import { POLICY_ON, POLICY_OFF } from "@/lib/policy-keys";
import { getPool } from "@/lib/pg";
import { GET as listPhasesRoute, POST as createPhaseRoute } from "@/app/api/production/[id]/phases/route";
import { PATCH as patchPhaseRoute, DELETE as deletePhaseRoute } from "@/app/api/production/[id]/phases/[phaseId]/route";

let prodId: string;
let otherProdId: string;
let deptId: string;
let otherDeptId: string;
let groupId: string;

let ownerId: string;
let memberId: string;
let pocId: string;

async function makeUser(tag: string): Promise<string> {
  const u = await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false);
  return u.userId;
}

function makeReq(userId: string, method: string, body?: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api", {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  req.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return req;
}

const listCtx = () => ({ params: Promise.resolve({ id: prodId }) });
const itemCtx = (phaseId: string) => ({ params: Promise.resolve({ id: prodId, phaseId }) });

async function ownerCreate(body: Record<string, unknown>): Promise<{ status: number; phase?: { id: string } & Record<string, unknown> }> {
  const res = await createPhaseRoute(makeReq(ownerId, "POST", body), listCtx());
  const data = await res.json().catch(() => null);
  return { status: res.status, phase: data?.phase };
}

beforeAll(async () => {
  ownerId = await makeUser("owner");
  memberId = await makeUser("member");
  pocId = await makeUser("poc");

  ({ prodId } = await makeProduction(ownerId));
  ({ prodId: otherProdId } = await makeProduction());
  for (const u of [memberId, pocId]) await addProductionMember(prodId, u);

  const pool = getPool();
  ({ rows: [{ id: deptId }] } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id",
    [prodId, `灯光部${shortId()}`],
  ));
  ({ rows: [{ id: otherDeptId }] } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id",
    [prodId, `舞美部${shortId()}`],
  ));
  ({ rows: [{ id: groupId }] } = await pool.query<{ id: string }>(
    "INSERT INTO production_dept (production_id, name, kind) VALUES ($1, $2, 'group') RETURNING id",
    [prodId, `用户组${shortId()}`],
  ));
  await pool.query(
    "INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1, $2, $3, true)",
    [prodId, deptId, pocId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM task WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

// ── 实体 CRUD 门 ──────────────────────────────────────────────────────────────

describe("phase 创建门", () => {
  it("owner 建 production-level phase；没头默认当天开始、尾未定", async () => {
    const { status, phase } = await ownerCreate({ name: "筹备期" });
    expect(status).toBe(201);
    expect(phase!.deptId).toBeNull();
    expect(phase!.startDate).toBe(new Date().toISOString().slice(0, 10));
    expect(phase!.endDate).toBeNull();
  });

  it("普通成员无 grant → 403", async () => {
    const res = await createPhaseRoute(makeReq(memberId, "POST", { name: "越权阶段" }), listCtx());
    expect(res.status).toBe(403);
  });

  it("结束早于开始 → 400；用户组作归属 → 400；畸形 deptId → 400 而非 500", async () => {
    expect((await ownerCreate({ name: "倒置", startDate: "2027-02-01", endDate: "2027-01-01" })).status).toBe(400);
    expect((await ownerCreate({ name: "组阶段", deptId: groupId })).status).toBe(400);
    // review 意见：裸 ::uuid cast 遇畸形输入会 PG 抛错变 500——先验格式回 400
    expect((await ownerCreate({ name: "畸形归属", deptId: "not-a-uuid" })).status).toBe(400);
  });

  it("部门 POC（policy 默认 ON）：可建自己部门的；不可建 production-level 或别的部门的", async () => {
    const mine = await createPhaseRoute(
      makeReq(pocId, "POST", { name: "灯光进场", deptId }), listCtx(),
    );
    expect(mine.status).toBe(201);

    const global = await createPhaseRoute(makeReq(pocId, "POST", { name: "越权全局" }), listCtx());
    expect(global.status).toBe(403);

    const others = await createPhaseRoute(
      makeReq(pocId, "POST", { name: "越权他部", deptId: otherDeptId }), listCtx(),
    );
    expect(others.status).toBe(403);
  });

  it("policy 关掉后部门 POC 也建不了", async () => {
    await setPolicies(prodId, { "policy.phase_dept_poc_create": POLICY_OFF }, ownerId);
    try {
      const res = await createPhaseRoute(
        makeReq(pocId, "POST", { name: "关闸后", deptId }), listCtx(),
      );
      expect(res.status).toBe(403);
    } finally {
      await setPolicies(prodId, { "policy.phase_dept_poc_create": POLICY_ON }, ownerId);
    }
  });
});

describe("phase 读面与改删门", () => {
  it("可见性全员：普通成员 GET 能看到全部（含部门级）阶段", async () => {
    const res = await listPhasesRoute(makeReq(memberId, "GET"), listCtx());
    expect(res.status).toBe(200);
    const { phases } = await res.json() as { phases: { deptId: string | null }[] };
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases.some(p => p.deptId !== null)).toBe(true);
  });

  it("POC 改删自己部门的 phase；普通成员 403", async () => {
    const { phase } = await ownerCreate({ name: "POC 管辖", deptId });

    const memberPatch = await patchPhaseRoute(
      makeReq(memberId, "PATCH", { name: "越权改名" }), itemCtx(phase!.id),
    );
    expect(memberPatch.status).toBe(403);

    const pocPatch = await patchPhaseRoute(
      makeReq(pocId, "PATCH", { name: "POC 改名", endDate: "2099-12-31" }), itemCtx(phase!.id),
    );
    expect(pocPatch.status).toBe(200);
    expect((await getPhase(phase!.id))!.name).toBe("POC 改名");

    const pocDelete = await deletePhaseRoute(makeReq(pocId, "DELETE"), itemCtx(phase!.id));
    expect(pocDelete.status).toBe(200);
    expect(await getPhase(phase!.id)).toBeNull();
  });

  it("PATCH 终值校验：把尾改到头之前 → 400", async () => {
    const { phase } = await ownerCreate({ name: "次序守卫", startDate: "2027-03-01" });
    const res = await patchPhaseRoute(
      makeReq(ownerId, "PATCH", { endDate: "2027-02-01" }), itemCtx(phase!.id),
    );
    expect(res.status).toBe(400);
  });
});

// ── 边表不变量 ────────────────────────────────────────────────────────────────

describe("phase_milestone / task_phase 边", () => {
  it("phase↔milestone 绑定：跨剧组 milestone id 静默丢弃（创建同事务携带 + 独立替换两条路径）", async () => {
    const ms = await createMilestone(`ms${shortId()}`, prodId, "首演", "2027-06-01", 0);
    const foreign = await createMilestone(`ms${shortId()}`, otherProdId, "别家首演", "2027-06-01", 0);

    // 路径一：创建时携带（createPhase 单事务落本体+边）
    const { status, phase } = await ownerCreate({
      name: "演出季", startDate: "2027-05-01", milestoneIds: [ms.id, foreign.id],
    });
    expect(status).toBe(201);
    expect((phase as unknown as { milestoneIds: string[] }).milestoneIds).toEqual([ms.id]);

    // 路径二：独立整体替换
    await setPhaseMilestones(phase!.id, prodId, [foreign.id]);
    expect((await getPhase(phase!.id))!.milestoneIds).toEqual([]);
    await setPhaseMilestones(phase!.id, prodId, [ms.id, foreign.id]);
    expect((await getPhase(phase!.id))!.milestoneIds).toEqual([ms.id]);
  });

  it("task 挂 phase：创建携带 + 整体替换，跨剧组 phase id 静默丢弃", async () => {
    const { phase: p1 } = await ownerCreate({ name: "阶段甲" });
    const { phase: p2 } = await ownerCreate({ name: "阶段乙" });
    // 别家 phase（裸 SQL：跨剧组本就不该有入口）
    const foreignPhaseId = `ph${shortId()}`;
    await getPool().query(
      "INSERT INTO phase (id, production_id, name, start_date) VALUES ($1, $2, '别家阶段', '2027-01-01')",
      [foreignPhaseId, otherProdId],
    );

    const task = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: null, scheduleItemIds: [],
      title: "挂阶段的任务", description: "", presetMinutes: null,
      departmentId: null, assignees: [], createdBy: ownerId,
      phaseIds: [p1!.id, foreignPhaseId],
    });
    expect(task.phaseIds).toEqual([p1!.id]);

    await setTaskPhases(task.id, prodId, [p2!.id, foreignPhaseId]);
    const updated = await getTechReqByProduction(task.id, prodId);
    expect(updated!.phaseIds).toEqual([p2!.id]);
  });

  it("删 phase 级联断边，task 与 milestone 本体不动", async () => {
    const ms = await createMilestone(`ms${shortId()}`, prodId, "联排", "2027-04-01", 0);
    const { phase } = await ownerCreate({ name: "会消失的阶段", milestoneIds: [ms.id] });
    const task = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: null, scheduleItemIds: [],
      title: "边上的任务", description: "", presetMinutes: null,
      departmentId: null, assignees: [], createdBy: ownerId,
      phaseIds: [phase!.id],
    });

    const del = await deletePhaseRoute(makeReq(ownerId, "DELETE"), itemCtx(phase!.id));
    expect(del.status).toBe(200);
    expect((await getTechReqByProduction(task.id, prodId))!.phaseIds).toEqual([]);
    const { rows } = await getPool().query("SELECT 1 FROM milestone WHERE id = $1", [ms.id]);
    expect(rows).toHaveLength(1);
  });

  it("部门解散：dept-level phase SET NULL 升级为全局而不是消失", async () => {
    const pool = getPool();
    const { rows: [{ id: tempDept }] } = await pool.query<{ id: string }>(
      "INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id",
      [prodId, `临时部${shortId()}`],
    );
    const { phase } = await ownerCreate({ name: "遗孤阶段", deptId: tempDept });
    await pool.query("DELETE FROM production_dept WHERE id = $1", [tempDept]);
    const after = await getPhase(phase!.id);
    expect(after).not.toBeNull();
    expect(after!.deptId).toBeNull();
  });
});

describe("listPhases 排序", () => {
  it("按 start_date 升序", async () => {
    const phases = await listPhases(prodId);
    const starts = phases.map(p => p.startDate);
    expect([...starts].sort()).toEqual(starts);
  });
});
