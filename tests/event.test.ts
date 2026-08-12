import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createProductionEvent, listProductionEvents, getProductionEvent,
  updateProductionEvent, deleteProductionEvent,
  createScheduleItem, listScheduleItems, updateScheduleItem, deleteScheduleItem,
  countPendingTasksForUser, countUnreadReportsForUser,
  listMyReports, listUnreadFollowedReports,
} from "@/lib/event-db";
import { getPool } from "@/lib/pg";
import { TEST_USER } from "./helpers";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// ── Local DB helpers (scoped to this file) ────────────────────────────────────

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}
async function makeEv(prodId: string, createdBy: string, opts?: { status?: string }): Promise<string> {
  const id = `ev${shortId()}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '测试', $3, $4)`,
    [id, prodId, createdBy, opts?.status ?? "draft"],
  );
  return id;
}
async function makeDept(prodId: string): Promise<string> {
  const id = `d${shortId()}`;
  await getPool().query(
    `INSERT INTO event_department (id, production_id, name) VALUES ($1, $2, '测试部门')`,
    [id, prodId],
  );
  return id;
}
async function makePocMember(deptId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO event_department_member (department_id, user_id, is_poc) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
    [deptId, userId],
  );
}
async function makeTechReq(eventId: string, deptId: string | null, status: string): Promise<string> {
  const id = `r${shortId()}`;
  await getPool().query(
    `INSERT INTO event_tech_req (id, event_id, department_id, title, status) VALUES ($1, $2, $3, '测试需求', $4)`,
    [id, eventId, deptId, status],
  );
  return id;
}
async function makeAssignee(reqId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO event_tech_assignee (req_id, user_id, name) VALUES ($1, $2, '测试') ON CONFLICT DO NOTHING`,
    [reqId, userId],
  );
}
async function makeReport(eventId: string, createdBy: string, opts?: { published?: boolean; mentions?: string[] }): Promise<string> {
  const id = `rp${shortId()}`;
  const publishedSql = opts?.published !== false ? "now()" : "NULL";
  const mentionsJson = JSON.stringify((opts?.mentions ?? []).map(uid => ({ userId: uid })));
  // 拆分模型：内容进 wiki 实体，边表挂 wiki_id
  await getPool().query(
    `WITH w AS (
       INSERT INTO wiki (production_id, title, mentions, created_by)
       SELECT pe.production_id, '测试报告', $4::jsonb, $3
       FROM production_event pe WHERE pe.id = $2
       RETURNING id
     )
     INSERT INTO event_report (id, event_id, wiki_id, published_at)
     SELECT $1, $2, w.id, ${publishedSql} FROM w`,
    [id, eventId, createdBy, mentionsJson],
  );
  return id;
}
async function makeParticipant(eventId: string, userId: string): Promise<void> {
  const id = `ep${shortId()}`;
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name) VALUES ($1, $2, $3, '测试') ON CONFLICT (event_id, user_id) DO NOTHING`,
    [id, eventId, userId],
  );
}
async function makeStageManager(eventId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO event_stage_manager (event_id, user_id, name) VALUES ($1, $2, '测试') ON CONFLICT DO NOTHING`,
    [eventId, userId],
  );
}

let prodId: string;
const EVENT_ID = `evt-${shortId()}`;
const ITEM_ID  = `item-${shortId()}`;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("event CRUD", () => {
  it("createProductionEvent creates an event", async () => {
    await createProductionEvent({
      id: EVENT_ID, productionId: prodId,
      title: "单元测试排练", eventType: "rehearsal",
      location: "排练室A", startTime: "2026-08-01T10:00:00Z",
      endTime: "2026-08-01T13:00:00Z", description: "",
      createdBy: TEST_USER,
    });
    const event = await getProductionEvent(EVENT_ID, prodId);
    expect(event).not.toBeNull();
    expect(event!.title).toBe("单元测试排练");
    expect(event!.location).toBe("排练室A");
  });

  it("listProductionEvents includes the created event", async () => {
    const events = await listProductionEvents(prodId);
    expect(events.some((e) => e.id === EVENT_ID)).toBe(true);
  });

  it("updateProductionEvent changes the title", async () => {
    await updateProductionEvent(EVENT_ID, prodId, { title: "单元测试排练（改名）" });
    const event = await getProductionEvent(EVENT_ID, prodId);
    expect(event!.title).toBe("单元测试排练（改名）");
  });

  it("getProductionEvent returns null for wrong production", async () => {
    expect(await getProductionEvent(EVENT_ID, "wrong-prod")).toBeNull();
  });
});

describe("schedule item CRUD", () => {
  it("createScheduleItem adds an item", async () => {
    await createScheduleItem({
      id: ITEM_ID, eventId: EVENT_ID,
      title: "热身活动", itemType: "custom",
      startTime: null, endTime: null, location: "",
      orderIndex: 0, targetSceneId: null, targetBlockId: null, notes: "",
    });
    const items = await listScheduleItems(EVENT_ID);
    expect(items.some((i) => i.id === ITEM_ID)).toBe(true);
  });

  it("updateScheduleItem changes the title", async () => {
    await updateScheduleItem(ITEM_ID, EVENT_ID, { title: "热身活动（已修改）" });
    const items = await listScheduleItems(EVENT_ID);
    expect(items.find((i) => i.id === ITEM_ID)!.title).toBe("热身活动（已修改）");
  });

  it("deleteScheduleItem removes the item", async () => {
    await deleteScheduleItem(ITEM_ID, EVENT_ID);
    const items = await listScheduleItems(EVENT_ID);
    expect(items.some((i) => i.id === ITEM_ID)).toBe(false);
  });

  it("deleteProductionEvent cascades", async () => {
    await deleteProductionEvent(EVENT_ID, prodId);
    expect(await getProductionEvent(EVENT_ID, prodId)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countPendingTasksForUser
// ─────────────────────────────────────────────────────────────────────────────

describe("countPendingTasksForUser", () => {
  let u: string;
  let p: string;
  let evId: string;
  let deptId: string;

  beforeAll(async () => {
    u = await newUser();
    ({ prodId: p } = await makeProduction());
    evId = await makeEv(p, TEST_USER);
    deptId = await makeDept(p);
    await makePocMember(deptId, u);
  });

  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    await cleanupProduction(p).catch(() => {});
  });

  it("counts pending req where user is POC", async () => {
    const before = await countPendingTasksForUser(u);
    await makeTechReq(evId, deptId, "pending");
    expect(await countPendingTasksForUser(u)).toBe(before + 1);
  });

  it("counts in_progress req where user is POC", async () => {
    const before = await countPendingTasksForUser(u);
    await makeTechReq(evId, deptId, "in_progress");
    expect(await countPendingTasksForUser(u)).toBe(before + 1);
  });

  it("counts awaiting req where user is POC", async () => {
    const before = await countPendingTasksForUser(u);
    await makeTechReq(evId, deptId, "awaiting");
    expect(await countPendingTasksForUser(u)).toBe(before + 1);
  });

  it("does not count done or cancelled reqs", async () => {
    const before = await countPendingTasksForUser(u);
    await makeTechReq(evId, deptId, "done");
    await makeTechReq(evId, deptId, "cancelled");
    expect(await countPendingTasksForUser(u)).toBe(before);
  });

  it("counts pending req where user is assignee (not POC)", async () => {
    const assignee = await newUser();
    try {
      const reqId = await makeTechReq(evId, deptId, "in_progress");
      await makeAssignee(reqId, assignee);
      const count = await countPendingTasksForUser(assignee);
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [assignee]).catch(() => {});
    }
  });

  it("productionId filter scopes to that production only", async () => {
    const { prodId: other } = await makeProduction();
    try {
      const scoped = await countPendingTasksForUser(u, p);
      const unrelated = await countPendingTasksForUser(u, other);
      expect(scoped).toBeGreaterThanOrEqual(1);
      expect(unrelated).toBe(0);
    } finally {
      await cleanupProduction(other).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countUnreadReportsForUser
// ─────────────────────────────────────────────────────────────────────────────

describe("countUnreadReportsForUser", () => {
  let u: string;

  beforeAll(async () => { u = await newUser(); });
  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
  });

  it("counts published report where user is participant", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, TEST_USER, { status: "published" });
      await makeParticipant(evId, u);
      const before = await countUnreadReportsForUser(u);
      await makeReport(evId, TEST_USER, { published: true });
      expect(await countUnreadReportsForUser(u)).toBe(before + 1);
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("counts draft report where user is creator and event is completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "completed" });
      const before = await countUnreadReportsForUser(u);
      await makeReport(evId, u, { published: false });
      expect(await countUnreadReportsForUser(u)).toBe(before + 1);
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("counts draft report where user is stage manager and event is completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, TEST_USER, { status: "completed" });
      await makeStageManager(evId, u);
      const before = await countUnreadReportsForUser(u);
      await makeReport(evId, TEST_USER, { published: false });
      expect(await countUnreadReportsForUser(u)).toBe(before + 1);
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("does not count draft report when event is not completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "draft" });
      const before = await countUnreadReportsForUser(u);
      await makeReport(evId, u, { published: false });
      expect(await countUnreadReportsForUser(u)).toBe(before);
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("productionId filter scopes to that production only", async () => {
    const { prodId: p } = await makeProduction();
    const { prodId: other } = await makeProduction();
    try {
      const evId = await makeEv(p, TEST_USER, { status: "published" });
      await makeParticipant(evId, u);
      await makeReport(evId, TEST_USER, { published: true });
      const scoped = await countUnreadReportsForUser(u, p);
      const unrelated = await countUnreadReportsForUser(u, other);
      expect(scoped).toBeGreaterThanOrEqual(1);
      expect(unrelated).toBe(0);
    } finally {
      await cleanupProduction(p).catch(() => {});
      await cleanupProduction(other).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listMyReports — draft report branch
// ─────────────────────────────────────────────────────────────────────────────

describe("listMyReports — draft reports", () => {
  let u: string;

  beforeAll(async () => { u = await newUser(); });
  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
  });

  it("includes draft report when user is creator and event is completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "completed" });
      const rptId = await makeReport(evId, u, { published: false });
      const reports = await listMyReports(u);
      const found = reports.find(r => r.reportId === rptId);
      expect(found).not.toBeUndefined();
      expect(found!.publishedAt).toBeNull();
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("excludes draft report when event is not completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "draft" });
      const rptId = await makeReport(evId, u, { published: false });
      const reports = await listMyReports(u);
      expect(reports.find(r => r.reportId === rptId)).toBeUndefined();
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("draft report has isRead = false (no read record exists)", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "completed" });
      const rptId = await makeReport(evId, u, { published: false });
      const reports = await listMyReports(u);
      const found = reports.find(r => r.reportId === rptId);
      expect(found!.isRead).toBe(false);
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listUnreadFollowedReports — draft and mentions branches
// ─────────────────────────────────────────────────────────────────────────────

describe("listUnreadFollowedReports — draft and mentions branches", () => {
  let u: string;

  beforeAll(async () => { u = await newUser(); });
  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
  });

  it("includes draft report for creator when event is completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "completed" });
      const rptId = await makeReport(evId, u, { published: false });
      const reports = await listUnreadFollowedReports(u);
      expect(reports.find(r => r.reportId === rptId)).not.toBeUndefined();
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("includes published report where user is mentioned", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, TEST_USER, { status: "published" });
      const rptId = await makeReport(evId, TEST_USER, { published: true, mentions: [u] });
      const reports = await listUnreadFollowedReports(u);
      expect(reports.find(r => r.reportId === rptId)).not.toBeUndefined();
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });

  it("excludes draft report when event is not completed", async () => {
    const { prodId: p } = await makeProduction();
    try {
      const evId = await makeEv(p, u, { status: "draft" });
      const rptId = await makeReport(evId, u, { published: false });
      const reports = await listUnreadFollowedReports(u);
      expect(reports.find(r => r.reportId === rptId)).toBeUndefined();
    } finally {
      await cleanupProduction(p).catch(() => {});
    }
  });
});
