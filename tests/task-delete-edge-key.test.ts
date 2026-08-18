/**
 * task 删除门：边键不得当本体键用（M-15(d)，2026-08-18）。
 *
 * 事故：两条 task DELETE 路由（`/tasks/[taskId]` 与 `/events/[eventId]/tech-reqs/[reqId]`）
 * 同门同实现，都调 deleteTaskByProduction（硬删 task 行），而门是
 *     task/<id>/*@delete  ‖  event/<id>/tasks@delete
 * 第二个是**边键**——语义是「把 task 从我的事件上摘下来」，不是「删掉它」。
 * C-2 创建者行集把 `tasks@create/delete` 发给 event 创建者，于是 organizer 能硬删
 * 部门的 task 本体，与「指派面独立」定谳（organizer 不能指派，任务分配归部门 POC）
 * 正面冲突：**不能指派，却能删除**。
 *
 * 修法：两条路由都只认本体键。摘边另有其路——PATCH /tasks/<id> { eventId: null }，
 * 门是 canEditTechReq（含 event details@edit，organizer 有），所以收紧删除门不会
 * 把 organizer 卡死，只是把「摘边」和「删除」两个动作分开了。
 *
 * 三层：
 *   ① 越权回归：organizer 持边键 → 两条 DELETE 都 403（修前都是 200）
 *   ② 不误伤：本体键持有者 / dept_auto 路径的 POC 仍可删；organizer 仍可摘边
 *   ③ 棘轮：硬删本体的路由，门里不得再出现宿主子集合键
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import {
  createProductionEvent, createEventTechReq, upsertAwaitingTechReqs,
  getTechReqByProduction,
} from "@/lib/event-db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { setPolicies } from "@/lib/policy-db";
import { POLICY_ON, POLICY_OFF } from "@/lib/policy-keys";
import { getPool } from "@/lib/pg";
import { DELETE as deleteTaskStandalone, PATCH as patchTask } from "@/app/api/production/[id]/tasks/[taskId]/route";
import { DELETE as deleteTaskUnderEvent } from "@/app/api/production/[id]/events/[eventId]/tech-reqs/[reqId]/route";

let prodId: string;
let eventId: string;
let deptId: string;

let ownerId: string;      // 演出 owner（旁路，不参与被测判定）
let organizerId: string;  // 建了 event 的普通成员 → C-2 行集（含 event tasks@delete 边键）
let pocId: string;        // 关联部门 POC → C-4 行集（含 task/<id>/*@delete 本体键）
let outsiderId: string;   // 本项目成员，什么都没有

async function makeUser(tag: string): Promise<string> {
  const u = await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false);
  return u.userId;
}

function makeReq(userId: string, body?: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api", {
    method: body ? "PATCH" : "DELETE",
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  req.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return req;
}

/** 新建一条绑在 event + dept 上的 explicit task（C-4 给 POC 发本体行集）。 */
async function makeTask(): Promise<string> {
  const req = await createEventTechReq({
    id: `tr_${shortId()}`, productionId: prodId, eventId, scheduleItemIds: [],
    title: `边键测试${shortId()}`, description: "", presetMinutes: null,
    departmentId: deptId, assignees: [], createdBy: organizerId,
  });
  return req.id;
}

beforeAll(async () => {
  ownerId = await makeUser("owner");
  organizerId = await makeUser("organizer");
  pocId = await makeUser("poc");
  outsiderId = await makeUser("outsider");

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [organizerId, pocId, outsiderId]) await addProductionMember(prodId, u);

  // organizer 建 event → C-2 创建者行集（14 行，含 tasks@create/delete 边键）
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "边键测试事件",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: organizerId,
  });
  eventId = ev.id;

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `技术部${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc)
     VALUES ($1, $2, $3, true)`,
    [prodId, deptId, pocId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM task WHERE production_id = $1", [prodId]).catch(() => {});
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

// ── ⓪ 前提：两把钥匙确实分别在这两个人手上 ─────────────────────────────────────

describe("前提", () => {
  it("organizer 持边键 event/<id>/tasks@delete，但不持任何 task 本体键", async () => {
    expect(await hasGrant(organizerId, prodId, "event", eventId, "tasks", "delete")).toBe(true);
    const taskId = await makeTask();
    expect(await hasGrant(organizerId, prodId, "task", taskId, "*", "delete")).toBe(false);
  });

  it("explicit 路径：关联部门 POC **默认不持**本体删除键——V-1 原意（#236 起生效）", async () => {
    // C-4 曾无条件发 `task/<id>/*@delete`，把路由第三分支的 created_via 上下文规则
    // （V-1「organizer 显式创建的 task，部门 POC 无自动删除权」）盖成空转。
    // 策略键 task.dept_poc:*@delete 默认关之后，本写点不再发这一行，V-1 复活。
    const taskId = await makeTask();
    expect(await hasGrant(pocId, prodId, "task", taskId, "*", "delete")).toBe(false);
  });

  it("打开 task.dept_poc:*@delete ⇒ C-4 才发本体删除键（「任务归执行部门」那一档）", async () => {
    await setPolicies(prodId, { "task.dept_poc:*@delete": POLICY_ON }, pocId);
    const taskId = await makeTask();
    expect(await hasGrant(pocId, prodId, "task", taskId, "*", "delete")).toBe(true);
    await setPolicies(prodId, { "task.dept_poc:*@delete": POLICY_OFF }, pocId);
  });
});

// ── ① 越权回归：边键不再能删本体 ──────────────────────────────────────────────

describe("M-15(d)：边键不得作为本体删除的充分条件", () => {
  it("organizer 删部门 task（独立路由）→ 403，且 task 仍在（修前 200）", async () => {
    const taskId = await makeTask();
    const res = await deleteTaskStandalone(
      makeReq(organizerId), { params: Promise.resolve({ id: prodId, taskId }) },
    );
    expect(res.status).toBe(403);
    expect(await getTechReqByProduction(taskId, prodId)).not.toBeNull();
  });

  it("organizer 删部门 task（event 路径下）→ 403，且 task 仍在（修前 200）", async () => {
    const taskId = await makeTask();
    const res = await deleteTaskUnderEvent(
      makeReq(organizerId), { params: Promise.resolve({ id: prodId, eventId, reqId: taskId }) },
    );
    expect(res.status).toBe(403);
    expect(await getTechReqByProduction(taskId, prodId)).not.toBeNull();
  });

  it("什么都没有的成员 → 403", async () => {
    const taskId = await makeTask();
    const res = await deleteTaskStandalone(
      makeReq(outsiderId), { params: Promise.resolve({ id: prodId, taskId }) },
    );
    expect(res.status).toBe(403);
  });
});

// ── ② 不误伤 ────────────────────────────────────────────────────────────────

describe("本体键与既有上下文规则不受影响", () => {
  it("持本体键的部门 POC → 200，task 真的没了（开关打开时）", async () => {
    await setPolicies(prodId, { "task.dept_poc:*@delete": POLICY_ON }, pocId);
    const taskId = await makeTask();
    await setPolicies(prodId, { "task.dept_poc:*@delete": POLICY_OFF }, pocId);
    const res = await deleteTaskStandalone(
      makeReq(pocId), { params: Promise.resolve({ id: prodId, taskId }) },
    );
    // 关关掉不撤已发的行（铁律：开关不否决已存在的行）——所以这里仍是 200
    expect(res.status).toBe(200);
    expect(await getTechReqByProduction(taskId, prodId)).toBeNull();
  });

  it("explicit 路径 + 开关关 ⇒ POC 删不掉（V-1 端到端）", async () => {
    const taskId = await makeTask();
    const res = await deleteTaskStandalone(
      makeReq(pocId), { params: Promise.resolve({ id: prodId, taskId }) },
    );
    expect(res.status).toBe(403);
    expect(await getTechReqByProduction(taskId, prodId)).not.toBeNull();
  });

  it("dept_auto 路径的 POC 上下文规则仍在（V-1 的另一半）", async () => {
    const [req] = await upsertAwaitingTechReqs(eventId, [deptId]);
    expect(req.createdVia).toBe("dept_auto");
    const res = await deleteTaskUnderEvent(
      makeReq(pocId), { params: Promise.resolve({ id: prodId, eventId, reqId: req.id }) },
    );
    expect(res.status).toBe(200);
  });

  it("organizer 仍能摘边：PATCH { eventId: null } → 200，task 保留但已解绑", async () => {
    const taskId = await makeTask();
    const res = await patchTask(
      makeReq(organizerId, { eventId: null }), { params: Promise.resolve({ id: prodId, taskId }) },
    );
    expect(res.status).toBe(200);
    const after = await getTechReqByProduction(taskId, prodId);
    expect(after).not.toBeNull();
    expect(after!.eventId).toBeNull();
  });
});

// ── ③ 棘轮：硬删本体的路由，门里不得出现宿主子集合键 ──────────────────────────

/** 硬删本体的 db 函数：调用它的 DELETE handler 只能认本体键。 */
const HARD_DELETE_CALLS: readonly string[] = ["deleteTaskByProduction"];

/** 宿主子集合键（边键）在门里的写法：hasEffectiveGrant(..., "event", …, "tasks", "delete")。 */
const EDGE_KEY_PATTERNS: readonly RegExp[] = [
  /"event"\s*,[\s\S]*?"tasks"\s*,\s*"delete"/,
  /"event"\s*,[\s\S]*?"reports"\s*,\s*"delete"/,
];

function collectRouteFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "route.ts") continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/** 截出 DELETE handler 的函数体（到下一个 export async function 为止）。 */
function deleteHandlerBody(text: string): string | null {
  const start = text.indexOf("export async function DELETE");
  if (start < 0) return null;
  const rest = text.slice(start);
  const next = rest.indexOf("export async function", "export async function".length);
  return next > 0 ? rest.slice(0, next) : rest;
}

describe("棘轮：硬删本体的路由不得接受宿主子集合键", () => {
  it("app/api 全库扫描", () => {
    const offenders: string[] = [];
    for (const { path, text } of collectRouteFiles(join(process.cwd(), "app", "api"))) {
      const body = deleteHandlerBody(text);
      if (!body) continue;
      if (!HARD_DELETE_CALLS.some((fn) => body.includes(`${fn}(`))) continue;
      // 注释里提到边键是允许的（本次修复就留了解释性注释），只扫非注释行
      const code = body
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const re of EDGE_KEY_PATTERNS) {
        if (re.test(code)) offenders.push(`${path.replace(process.cwd() + "/", "")} ← ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── ④ M-15(c)：本体删除门 ⊒ 边删除门 ─────────────────────────────────────────
//
// 曾记为「(c) 违反」：边门＝report/<id>/grants@edit（现已改为 *@delete），本体门＝
// wiki/<id>/*@delete，两把钥匙不可比 ⇒ 持 wiki 删除权者可绕过边门、删掉 wiki 让
// 报告边随之消失。**复核发现不成立**：deleteWiki 在有 report/note 挂载边时直接
// 拒绝（reason: "mounted"），本体压根删不掉，必须先解除挂载（走边门）再删。
//
// 实现给出的保证比 M-15(c) 要求的更强——不是「本体门 ⊒ 边门」，而是「有边禁止删
// 本体」，顺序由数据层强制。但这条保证只由 deleteWiki 里那一个 mounted 检查撑着，
// 拿掉它绕行就成真，故加棘轮。

describe("M-15(c)：有挂载边时本体不可删", () => {
  it("wiki 被 report 边引用 ⇒ deleteWiki 拒绝（reason=mounted），不是靠门拦而是靠数据层", async () => {
    const { createEventReport } = await import("@/lib/event-db");
    const { deleteWiki } = await import("@/lib/wiki-db");
    const report = await createEventReport({
      id: `rpt_${shortId()}`, eventId, reportType: "show",
      title: `M15c${shortId()}`, body: "", createdBy: organizerId,
    });
    const { rows } = await getPool().query<{ wiki_id: string }>(
      `SELECT wiki_id::text AS wiki_id FROM event_report WHERE id = $1`, [report.id],
    );
    expect(rows[0]?.wiki_id).toBeTruthy();

    const res = await deleteWiki(rows[0].wiki_id, prodId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("mounted");
  });

  it("棘轮：deleteWiki 必须保留挂载边检查（拿掉它 M-15(c) 的绕行就成真）", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("lib/wiki-db.ts", "utf8");
    const i = src.indexOf("export async function deleteWiki");
    const body = src.slice(i, i + 2000);
    expect(body).toMatch(/event_report\b/);
    expect(body).toMatch(/event_report_note\b/);
    expect(body).toMatch(/reason:\s*"mounted"/);
  });
});
