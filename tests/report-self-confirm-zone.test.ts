/**
 * 报告自我确认：路由层回归 + 区间判定 + 死列棘轮（2026-08-17）。
 *
 * 事故：报告自确认路由的 POST 用 checkResourceFreeApprovalZone 判 edit 档，
 * 那个函数的 dept 分支查 `pd.permissions` 数组 + 伪键 'report:edit'——伪键随批C
 * 清零、数组列随 PR #229 并表批 DROP，函数却留在原地。GET 侧的 getReportAccess
 * 早已改走 checkNodeFreeApprovalZone，于是「页面说你可以自我确认，点下去 500」。
 * manage 档不碰那列，所以线上表现是时好时坏而非全挂——最难查的那种。
 *
 * **bug 在 wiring 上，不在被调函数里**（AI review finding 1）：所以第一层测试直接
 * 打 POST handler，而不是只测它的依赖——路由换错函数 / 传错参数都要红。
 *
 * 三层：
 *   ① 路由层：POST handler 的鉴权门 + 在区间/不在区间两条路径 + 行真的落库
 *   ② 判定层：checkNodeFreeApprovalZone 的四种命中/不命中（实例键/通配键/POC/无）
 *   ③ 棘轮层：源码里不得再出现已 DROP 的列名——同类死代码不会再活到线上
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/production/[id]/events/[eventId]/reports/[reportId]/access/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { checkNodeFreeApprovalZone } from "@/lib/resource-grant-db";
import { createProductionDept, setDeptMembers, addResourceDeptManage } from "@/lib/dept-db";
import { createProductionEvent, createEventReport } from "@/lib/event-db";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

let prodId: string;
let eventId: string;
let reportId: string;

let creatorId: string;    // 建 event/report 的人（不参与被测判定）
let zoneUserId: string;   // 经 dept 实例区间键拿资格
let pocUserId: string;    // 经管理 dept 的 POC 拿资格
let noneUserId: string;   // 有事件域 view，但无任何区间资格
let noViewUserId: string; // 本项目成员，但连事件域 view 都没有
let wildUserId: string;   // 经通配区间键拿资格
let outsiderId: string;   // 非本项目成员

const allUsers = (): string[] =>
  [creatorId, zoneUserId, pocUserId, noneUserId, noViewUserId, wildUserId, outsiderId].filter(Boolean);

async function makeUser(tag: string): Promise<string> {
  const u = await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false);
  return u.userId;
}

/** 事件域读取门（hasEventDomainView）的门票——与本次判定正交，直接发行。 */
async function giveEventDomainView(userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'event', '*', 'meta', 'view', 'auto')
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, userId],
  );
}

async function giveDeptZoneKey(deptId: string, key: string): Promise<void> {
  await getPool().query(
    `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
     VALUES ($1, $2, $3) ON CONFLICT (dept_id, permission_key) DO NOTHING`,
    [prodId, deptId, key],
  );
}

function makeReq(userId: string | null, body: unknown): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) {
    headers.Cookie =
      `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  }
  return new NextRequest(
    `http://localhost/api/production/${prodId}/events/${eventId}/reports/${reportId}/access`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

const routeCtx = () => ({ params: Promise.resolve({ id: prodId, eventId, reportId }) });

/** 该用户在这份报告上的活跃行（sub@verb）。 */
async function activeReportRows(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ k: string }>(
    `SELECT resource_sub || '@' || permission_level AS k
     FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2
       AND resource_type = 'report' AND resource_id = $3
       AND NOT is_revoked AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY 1`,
    [prodId, userId, reportId],
  );
  return rows.map(r => r.k);
}

beforeAll(async () => {
  creatorId  = await makeUser("报告作者");
  zoneUserId = await makeUser("区间成员");
  pocUserId  = await makeUser("负责人");
  noneUserId = await makeUser("无资格成员");
  noViewUserId = await makeUser("无事件域成员");
  wildUserId = await makeUser("通配成员");
  outsiderId = await makeUser("非成员");

  // owner 不设（makeProduction 无参）——否则 owner 旁路会盖掉全部判定
  ({ prodId } = await makeProduction());
  for (const u of [creatorId, zoneUserId, pocUserId, noneUserId, noViewUserId, wildUserId]) {
    await addProductionMember(prodId, u);
  }

  eventId = shortId();
  await createProductionEvent({
    id: eventId, productionId: prodId, title: "排练", eventType: "rehearsal",
    location: "排练厅", startTime: null, endTime: null, description: "", createdBy: creatorId,
  });
  reportId = shortId();
  await createEventReport({
    id: reportId, eventId, reportType: "rehearsal",
    title: "排练报告", body: "", createdBy: creatorId, parentWikiId: null,
  });

  const zoneDept = await createProductionDept({ productionId: prodId, name: `zone-${shortId()}` });
  const pocDept  = await createProductionDept({ productionId: prodId, name: `poc-${shortId()}` });
  const wildDept = await createProductionDept({ productionId: prodId, name: `wild-${shortId()}` });
  await setDeptMembers(zoneDept.id, prodId, [{ userId: zoneUserId, isPoc: false }]);
  await setDeptMembers(pocDept.id,  prodId, [{ userId: pocUserId,  isPoc: true  }]);
  await setDeptMembers(wildDept.id, prodId, [{ userId: wildUserId, isPoc: false }]);

  // zone dept：实例级区间键（六步链第 3 步的资格源）；wild dept：通配键
  await giveDeptZoneKey(zoneDept.id, `node:report/${reportId}@edit`);
  await giveDeptZoneKey(wildDept.id, "node:report/*@edit");
  // poc dept：归属（rdm）——manage 档只认管理部门的 POC
  await addResourceDeptManage({
    productionId: prodId, deptId: pocDept.id,
    resourceType: "report", resourceId: reportId, establishedBy: creatorId,
  });

  for (const u of [zoneUserId, pocUserId, noneUserId, wildUserId]) await giveEventDomainView(u);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [allUsers()]).catch(() => {});
});

// ── ① 路由层（bug 的实际所在：wiring）─────────────────────────────────────────

describe("POST …/reports/[reportId]/access", () => {
  it("未登录 → 401", async () => {
    const res = await POST(makeReq(null, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(401);
  });

  it("非本项目成员 → 403", async () => {
    const res = await POST(makeReq(outsiderId, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(403);
  });

  it("成员但无事件域 view → 403，且拦在域门（不是区间门）", async () => {
    const res = await POST(makeReq(noViewUserId, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(403);
    // 文案区分两道 403：域门 = 无权访问；区间门 = 不在免审批区间
    await expect(res.json()).resolves.toEqual({ error: "无权访问" });
  });

  it("未知 action / 非法 level → 400", async () => {
    expect((await POST(makeReq(zoneUserId, { action: "nope" }), routeCtx())).status).toBe(400);
    expect((await POST(makeReq(zoneUserId, { action: "self_confirm", level: "view" }), routeCtx())).status).toBe(400);
  });

  it("在 edit 区间内 → 200 且行真的落库（旧实现在这里 500）", async () => {
    expect(await activeReportRows(zoneUserId)).toEqual([]);

    const res = await POST(makeReq(zoneUserId, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // REPORT_LEVEL_ROW_SETS.edit 的五行（非线性：edit 档自带 meta/publication 的 view）
    expect(await activeReportRows(zoneUserId)).toEqual(
      ["*@edit", "meta@view", "notes@create", "notes@delete", "publication@view"],
    );
  });

  it("重复自确认幂等 → 仍 200，不重复发行", async () => {
    const before = await activeReportRows(zoneUserId);
    const res = await POST(makeReq(zoneUserId, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(200);
    expect(await activeReportRows(zoneUserId)).toEqual(before);
  });

  it("过了域门但不在区间 → 403（区间门）且不落任何行", async () => {
    const res = await POST(makeReq(noneUserId, { action: "self_confirm", level: "edit" }), routeCtx());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "不在免审批区间，无法自我确认" });
    expect(await activeReportRows(noneUserId)).toEqual([]);
  });

  it("有 edit 区间但无 manage 资格 → manage 档 403（档位不被 edit 蕴含）", async () => {
    const res = await POST(makeReq(wildUserId, { action: "self_confirm", level: "manage" }), routeCtx());
    expect(res.status).toBe(403);
  });

  it("管理部门的 POC → manage 档 200，拿到 grants@edit", async () => {
    const res = await POST(makeReq(pocUserId, { action: "self_confirm", level: "manage" }), routeCtx());
    expect(res.status).toBe(200);
    expect(await activeReportRows(pocUserId)).toContain("grants@edit");
  });
});

// ── ② 判定层 ─────────────────────────────────────────────────────────────────

describe("报告 edit/manage 档免审批区间", () => {
  it("dept 持实例区间键 → edit 档在区间内", async () => {
    expect(await checkNodeFreeApprovalZone(zoneUserId, prodId, "report", reportId, "edit")).toBe(true);
  });

  it("dept 区间键不给 manage 档（manage 只认管理部门的 POC）", async () => {
    expect(await checkNodeFreeApprovalZone(zoneUserId, prodId, "report", reportId, "manage")).toBe(false);
  });

  it("管理部门的 POC → manage 与 edit 两档都在区间内", async () => {
    expect(await checkNodeFreeApprovalZone(pocUserId, prodId, "report", reportId, "manage")).toBe(true);
    expect(await checkNodeFreeApprovalZone(pocUserId, prodId, "report", reportId, "edit")).toBe(true);
  });

  it("无区间键、非 POC → 两档都不在区间内（走申请流）", async () => {
    expect(await checkNodeFreeApprovalZone(noneUserId, prodId, "report", reportId, "edit")).toBe(false);
    expect(await checkNodeFreeApprovalZone(noneUserId, prodId, "report", reportId, "manage")).toBe(false);
  });

  it("通配区间键 node:report/*@edit 同样命中该实例", async () => {
    expect(await checkNodeFreeApprovalZone(wildUserId, prodId, "report", reportId, "edit")).toBe(true);
  });
});

// ── ③ 棘轮：源码不得再查询已 DROP 的列 ────────────────────────────────────────

/** PR #229 并表批 DROP 的列（判定机制已由区间行 / 声明表接管）。 */
const DROPPED_COLUMNS: readonly string[] = [
  "pd.permissions",
  "production_dept.permissions",
  "allowed_cue_types",
  "poc_extra_permissions",
  "poc_blocked_permissions",
];

function collectSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  for (const dir of ["app", "lib"]) walk(dir);
  return out;
}

describe("死列棘轮", () => {
  it("app/ 与 lib/ 不再引用已 DROP 的部门数组列", () => {
    const hits: string[] = [];
    for (const { path, text } of collectSources()) {
      for (const line of text.split("\n")) {
        // 注释里可以提这些名字（迁移记录、退役说明），只禁真正的查询
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const col of DROPPED_COLUMNS) {
          if (line.includes(col)) hits.push(`${path}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
