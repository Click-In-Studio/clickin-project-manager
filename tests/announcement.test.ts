/**
 * Tests for announcement read-tracking routes:
 *   POST /api/production/[id]/announcements/[announcementId]/read
 *   GET  /api/production/[id]/announcements/[announcementId]/read-status
 *   POST /api/production/[id]/announcements/[announcementId]/remind
 *
 * Covers: auth guard, member-access guard, admin-only guard, happy paths.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  addProductionMember,
  createAnnouncement,
  deleteAnnouncement,
  markAnnouncementRead,
} from "@/lib/db";
import { TEST_USER } from "./helpers";
import { makeProduction, cleanupProduction, shortId } from "./factories";

import { POST as markReadHandler } from "@/app/api/production/[id]/announcements/[announcementId]/read/route";
import { GET as readStatusHandler } from "@/app/api/production/[id]/announcements/[announcementId]/read-status/route";
import { POST as remindHandler } from "@/app/api/production/[id]/announcements/[announcementId]/remind/route";

// ── Session helpers ────────────────────────────────────────────────────────────

function adminSession() {
  return createSession({ userId: TEST_USER, name: "测试管理员", avatarUrl: null, isAdmin: true });
}
function userSession() {
  return createSession({ userId: TEST_USER, name: "测试成员", avatarUrl: null, isAdmin: false });
}

function req(
  url: string,
  opts: { session?: string; method?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    headers,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

// ── Shared state ───────────────────────────────────────────────────────────────

let prodId = "";
let annId = "";

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  annId = shortId();
  await createAnnouncement(annId, prodId, "测试公告", "正文内容", TEST_USER);
});

afterAll(async () => {
  await deleteAnnouncement(annId).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

// ── POST .../read — auth guard ─────────────────────────────────────────────────

describe("POST .../read — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await markReadHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read`, { method: "POST" }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member (non-admin) → 403", async () => {
    const res = await markReadHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read`, {
        method: "POST",
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(403);
  });
});

// ── POST .../read — happy path ─────────────────────────────────────────────────

describe("POST .../read — happy path", () => {
  beforeAll(async () => {
    await addProductionMember(prodId, TEST_USER);
  });

  it("member marks announcement as read → 200", async () => {
    const res = await markReadHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read`, {
        method: "POST",
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("idempotent — marking read twice still → 200", async () => {
    const res = await markReadHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read`, {
        method: "POST",
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(200);
  });

  it("wrong announcementId → 404", async () => {
    const res = await markReadHandler(
      req(`/api/production/${prodId}/announcements/nonexistent/read`, {
        method: "POST",
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: "nonexistent" }),
    );
    expect(res.status).toBe(404);
  });
});

// ── GET .../read-status — auth & permission guard ──────────────────────────────

describe("GET .../read-status — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await readStatusHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read-status`),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(401);
  });

  it("member without announcement:edit → 403", async () => {
    // TEST_USER is a member (added above) but has no announcement:edit via MEMBER_BASE_PERMISSIONS
    const res = await readStatusHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read-status`, {
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET .../read-status — happy path (admin)", () => {
  it("admin gets read/unread breakdown", async () => {
    // Ensure TEST_USER has read the announcement (done in mark-read tests above)
    await markAnnouncementRead(annId, TEST_USER);

    const res = await readStatusHandler(
      req(`/api/production/${prodId}/announcements/${annId}/read-status`, {
        session: adminSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { read: unknown[]; unread: unknown[]; total: number };
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.read)).toBe(true);
    expect(Array.isArray(body.unread)).toBe(true);
    expect(body.read.length + body.unread.length).toBe(body.total);
    // TEST_USER is a member and has read it
    expect(body.read.length).toBeGreaterThanOrEqual(1);
  });
});

// ── POST .../remind — auth & permission guard ──────────────────────────────────

describe("POST .../remind — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await remindHandler(
      req(`/api/production/${prodId}/announcements/${annId}/remind`, { method: "POST" }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(401);
  });

  it("member without announcement:edit → 403", async () => {
    const res = await remindHandler(
      req(`/api/production/${prodId}/announcements/${annId}/remind`, {
        method: "POST",
        session: userSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST .../remind — happy path (admin)", () => {
  it("admin sends remind → 200, sent count returned", async () => {
    const res = await remindHandler(
      req(`/api/production/${prodId}/announcements/${annId}/remind`, {
        method: "POST",
        session: adminSession(),
      }),
      ctx({ id: prodId, announcementId: annId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    // TEST_USER has already read the announcement, so unread count may be 0
    expect(typeof body.sent).toBe("number");
  });
});
