import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createProductionEvent, setEventStageManagers, setEventParticipants } from "@/lib/event-db";
import { getPool } from "@/lib/pg";

// 批B 自动授权规范（用户定义）：
//   - calltime/参与者（含部门展开成员）→ meta+details view（不含 ③④⑤ 层）
//   - 跟组舞监 → details/call_sheet/tasks 可见 + 本 event 报告 CRUD（无需发布）
//   - 移除参与者/舞监：只删名单，不撤行

let prodId: string;
let ownerId: string;
let smId: string;
let calledId: string;
let eventId: string;

async function rowsFor(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
    `SELECT resource_sub, permission_level FROM production_member_grant
     WHERE production_id = $1 AND user_id = $2
       AND resource_type = 'event' AND resource_id = $3 AND NOT is_revoked`,
    [prodId, userId, eventId],
  );
  return rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `授权丙${shortId()}`, null, false)).userId;
  smId = (await upsertFeishuUser(`test-open-${shortId()}`, `跟组舞监${shortId()}`, null, false)).userId;
  calledId = (await upsertFeishuUser(`test-open-${shortId()}`, `被叫者${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  await addProductionMember(prodId, smId);
  await addProductionMember(prodId, calledId);

  const ev = await createProductionEvent({
    id: `ev_${shortId()}`, productionId: prodId, title: "自动授权检验",
    eventType: "rehearsal", location: "", startTime: null, endTime: null,
    description: "", createdBy: ownerId,
  });
  eventId = ev.id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("参与者自动授权（五层第②层，不放大）", () => {
  it("assigned rows are exactly meta+details view", async () => {
    await setEventParticipants(
      eventId,
      [{ userId: calledId, name: "被叫者", departmentId: null, role: "participant" }],
      prodId, ownerId,
    );
    expect(await rowsFor(calledId)).toEqual(["details@view", "meta@view"].sort());
  });

  it("removal keeps grants (行是独立事实)", async () => {
    await setEventParticipants(eventId, [], prodId, ownerId);
    expect(await rowsFor(calledId)).toEqual(["details@view", "meta@view"].sort());
  });
});

describe("跟组舞监自动行集", () => {
  // 十二行集（2026-08-18 由十行扩充：加 assignees c/d，见 producer-wildcard.test.ts
  // 里那条修订说明——原「排 call 不动名单」是当时没有开关的产物）。
  // 仍不含 publication@create：发布归舞监 role / 报告面，不随跟组身份自动来。
  it("SM 十二行集：details/call_sheet/tasks view + reports CRUD + 名单，无 publish", async () => {
    await setEventStageManagers(eventId, [{ userId: smId, name: "跟组舞监" }], prodId, ownerId);
    expect(await rowsFor(smId)).toEqual([
      "meta@view", "details@view", "publication@view", "call_sheet@edit",
      "call_sheet@view", "tasks@view",
      "reports@view", "reports@create", "reports@edit", "reports@delete",
      "assignees@create", "assignees@delete",
    ].sort());
  });

  it("SM removal keeps grants", async () => {
    await setEventStageManagers(eventId, [], prodId, ownerId);
    expect((await rowsFor(smId)).length).toBe(12);
  });
});

// ── 报告的结构性持钥方＝该 event 的跟组舞监（2026-08-18）────────────────────
//
// 此前只靠舞监 role 模版的 node:report/*@delete，而 role 不保证存在
// （ROLE_NAMES 是默认模版名单不是白名单，剧组可删可改名）。跟组舞监是 per-event
// 结构数据（event_stage_manager），指派了就存在，才立得住。
//
// 两个方向都要发，合起来与「先建报告还是先设舞监」的顺序无关：
//   C-3 建报告时 → 发给当时的跟组舞监
//   R-3 设舞监时 → 补发该 event 已有的报告

describe("跟组舞监的报告持钥", () => {
  it("先设舞监、后建报告 → C-3 发行", async () => {
    const { createEventReport } = await import("@/lib/event-db");
    const { hasGrant } = await import("@/lib/grant-check");
    await setEventStageManagers(eventId, [{ userId: smId, name: "跟组舞监" }], prodId, ownerId);
    const r = await createEventReport({
      id: `rpt_${Date.now().toString(36)}`, eventId, reportType: "show",
      title: "C3方向", body: "", createdBy: ownerId,
    });
    for (const [sub, verb] of [["publication", "create"], ["publication", "edit"],
                               ["publication", "delete"], ["*", "delete"]] as const) {
      expect(await hasGrant(smId, prodId, "report", r.id, sub, verb),
        `缺 ${sub}@${verb}`).toBe(true);
    }
  });

  it("先建报告、后设舞监 → R-3 补发", async () => {
    const { createEventReport } = await import("@/lib/event-db");
    const { hasGrant } = await import("@/lib/grant-check");
    const { getPool } = await import("@/lib/pg");
    const late = (await getPool().query<{ id: string }>(
      "INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    const r = await createEventReport({
      id: `rpt_${Date.now().toString(36)}b`, eventId, reportType: "show",
      title: "R3方向", body: "", createdBy: ownerId,
    });
    expect(await hasGrant(late, prodId, "report", r.id, "*", "delete")).toBe(false);
    await setEventStageManagers(eventId, [{ userId: late, name: "后来的舞监" }], prodId, ownerId);
    expect(await hasGrant(late, prodId, "report", r.id, "*", "delete")).toBe(true);
  });
});
