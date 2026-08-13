import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setDepartmentMembers, setEventParticipants, writeTaskDeptEventVisibility,
  createEventReport, createReportNote,
} from "@/lib/event-db";
import { canWriteNote, canEditNote } from "@/lib/event-permissions";
import type { PermissionContext } from "@/lib/permissions";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 批C C3：notes 权限面（dept 锚 + 行动触发自动授权）
// dept/<D>/notes@create|edit|delete 随 POC 任期发/收；
// dept 加入 event → POC 发 event/<id>/reports@view（draft 可见）；
// created_via 通道：POC 的 ud 只覆盖本部门通道提出的 note。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

function ctxOf(userId: string): PermissionContext {
  return {
    userId, isAdmin: false, isOwner: false,
    memberPermissions: new Set(), overrides: new Map(),
    deptIds: [], pocDeptIds: [], deptFreeApprovalZone: new Set(),
    activeGrants: new Set(),
  };
}

async function grantRows(userId: string, deptId: string): Promise<{ verb: string; revoked: boolean }[]> {
  const res = await getPool().query<{ permission_level: string; is_revoked: boolean }>(
    `SELECT permission_level, is_revoked FROM production_member_grant
     WHERE user_id = $1 AND resource_type = 'dept' AND resource_id = $2 AND resource_sub = 'notes'
     ORDER BY permission_level`,
    [userId, deptId],
  );
  return res.rows.map(r => ({ verb: r.permission_level, revoked: r.is_revoked }));
}

let prodId: string;
let eventId: string;
let deptId: string;
let poc: string;
let director: string;   // dept/*/notes@create 通配
let outsider: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [poc, director, outsider] = await Promise.all([newUser(), newUser(), newUser()]);

  deptId = `d${shortId()}`;
  await getPool().query(
    `INSERT INTO event_department (id, production_id, name) VALUES ($1, $2, '测试部门')`,
    [deptId, prodId],
  );

  eventId = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '测试', $3, 'published')`,
    [eventId, prodId, poc],
  );

  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'dept', '*', 'notes', 'create', 'auto')`,
    [prodId, director],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM production_event WHERE id = $1", [eventId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("POC term lifecycle → dept notes rows", () => {
  it("promotion writes create/edit/delete rows; demotion revokes them", async () => {
    await setDepartmentMembers(deptId, [{ userId: poc, isMember: true, isPoc: true }]);
    const rows = await grantRows(poc, deptId);
    expect(rows.filter(r => !r.revoked).map(r => r.verb).sort()).toEqual(["create", "delete", "edit"]);

    await setDepartmentMembers(deptId, [{ userId: poc, isMember: true, isPoc: false }]);
    const after = await grantRows(poc, deptId);
    expect(after.filter(r => !r.revoked)).toHaveLength(0);

    // 复任发新行
    await setDepartmentMembers(deptId, [{ userId: poc, isMember: true, isPoc: true }]);
    const again = await grantRows(poc, deptId);
    expect(again.filter(r => !r.revoked).map(r => r.verb).sort()).toEqual(["create", "delete", "edit"]);
  });
});

describe("canWriteNote channels", () => {
  it("POC not in the event → 'dept' (本人无需在场)", async () => {
    expect(await canWriteNote(ctxOf(poc), prodId, eventId, deptId, [])).toBe("dept");
  });

  it("director wildcard row → 'wildcard'", async () => {
    expect(await canWriteNote(ctxOf(director), prodId, eventId, deptId, [])).toBe("wildcard");
  });

  it("dept participant context → 'dept' (成员通道保留)", async () => {
    const member = await newUser();
    expect(await canWriteNote(ctxOf(member), prodId, eventId, deptId, [deptId])).toBe("dept");
  });

  it("participant of another dept cannot write for this dept", async () => {
    const member = await newUser();
    expect(await canWriteNote(ctxOf(member), prodId, eventId, deptId, [`d${shortId()}`])).toBeNull();
  });

  it("unrelated user → null", async () => {
    expect(await canWriteNote(ctxOf(outsider), prodId, eventId, deptId, [])).toBeNull();
  });
});

describe("canEditNote created_via filter", () => {
  let reportId: string;

  beforeAll(async () => {
    reportId = `rp${shortId()}`;
    await createEventReport({
      id: reportId, eventId, reportType: "show",
      title: "报告", body: "内容", createdBy: poc,
    });
  });

  it("POC can delete a dept-channel note, not a wildcard-channel note", async () => {
    const deptNote = await createReportNote({
      id: `n${shortId()}`, reportId, departmentId: deptId,
      content: "本部门 note", authorUserId: poc, authorName: "POC",
      createdVia: "dept",
    });
    const directorNote = await createReportNote({
      id: `n${shortId()}`, reportId, departmentId: deptId,
      content: "导演 note", authorUserId: director, authorName: "导演",
      createdVia: "wildcard",
    });
    expect(deptNote.createdVia).toBe("dept");
    expect(directorNote.createdVia).toBe("wildcard");

    // 另一个 POC（非作者、不在 event）删本部门通道 note：可以
    const poc2 = await newUser();
    await setDepartmentMembers(deptId, [
      { userId: poc, isMember: true, isPoc: true },
      { userId: poc2, isMember: true, isPoc: true },
    ]);
    expect(await canEditNote(ctxOf(poc2), prodId, eventId, deptNote, [], "delete")).toBe(true);
    // 导演通道提出的：POC 不可删
    expect(await canEditNote(ctxOf(poc2), prodId, eventId, directorNote, [], "delete")).toBe(false);
    // 无关人两者皆不可
    expect(await canEditNote(ctxOf(outsider), prodId, eventId, deptNote, [], "delete")).toBe(false);
  });
});

describe("dept joins event → POC gets event reports@view", () => {
  async function hasReportsView(userId: string, evId: string): Promise<boolean> {
    const res = await getPool().query(
      `SELECT 1 FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'event' AND resource_id = $2
         AND resource_sub = 'reports' AND permission_level = 'view' AND NOT is_revoked`,
      [userId, evId],
    );
    return res.rows.length > 0;
  }

  it("via schedule participants (departmentId 非空)", async () => {
    const member = await newUser();
    const ev2 = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '测试2', $3, 'draft')`,
      [ev2, prodId, poc],
    );
    await setEventParticipants(ev2, [
      { userId: member, name: "成员", departmentId: deptId, role: "participant" },
    ], prodId, poc);
    expect(await hasReportsView(poc, ev2)).toBe(true);
    // 部门普通成员不拿 reports@view（只有 meta+details assigned 行）
    expect(await hasReportsView(member, ev2)).toBe(false);
    await getPool().query("DELETE FROM production_event WHERE id = $1", [ev2]);
  });

  it("via task dept visibility rows", async () => {
    const ev3 = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '测试3', $3, 'draft')`,
      [ev3, prodId, poc],
    );
    await writeTaskDeptEventVisibility(ev3, deptId, prodId, poc);
    expect(await hasReportsView(poc, ev3)).toBe(true);
    await getPool().query("DELETE FROM production_event WHERE id = $1", [ev3]);
  });
});
