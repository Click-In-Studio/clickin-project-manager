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
    `SELECT resource_sub, permission_level FROM resource_grant
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
  it("SM gets details/call_sheet/tasks view + reports CRUD without publish", async () => {
    await setEventStageManagers(eventId, [{ userId: smId, name: "跟组舞监" }], prodId, ownerId);
    expect(await rowsFor(smId)).toEqual([
      "meta@view", "details@view", "call_sheet@view", "tasks@view",
      "reports@view", "reports@create", "reports@edit", "reports@delete",
    ].sort());
  });

  it("SM removal keeps grants", async () => {
    await setEventStageManagers(eventId, [], prodId, ownerId);
    expect((await rowsFor(smId)).length).toBe(8);
  });
});
