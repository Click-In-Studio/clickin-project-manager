/**
 * API layer tests — route handlers called directly (no HTTP server).
 *
 * Covers: auth guard (no cookie / tampered / expired), admin-only authorization,
 * member-only authorization, input validation, and happy-path responses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { deleteProduction, createProduction, archiveProduction } from "@/lib/db";
import { deleteProductionEvent } from "@/lib/event-db";
import { TEST_USER, PROD_PLANET } from "./helpers";

// ── Route handlers under test ──────────────────────────────────────────────────
import {
  GET as listProductionsHandler,
  POST as createProductionHandler,
  DELETE as deleteProductionHandler,
} from "@/app/api/productions/route";
import {
  GET as listCueListsHandler,
  POST as createCueListHandler,
} from "@/app/api/production/[id]/cuelists/route";
import {
  GET as listEventsHandler,
  POST as createEventHandler,
} from "@/app/api/production/[id]/events/route";
import {
  POST as archiveProdHandler,
  DELETE as unarchiveProdHandler,
} from "@/app/api/production/[id]/archive/route";

// ── Session helpers ────────────────────────────────────────────────────────────

function adminSession() {
  return createSession({ openId: TEST_USER, name: "测试管理员", avatarUrl: null, isAdmin: true });
}
function userSession() {
  return createSession({ openId: TEST_USER, name: "测试普通用户", avatarUrl: null, isAdmin: false });
}

function req(
  url: string,
  opts: { session?: string; method?: string; body?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method,
    body: opts.body,
    headers,
  });
}

// Route handlers are typed with specific param shapes; `any` avoids a
// spurious structural mismatch between Record<string,string> and {id:string}.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

// ── Cleanup state ──────────────────────────────────────────────────────────────

const created: { type: "production" | "event"; id: string; prodId?: string }[] = [];

afterAll(async () => {
  for (const item of created.reverse()) {
    if (item.type === "event") {
      await deleteProductionEvent(item.id, item.prodId!).catch(() => {});
    } else {
      await deleteProduction(item.id).catch(() => {});
    }
  }
});

// ── Auth guard ─────────────────────────────────────────────────────────────────

describe("auth guard — GET /api/productions", () => {
  it("no cookie → 401", async () => {
    const res = await listProductionsHandler(req("/api/productions"));
    expect(res.status).toBe(401);
  });

  it("tampered signature → 401", async () => {
    const token = adminSession();
    // flip last character
    const tampered = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
    const res = await listProductionsHandler(
      req("/api/productions", { session: tampered }),
    );
    expect(res.status).toBe(401);
  });

  it("expired session → 401", async () => {
    const token = adminSession(); // expiry = now + 7 days
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      const res = await listProductionsHandler(
        req("/api/productions", { session: token }),
      );
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── POST /api/productions — authorization ──────────────────────────────────────

describe("POST /api/productions — authorization", () => {
  it("non-admin → 403", async () => {
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "不应该创建" }),
        session: userSession(),
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ── POST /api/productions — input validation ───────────────────────────────────

describe("POST /api/productions — input validation", () => {
  it("empty name → 400", async () => {
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "   " }),
        session: adminSession(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("missing name field → 400", async () => {
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({}),
        session: adminSession(),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── GET /api/productions — happy path ─────────────────────────────────────────

describe("GET /api/productions", () => {
  it("admin gets list including seeded productions", async () => {
    const res = await listProductionsHandler(
      req("/api/productions", { session: adminSession() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productions: { id: string }[] };
    expect(Array.isArray(body.productions)).toBe(true);
    expect(body.productions.some((p) => p.id === PROD_PLANET)).toBe(true);
  });

  it("non-admin non-member gets empty list", async () => {
    const res = await listProductionsHandler(
      req("/api/productions", { session: userSession() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productions: { id: string }[] };
    expect(body.productions.length).toBe(0);
  });
});

// ── POST /api/productions — happy path + cleanup ───────────────────────────────

describe("POST /api/productions — happy path", () => {
  it("admin creates production, response includes id", async () => {
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "API测试演出" }),
        session: adminSession(),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe("string");
    created.push({ type: "production", id: body.id });
  });
});

// ── GET /api/production/[id]/cuelists — authorization ─────────────────────────

describe("GET /api/production/[id]/cuelists — authorization", () => {
  it("non-member non-admin → 403", async () => {
    const res = await listCueListsHandler(
      req(`/api/production/${PROD_PLANET}/cuelists`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with array", async () => {
    const res = await listCueListsHandler(
      req(`/api/production/${PROD_PLANET}/cuelists`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ── POST /api/production/[id]/cuelists — validation + archived guard ───────────

describe("POST /api/production/[id]/cuelists — validation", () => {
  it("admin, empty name → 400", async () => {
    const res = await createCueListHandler(
      req(`/api/production/${PROD_PLANET}/cuelists`, {
        method: "POST",
        body: JSON.stringify({ name: "" }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/production/[id]/cuelists — archived guard", () => {
  const ARCH_PROD = "test-api-arch-prod";

  beforeAll(async () => {
    await createProduction(ARCH_PROD, "API归档测试演出");
    // Archive via the route handler (exercises the archive route too)
    await archiveProdHandler(
      req(`/api/production/${ARCH_PROD}/archive`, {
        method: "POST",
        session: adminSession(),
      }),
      ctx({ id: ARCH_PROD }),
    );
  });

  afterAll(async () => {
    await deleteProduction(ARCH_PROD).catch(() => {});
  });

  it("POST cue list on archived production → 403", async () => {
    const res = await createCueListHandler(
      req(`/api/production/${ARCH_PROD}/cuelists`, {
        method: "POST",
        body: JSON.stringify({ name: "不应创建" }),
        session: adminSession(),
      }),
      ctx({ id: ARCH_PROD }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/归档/);
  });
});

// ── GET /api/production/[id]/events ───────────────────────────────────────────

describe("GET /api/production/[id]/events — authorization", () => {
  it("non-member → 403", async () => {
    const res = await listEventsHandler(
      req(`/api/production/${PROD_PLANET}/events`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with events array", async () => {
    const res = await listEventsHandler(
      req(`/api/production/${PROD_PLANET}/events`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});

// ── POST /api/production/[id]/events ──────────────────────────────────────────

describe("POST /api/production/[id]/events — validation", () => {
  it("empty title → 400", async () => {
    const res = await createEventHandler(
      req(`/api/production/${PROD_PLANET}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "  " }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(400);
  });

  it("non-member non-admin → 403", async () => {
    const res = await createEventHandler(
      req(`/api/production/${PROD_PLANET}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "不应创建的排练" }),
        session: userSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/production/[id]/events — happy path", () => {
  it("admin creates event, response includes event with id", async () => {
    const res = await createEventHandler(
      req(`/api/production/${PROD_PLANET}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "API测试排练", eventType: "rehearsal" }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { id: string; title: string } };
    expect(body.event.id).toBeTruthy();
    expect(body.event.title).toBe("API测试排练");
    created.push({ type: "event", id: body.event.id, prodId: PROD_PLANET });
  });
});
