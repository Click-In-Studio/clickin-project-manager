import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEventReport, listProductionReports } from "@/lib/event-db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 业务规则：参加 event 的部门要在 report 发布前写 note，
// 因此部门参与者（event_participant.department_id 非空）可见 draft report。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let eventId: string;
let reportId: string;
let deptUser: string;    // 以部门身份参加 event
let plainUser: string;   // 无任何关系
let personUser: string;  // 个人参加（无部门）

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [deptUser, plainUser, personUser] = await Promise.all([newUser(), newUser(), newUser()]);

  eventId = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '测试', $3, 'published')`,
    [eventId, prodId, deptUser],
  );

  const deptId = `d${shortId()}`;
  await getPool().query(
    `INSERT INTO event_department (id, production_id, name) VALUES ($1, $2, '测试部门')`,
    [deptId, prodId],
  );
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name, department_id) VALUES ($1, $2, $3, '部门参与者', $4)`,
    [`ep${shortId()}`, eventId, deptUser, deptId],
  );
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name) VALUES ($1, $2, $3, '个人参与者')`,
    [`ep${shortId()}`, eventId, personUser],
  );

  reportId = `rp${shortId()}`;
  await createEventReport({
    id: reportId, eventId, reportType: "show",
    title: "draft 报告", body: "未发布内容", createdBy: deptUser,
  });
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("draft report visibility for dept participants", () => {
  it("dept participant sees the draft report in the production list", async () => {
    const reports = await listProductionReports(prodId, deptUser, false);
    expect(reports.map(r => r.id)).toContain(reportId);
    const entry = reports.find(r => r.id === reportId)!;
    expect(entry.publishedAt).toBeNull();
  });

  it("unrelated user does not see the draft report", async () => {
    const reports = await listProductionReports(prodId, plainUser, false);
    expect(reports.map(r => r.id)).not.toContain(reportId);
  });

  it("participant without department does not see the draft report", async () => {
    const reports = await listProductionReports(prodId, personUser, false);
    expect(reports.map(r => r.id)).not.toContain(reportId);
  });

  it("per-event reports@view grant reveals the draft (跟组舞监行集)", async () => {
    const smUser = await newUser();
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'event', $3, 'reports', 'view', 'auto')`,
      [prodId, smUser, eventId],
    );
    const reports = await listProductionReports(prodId, smUser, false);
    expect(reports.map(r => r.id)).toContain(reportId);
  });
});
