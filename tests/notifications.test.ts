/**
 * Notification system tests — inbox DB layer + API routes.
 *
 * Covers:
 *  - createUserNotification / batchCreateUserNotifications
 *  - countUnreadNotifications
 *  - listUserNotifications (filter variants)
 *  - getUserNotification (ownership)
 *  - markNotificationRead / markAllNotificationsRead
 *  - markNotificationActed
 *  - expireNotificationsByEntity
 *  - rsvpCallTime
 *  - GET/PATCH /api/my/notifications — auth + happy path
 *  - GET /api/my/notifications/unread-count
 *  - POST /api/my/notifications/[id]/act — auth + happy path + security
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { TEST_USER } from "./helpers";
import { makeProduction, cleanupProduction } from "./factories";
import {
  createUserNotification,
  batchCreateUserNotifications,
  countUnreadNotifications,
  listUserNotifications,
  getUserNotification,
  markNotificationRead,
  markAllNotificationsRead,
  markNotificationActed,
  expireNotificationsByEntity,
  rsvpCallTime,
} from "@/lib/inbox-db";

// ── Route handlers ────────────────────────────────────────────────────────────

import { GET as listHandler, PATCH as markReadHandler } from "@/app/api/my/notifications/route";
import { GET as countHandler } from "@/app/api/my/notifications/unread-count/route";
import { POST as actHandler } from "@/app/api/my/notifications/[id]/act/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function session(userId = TEST_USER, isAdmin = false) {
  return createSession({ userId, name: "测试用户", avatarUrl: null, isAdmin });
}

function req(url: string, opts: { session?: string; method?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

async function createTestUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO app_user DEFAULT VALUES RETURNING id`,
  );
  return res.rows[0].id;
}

async function makeCallTime(
  eventId: string,
  userId: string,
  opts?: { id?: string },
): Promise<string> {
  const id = opts?.id ?? `ct${Math.random().toString(36).slice(2, 9)}`;
  await getPool().query(
    `INSERT INTO event_call_time (id, event_id, user_id, name, call_at)
     VALUES ($1, $2, $3, '测试', NOW() + INTERVAL '1 hour')`,
    [id, eventId, userId],
  );
  return id;
}

async function makeEvent(prodId: string, createdBy: string): Promise<string> {
  const id = `ev${Math.random().toString(36).slice(2, 9)}`;
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by)
     VALUES ($1, $2, '测试活动', $3)`,
    [id, prodId, createdBy],
  );
  return id;
}

// ── Shared test data ──────────────────────────────────────────────────────────

let prodId: string;
let otherUserId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  otherUserId = await createTestUser();
});

afterAll(async () => {
  // user_notification rows cascade-delete from app_user; clean up other user.
  await getPool().query("DELETE FROM app_user WHERE id = $1", [otherUserId]).catch(() => {});
  // production_event rows cascade from production.
  await cleanupProduction(prodId).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — createUserNotification
// ─────────────────────────────────────────────────────────────────────────────

describe("createUserNotification", () => {
  it("inserts a row and returns the notification", async () => {
    const n = await createUserNotification({
      userId: TEST_USER,
      productionId: prodId,
      kind: "test_kind",
      entityType: "test_entity",
      entityId: "eid-1",
      title: "测试通知",
      body: "这是一条测试",
      viewHref: "/my/notifications",
      actionRequired: false,
    });

    expect(n.id).toMatch(/^un/);
    expect(n.userId).toBe(TEST_USER);
    expect(n.kind).toBe("test_kind");
    expect(n.title).toBe("测试通知");
    expect(n.readAt).toBeNull();
    expect(n.actedAt).toBeNull();
    expect(n.expiredAt).toBeNull();
    expect(n.actions).toEqual([]);
  });

  it("stores actions JSONB correctly", async () => {
    const n = await createUserNotification({
      userId: TEST_USER,
      productionId: null,
      kind: "call_time",
      entityType: "call_time",
      entityId: "eid-action",
      title: "请确认 Call Time",
      actionRequired: true,
      actions: [
        {
          id: "confirm",
          presentation: "primary_button",
          label: "确认",
          effects: [{ type: "set_field", entityType: "call_time", entityId: "eid-action", field: "confirmed_at" }],
        },
      ],
    });

    expect(n.actionRequired).toBe(true);
    expect(n.actions).toHaveLength(1);
    expect(n.actions[0].id).toBe("confirm");
    expect(n.actions[0].effects[0].type).toBe("set_field");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — batchCreateUserNotifications
// ─────────────────────────────────────────────────────────────────────────────

describe("batchCreateUserNotifications", () => {
  it("creates one row per recipient", async () => {
    const pool = getPool();
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM user_notification WHERE user_id = $1 AND entity_id = 'batch-test-1'`,
      [TEST_USER],
    );

    await batchCreateUserNotifications([TEST_USER, otherUserId], {
      productionId: prodId,
      kind: "test_batch",
      entityType: "test_entity",
      entityId: "batch-test-1",
      title: "批量通知",
    });

    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM user_notification WHERE entity_id = 'batch-test-1'`,
    );
    // Two users received the notification.
    expect(parseInt(after.rows[0].count) - parseInt(before.rows[0].count)).toBe(2);
  });

  it("is a no-op for empty recipients", async () => {
    // Should not throw.
    await expect(
      batchCreateUserNotifications([], { kind: "test", entityType: "x", entityId: "y", title: "z" }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — countUnreadNotifications
// ─────────────────────────────────────────────────────────────────────────────

describe("countUnreadNotifications", () => {
  it("increments when a new notification is created", async () => {
    const u = await createTestUser();
    try {
      const before = await countUnreadNotifications(u);
      await createUserNotification({
        userId: u, kind: "test", entityType: "t", entityId: "e1", title: "新通知",
      });
      const after = await countUnreadNotifications(u);
      expect(after).toBe(before + 1);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    }
  });

  it("does not count notifications with read_at set", async () => {
    const u = await createTestUser();
    try {
      const n = await createUserNotification({
        userId: u, kind: "test", entityType: "t", entityId: "e2", title: "已读",
      });
      await markNotificationRead(n.id, u);
      const count = await countUnreadNotifications(u);
      expect(count).toBe(0);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — listUserNotifications
// ─────────────────────────────────────────────────────────────────────────────

describe("listUserNotifications", () => {
  let u: string;

  beforeAll(async () => {
    u = await createTestUser();
    // Create: 1 unread info, 1 unread action (pending), 1 acted
    await createUserNotification({
      userId: u, kind: "info", entityType: "t", entityId: "lst-info", title: "告知",
      actionRequired: false,
    });
    const acted = await createUserNotification({
      userId: u, kind: "call_time", entityType: "t", entityId: "lst-action", title: "待确认",
      actionRequired: true,
      actions: [{ id: "a1", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    await markNotificationActed(acted.id, u, "a1");
  });

  afterAll(async () => {
    await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
  });

  it("filter=all returns all notifications for user", async () => {
    const items = await listUserNotifications(u, { filter: "all" });
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((n) => n.userId === u)).toBe(true);
  });

  it("filter=pending returns only action_required + not acted", async () => {
    const items = await listUserNotifications(u, { filter: "pending" });
    expect(items.every((n) => n.actionRequired && !n.actedAt)).toBe(true);
  });

  it("filter=read returns only read notifications", async () => {
    // Mark the info notification read first.
    const all = await listUserNotifications(u, { filter: "all" });
    const info = all.find((n) => n.entityId === "lst-info");
    if (info) await markNotificationRead(info.id, u);

    const items = await listUserNotifications(u, { filter: "read" });
    expect(items.every((n) => !!n.readAt)).toBe(true);
  });

  it("respects limit", async () => {
    const items = await listUserNotifications(u, { filter: "all", limit: 1 });
    expect(items.length).toBeLessThanOrEqual(1);
  });

  it("does not return other users' notifications", async () => {
    const items = await listUserNotifications(u, { filter: "all" });
    expect(items.every((n) => n.userId === u)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — getUserNotification (ownership)
// ─────────────────────────────────────────────────────────────────────────────

describe("getUserNotification — ownership", () => {
  it("returns notification when userId matches", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "own-1", title: "自己的",
    });
    const fetched = await getUserNotification(n.id, TEST_USER);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(n.id);
  });

  it("returns null when userId does not match (ownership check)", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "own-2", title: "别人的",
    });
    const fetched = await getUserNotification(n.id, otherUserId);
    expect(fetched).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — markNotificationRead
// ─────────────────────────────────────────────────────────────────────────────

describe("markNotificationRead", () => {
  it("sets read_at on the target notification", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "read-1", title: "待读",
    });
    expect(n.readAt).toBeNull();

    await markNotificationRead(n.id, TEST_USER);
    const updated = await getUserNotification(n.id, TEST_USER);
    expect(updated!.readAt).not.toBeNull();
  });

  it("is idempotent — calling twice does not error", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "read-2", title: "待读2",
    });
    await markNotificationRead(n.id, TEST_USER);
    await expect(markNotificationRead(n.id, TEST_USER)).resolves.toBeUndefined();
  });

  it("does not mark another user's notification", async () => {
    const n = await createUserNotification({
      userId: otherUserId, kind: "test", entityType: "t", entityId: "read-3", title: "他人的",
    });
    await markNotificationRead(n.id, TEST_USER); // wrong userId
    const stillUnread = await getUserNotification(n.id, otherUserId);
    expect(stillUnread!.readAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — markAllNotificationsRead
// ─────────────────────────────────────────────────────────────────────────────

describe("markAllNotificationsRead", () => {
  it("marks all unread notifications for the user", async () => {
    const u = await createTestUser();
    try {
      await createUserNotification({ userId: u, kind: "t", entityType: "t", entityId: "ar1", title: "1" });
      await createUserNotification({ userId: u, kind: "t", entityType: "t", entityId: "ar2", title: "2" });

      await markAllNotificationsRead(u);

      const items = await listUserNotifications(u, { filter: "all" });
      expect(items.every((n) => !!n.readAt)).toBe(true);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    }
  });

  it("optionally filters by productionId", async () => {
    const u = await createTestUser();
    try {
      await createUserNotification({ userId: u, productionId: prodId, kind: "t", entityType: "t", entityId: "arp1", title: "prod" });
      await createUserNotification({ userId: u, productionId: null, kind: "t", entityType: "t", entityId: "arp2", title: "global" });

      await markAllNotificationsRead(u, prodId);

      const all = await listUserNotifications(u, { filter: "all" });
      const prodNotif = all.find((n) => n.entityId === "arp1");
      const globalNotif = all.find((n) => n.entityId === "arp2");
      expect(prodNotif?.readAt).not.toBeNull();
      expect(globalNotif?.readAt).toBeNull(); // not touched
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — markNotificationActed
// ─────────────────────────────────────────────────────────────────────────────

describe("markNotificationActed", () => {
  it("sets acted_at and read_at, records action_result", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "t", entityId: "act-1", title: "确认",
      actionRequired: true,
      actions: [{ id: "confirm", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });

    await markNotificationActed(n.id, TEST_USER, "confirm");
    const updated = await getUserNotification(n.id, TEST_USER);

    expect(updated!.actedAt).not.toBeNull();
    expect(updated!.readAt).not.toBeNull();
    const result = updated!.actionResult as { action_id: string };
    expect(result?.action_id).toBe("confirm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — expireNotificationsByEntity
// ─────────────────────────────────────────────────────────────────────────────

describe("expireNotificationsByEntity", () => {
  it("sets expired_at on matching unacted notifications", async () => {
    const n1 = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "call_time", entityId: "exp-eid-1",
      title: "Call 通知 (将被覆盖)", actionRequired: true,
      actions: [{ id: "confirm", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    const n2 = await createUserNotification({
      userId: otherUserId, kind: "call_time", entityType: "call_time", entityId: "exp-eid-1",
      title: "另一用户的 Call 通知", actionRequired: true,
      actions: [{ id: "confirm", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });

    await expireNotificationsByEntity("call_time", "exp-eid-1");

    const [r1, r2] = await Promise.all([
      getUserNotification(n1.id, TEST_USER),
      getUserNotification(n2.id, otherUserId),
    ]);
    expect(r1!.expiredAt).not.toBeNull();
    expect(r2!.expiredAt).not.toBeNull();
  });

  it("scoped to userId when provided — only that user's notifications expire", async () => {
    const n1 = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "call_time", entityId: "exp-eid-2",
      title: "主用户 Call", actionRequired: true,
      actions: [{ id: "c", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    const n2 = await createUserNotification({
      userId: otherUserId, kind: "call_time", entityType: "call_time", entityId: "exp-eid-2",
      title: "他人 Call", actionRequired: true,
      actions: [{ id: "c", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });

    // Expire only for TEST_USER.
    await expireNotificationsByEntity("call_time", "exp-eid-2", TEST_USER);

    const [r1, r2] = await Promise.all([
      getUserNotification(n1.id, TEST_USER),
      getUserNotification(n2.id, otherUserId),
    ]);
    expect(r1!.expiredAt).not.toBeNull();
    expect(r2!.expiredAt).toBeNull(); // other user's should be untouched
  });

  it("does not expire already-acted notifications", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "call_time", entityId: "exp-eid-3",
      title: "已操作", actionRequired: true,
      actions: [{ id: "c", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    await markNotificationActed(n.id, TEST_USER, "c");
    await expireNotificationsByEntity("call_time", "exp-eid-3");

    const updated = await getUserNotification(n.id, TEST_USER);
    expect(updated!.expiredAt).toBeNull(); // acted rows are skipped
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB layer — rsvpCallTime
// ─────────────────────────────────────────────────────────────────────────────

describe("rsvpCallTime", () => {
  let eventId: string;
  let callTimeId: string;

  beforeAll(async () => {
    eventId = await makeEvent(prodId, TEST_USER);
    callTimeId = await makeCallTime(eventId, TEST_USER);
  });

  it("sets rsvp + rsvp_at and returns eventId", async () => {
    const result = await rsvpCallTime(callTimeId, TEST_USER, "yes");
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(eventId);

    const row = await getPool().query<{ rsvp: string; rsvp_at: Date | null }>(
      `SELECT rsvp, rsvp_at FROM event_call_time WHERE id = $1`,
      [callTimeId],
    );
    expect(row.rows[0].rsvp).toBe("yes");
    expect(row.rows[0].rsvp_at).not.toBeNull();
  });

  it("can update rsvp from yes → no", async () => {
    await rsvpCallTime(callTimeId, TEST_USER, "no");
    const row = await getPool().query<{ rsvp: string }>(
      `SELECT rsvp FROM event_call_time WHERE id = $1`,
      [callTimeId],
    );
    expect(row.rows[0].rsvp).toBe("no");
  });

  it("returns null when call_time belongs to another user", async () => {
    const result = await rsvpCallTime(callTimeId, otherUserId, "yes");
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API — auth guard
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/my/notifications — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await listHandler(req("/api/my/notifications"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/my/notifications — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await markReadHandler(req("/api/my/notifications", { method: "PATCH" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/my/notifications/unread-count — no auth", () => {
  it("no cookie → returns { count: 0 } (not 401)", async () => {
    const res = await countHandler(req("/api/my/notifications/unread-count"));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(body.count).toBe(0);
  });
});

describe("POST /api/my/notifications/[id]/act — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await actHandler(
      req("/api/my/notifications/fake-id/act", { method: "POST", body: { actionId: "x" } }),
      ctx({ id: "fake-id" }),
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/my/notifications — happy path", () => {
  it("returns notifications array for authed user", async () => {
    const res = await listHandler(
      req("/api/my/notifications", { session: session() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { notifications: unknown[] };
    expect(Array.isArray(body.notifications)).toBe(true);
  });

  it("accepts filter=pending query param", async () => {
    const res = await listHandler(
      req("/api/my/notifications?filter=pending", { session: session() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { notifications: Array<{ actionRequired: boolean; actedAt: string | null }> };
    expect(body.notifications.every((n) => n.actionRequired && !n.actedAt)).toBe(true);
  });
});

describe("GET /api/my/notifications/unread-count — happy path", () => {
  it("returns a numeric count for authed user", async () => {
    const res = await countHandler(
      req("/api/my/notifications/unread-count", { session: session() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(typeof body.count).toBe("number");
    expect(body.count).toBeGreaterThanOrEqual(0);
  });
});

describe("PATCH /api/my/notifications — mark read", () => {
  it("marks specified notification ids as read", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "api-read-1", title: "API 标已读",
    });
    expect(n.readAt).toBeNull();

    const res = await markReadHandler(
      req("/api/my/notifications", { method: "PATCH", session: session(), body: { ids: [n.id] } }),
    );
    expect(res.status).toBe(200);

    const updated = await getUserNotification(n.id, TEST_USER);
    expect(updated!.readAt).not.toBeNull();
  });

  it("marks all read when no ids provided", async () => {
    const u = await createTestUser();
    try {
      await createUserNotification({ userId: u, kind: "t", entityType: "t", entityId: "api-ar1", title: "1" });
      await createUserNotification({ userId: u, kind: "t", entityType: "t", entityId: "api-ar2", title: "2" });

      const res = await markReadHandler(
        req("/api/my/notifications", {
          method: "PATCH",
          session: createSession({ userId: u, name: "u", avatarUrl: null, isAdmin: false }),
          body: {},
        }),
      );
      expect(res.status).toBe(200);

      const items = await listUserNotifications(u, { filter: "all" });
      expect(items.every((n) => !!n.readAt)).toBe(true);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id = $1", [u]).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API — POST /[id]/act
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/my/notifications/[id]/act", () => {
  it("missing actionId → 400", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "act-api-1", title: "动作测试",
      actionRequired: true,
      actions: [],
    });
    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, { method: "POST", session: session(), body: {} }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(400);
  });

  it("nonexistent notification → 404", async () => {
    const res = await actHandler(
      req(`/api/my/notifications/does-not-exist/act`, {
        method: "POST", session: session(), body: { actionId: "x" },
      }),
      ctx({ id: "does-not-exist" }),
    );
    expect(res.status).toBe(404);
  });

  it("wrong actionId → 400", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "t", entityId: "act-api-2", title: "动作测试2",
      actionRequired: true,
      actions: [{ id: "real-action", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "nonexistent" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(400);
  });

  it("cannot act on another user's notification → 404", async () => {
    const n = await createUserNotification({
      userId: otherUserId, kind: "test", entityType: "t", entityId: "act-api-3", title: "他人的",
      actionRequired: true,
      actions: [{ id: "a", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    });
    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(TEST_USER), body: { actionId: "a" },
      }),
      ctx({ id: n.id }),
    );
    // getUserNotification returns null for wrong owner → 404
    expect(res.status).toBe(404);
  });

  it("mark_acted effect — records acted_at on notification", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "t", entityId: "act-api-4", title: "待确认",
      actionRequired: true,
      actions: [{ id: "done", presentation: "primary_button", label: "已完成", effects: [{ type: "mark_acted" }] }],
    });

    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "done" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(200);

    const updated = await getUserNotification(n.id, TEST_USER);
    expect(updated!.actedAt).not.toBeNull();
  });

  it("set_field confirmed_at — updates event_call_time row", async () => {
    const eventId = await makeEvent(prodId, TEST_USER);
    const ctId = await makeCallTime(eventId, TEST_USER);

    const n = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "call_time", entityId: ctId,
      title: "请确认 Call Time", actionRequired: true,
      actions: [{
        id: "confirm", presentation: "primary_button", label: "确认",
        effects: [{ type: "set_field", entityType: "call_time", entityId: ctId, field: "confirmed_at" }],
      }],
    });

    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "confirm" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(200);

    const row = await getPool().query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM event_call_time WHERE id = $1`,
      [ctId],
    );
    expect(row.rows[0].confirmed_at).not.toBeNull();
  });

  it("external sentinel — marks notification as acted without executing any effects", async () => {
    // A notification with no actions; external sentinel must not error on that.
    const n = await createUserNotification({
      userId: TEST_USER, kind: "tech_req", entityType: "tech_req", entityId: "ext-1",
      title: "外部模式通知", actionRequired: true,
      actions: [],
    });
    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "external" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(200);
    const updated = await getUserNotification(n.id, TEST_USER);
    expect(updated!.actedAt).not.toBeNull();
  });

  it("set_status with disallowed value → 500 (status allowlist)", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "tech_req", entityId: "x",
      title: "状态注入测试", actionRequired: true,
      actions: [{
        id: "bad", presentation: "primary_button", label: "设置",
        effects: [{ type: "set_status", entityType: "tech_req", entityId: "x", to: "'; DROP TABLE event_tech_req; --" }],
      }],
    });
    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "bad" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(500);
  });

  it("set_field with disallowed entityType → 500 (security allowlist)", async () => {
    const n = await createUserNotification({
      userId: TEST_USER, kind: "test", entityType: "evil_table", entityId: "x",
      title: "安全测试", actionRequired: true,
      actions: [{
        id: "evil", presentation: "primary_button", label: "注入",
        effects: [{ type: "set_field", entityType: "evil_table", entityId: "x", field: "some_col" }],
      }],
    });

    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "evil" },
      }),
      ctx({ id: n.id }),
    );
    // The allowlist rejects the entityType → transaction rolls back → 500
    expect(res.status).toBe(500);
  });

  it("set_rsvp effect — updates event_call_time rsvp column", async () => {
    const eventId = await makeEvent(prodId, TEST_USER);
    const ctId = await makeCallTime(eventId, TEST_USER);

    const n = await createUserNotification({
      userId: TEST_USER, kind: "call_time", entityType: "call_time", entityId: ctId,
      title: "RSVP 测试", actionRequired: true,
      actions: [
        { id: "rsvp-yes", presentation: "primary_button", label: "是", effects: [{ type: "set_rsvp", entityType: "call_time", entityId: ctId, rsvp: "yes" }] },
        { id: "rsvp-no", presentation: "secondary_button", label: "否", effects: [{ type: "set_rsvp", entityType: "call_time", entityId: ctId, rsvp: "no" }] },
        { id: "rsvp-tent", presentation: "secondary_button", label: "待定", effects: [{ type: "set_rsvp", entityType: "call_time", entityId: ctId, rsvp: "tentative" }] },
      ],
    });

    const res = await actHandler(
      req(`/api/my/notifications/${n.id}/act`, {
        method: "POST", session: session(), body: { actionId: "rsvp-no" },
      }),
      ctx({ id: n.id }),
    );
    expect(res.status).toBe(200);

    const row = await getPool().query<{ rsvp: string; rsvp_at: Date | null }>(
      `SELECT rsvp, rsvp_at FROM event_call_time WHERE id = $1`,
      [ctId],
    );
    expect(row.rows[0].rsvp).toBe("no");
    expect(row.rows[0].rsvp_at).not.toBeNull();
  });
});
