/**
 * event / report 删除门改查 delete 动词（#236 张力 4a + 4c，2026-08-18）。
 *
 * 事故：全库 19 条带门的 DELETE 路由里，**只有 event / report 两条**查的是
 * `grants@edit`（授权权），其余 17 条都查 delete 动词。后果两头错位：
 *   - `event/<id>/*@delete` 与 `report/<id>/*@delete` 是**死动词**——词汇表里有、
 *     行集里没有、路由不查；
 *   - 删除权被绑在授权权上，是一条**违反 M-2 的隐式蕴含**（能转授 ⟹ 能删）：
 *     创建者因 C-2/C-3 发的 grants@edit 而能删（直觉以为不能），而设计上想让他删的
 *     人（制作人 / 舞监）反倒拿不到。
 *
 * 修法必须**先补持钥人再改门**，否则中间态是除 owner / 制作人外谁也删不了报告：
 *   1. add-report-delete-to-stage-managers.sql —— 舞监 role 补 node:report/*@delete
 *      （grant_template 管新演出 + production_role_permission 管存量演出）
 *   2. 两条门改查 `*@delete`
 *   3. 创建者要不要有，交给策略键 event.creator:*@delete / report.creator:*@delete
 *      （默认关；#236 基建已就位，松的剧组打开即可）
 *
 * 三层：① 默认下创建者删不掉（回归）② 打开策略键后创建者能删 ③ 持钥人真的存在
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createProductionEvent, createEventReport, getProductionEvent } from "@/lib/event-db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { hasGrant } from "@/lib/grant-check";
import { setPolicies } from "@/lib/policy-db";
import { POLICY_ON, POLICY_OFF } from "@/lib/policy-keys";
import { getPool } from "@/lib/pg";
import { DELETE as deleteEvent } from "@/app/api/production/[id]/events/[eventId]/route";
import { DELETE as deleteReport } from "@/app/api/production/[id]/events/[eventId]/reports/[reportId]/route";
import { resolveTemplate } from "@/lib/production-template";

let prodId: string;
let ownerId: string;
let creatorId: string;   // 建 event / report 的普通成员
let holderId: string;    // 直接持 report/<id>/*@delete 的人（模拟舞监拿到行之后）

async function makeUser(tag: string): Promise<string> {
  return (await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false)).userId;
}

function req(userId: string): NextRequest {
  const r = new NextRequest("http://localhost/api", { method: "DELETE" });
  r.cookies.set(SESSION_COOKIE, createSession({
    userId, name: "测试", avatarUrl: null, isAdmin: false,
  }));
  return r;
}

async function makeReport(eventId: string): Promise<{ id: string }> {
  return createEventReport({
    id: `rpt_${shortId()}`, eventId, reportType: "show",
    title: `报告${shortId()}`, body: "", createdBy: creatorId,
  });
}

async function makeEvent(): Promise<string> {
  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: `删除门${shortId()}`,
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: creatorId,
  });
  return ev.id;
}

beforeAll(async () => {
  ownerId = await makeUser("del-owner");
  creatorId = await makeUser("del-creator");
  holderId = await makeUser("del-holder");
  ({ prodId } = await makeProduction(ownerId));
  for (const u of [creatorId, holderId]) await addProductionMember(prodId, u);
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

// ── ① 默认：创建者持 grants@edit 但删不掉 ────────────────────────────────────

describe("event DELETE 改查 delete 动词", () => {
  it("创建者持 grants@edit 却**不**持 *@delete（策略键默认关）", async () => {
    const eventId = await makeEvent();
    expect(await hasGrant(creatorId, prodId, "event", eventId, "grants", "edit")).toBe(true);
    expect(await hasGrant(creatorId, prodId, "event", eventId, "*", "delete")).toBe(false);
  });

  it("创建者删自己创建的事件 → 403（修前 200，因为门查的是 grants@edit）", async () => {
    const eventId = await makeEvent();
    const res = await deleteEvent(req(creatorId), {
      params: Promise.resolve({ id: prodId, eventId }),
    });
    expect(res.status).toBe(403);
    expect(await getProductionEvent(eventId, prodId)).not.toBeNull();
  });

  it("打开 event.creator:*@delete ⇒ 此后新建的事件创建者能删", async () => {
    await setPolicies(prodId, { "event.creator:*@delete": POLICY_ON }, ownerId);
    const eventId = await makeEvent();
    expect(await hasGrant(creatorId, prodId, "event", eventId, "*", "delete")).toBe(true);
    const res = await deleteEvent(req(creatorId), {
      params: Promise.resolve({ id: prodId, eventId }),
    });
    expect(res.status).toBe(200);
    expect(await getProductionEvent(eventId, prodId)).toBeNull();
    await setPolicies(prodId, { "event.creator:*@delete": POLICY_OFF }, ownerId);
  });
});

describe("report DELETE 改查 delete 动词", () => {
  it("创建者默认删不掉自己建的报告 → 403", async () => {
    const eventId = await makeEvent();
    const report = await makeReport(eventId);
    expect(await hasGrant(creatorId, prodId, "report", report.id, "grants", "edit")).toBe(true);
    expect(await hasGrant(creatorId, prodId, "report", report.id, "*", "delete")).toBe(false);
    const res = await deleteReport(req(creatorId), {
      params: Promise.resolve({ id: prodId, eventId, reportId: report.id }),
    });
    expect(res.status).toBe(403);
  });

  it("持 report/<id>/*@delete 的人（舞监拿到行之后）→ 200", async () => {
    const eventId = await makeEvent();
    const report = await makeReport(eventId);
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub,
          permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'report', $3, '*', 'delete', 'direct', $2)
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false DO NOTHING`,
      [prodId, holderId, report.id],
    );
    const res = await deleteReport(req(holderId), {
      params: Promise.resolve({ id: prodId, eventId, reportId: report.id }),
    });
    expect(res.status).toBe(200);
  });

  it("打开 report.creator:*@delete ⇒ 此后新建的报告创建者能撤边", async () => {
    await setPolicies(prodId, { "report.creator:*@delete": POLICY_ON }, ownerId);
    const eventId = await makeEvent();
    const report = await makeReport(eventId);
    expect(await hasGrant(creatorId, prodId, "report", report.id, "*", "delete")).toBe(true);
    const res = await deleteReport(req(creatorId), {
      params: Promise.resolve({ id: prodId, eventId, reportId: report.id }),
    });
    expect(res.status).toBe(200);
    await setPolicies(prodId, { "report.creator:*@delete": POLICY_OFF }, ownerId);
  });
});

// ── ③ 持钥人真的存在（张力 4c）────────────────────────────────────────────────

describe("持钥人在位", () => {
  it("戏剧类模版：舞监两个 role 都持 node:report/*@delete", async () => {
    // 模板源已是项目模版常量（#163）。「助理舞台监督」不再出现——
    // migrate-assistant-roles.sql 已把复合职位拆成 base role + tag，它不在角色名单里。
    const { permissions } = resolveTemplate(null).roles;
    const holders = Object.entries(permissions)
      .filter(([, keys]) => keys.includes("node:report/*@delete"))
      .map(([role]) => role);
    expect(holders.sort()).toEqual(["后台舞台监督", "舞台监督"].sort());
  });

  it("event 的默认持钥人＝制作人，靠 node:*/*@* 全集覆盖（无需单独补行）", () => {
    expect(resolveTemplate(null).roles.permissions["制作人"]).toContain("node:*/*@*");
  });

  it("棘轮：删**资源本体**的门不得拿 grants@edit 当删除权", async () => {
    // 有意的例外：删的不是资源本体，而是治理面的**声明行**——那种场景下
    // 「授权面写权」本来就是正确的门，不是把授权权当删除权用。
    const GOVERNANCE_DELETE_ROUTES = new Set([
      // dept_cue_list_template 声明行（#227）：删的是「某部门可建某类 cue 表」这条
      // 声明，本身就是授权面动作，门为 org_dept/*/grants@edit 正确。
      "app/api/production/[id]/cue-templates/route.ts",
    ]);
    const { readdirSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name !== "route.ts") continue;
        const text = readFileSync(full, "utf8");
        const i = text.indexOf("export async function DELETE");
        if (i < 0) continue;
        let body = text.slice(i);
        const next = body.indexOf("export async function", 21);
        if (next > 0) body = body.slice(0, next);
        const code = body.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
        // 门里出现 grants@edit 且**不**出现任何 delete 动词 ⇒ 拿授权权当删除权
        const rel = full.replace(process.cwd() + "/", "");
        if (GOVERNANCE_DELETE_ROUTES.has(rel)) continue;
        if (/"grants"\s*,\s*"edit"/.test(code) && !/"delete"/.test(code)) offenders.push(rel);
      }
    };
    walk(join(process.cwd(), "app", "api"));
    expect(offenders).toEqual([]);
  });
});
