/**
 * API layer tests — route handlers called directly (no HTTP server).
 *
 * Covers: auth guard (no cookie / tampered / expired), admin-only authorization,
 * member-only authorization, input validation, and happy-path responses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { deleteProduction, createProduction, archiveProduction, addProductionMember, getActiveVersionId } from "@/lib/db";
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
import {
  GET as loadProdHandler,
  PATCH as renameProdHandler,
} from "@/app/api/production/[id]/route";
import {
  GET as listVersionsHandler,
  POST as createVersionHandler,
} from "@/app/api/production/[id]/versions/route";
import {
  GET as getScriptHandler,
  PATCH as patchScriptHandler,
} from "@/app/api/script/[id]/route";
import {
  GET as listMembersHandler,
  POST as addMemberHandler,
  PATCH as updateMemberHandler,
  DELETE as removeMemberHandler,
} from "@/app/api/production/[id]/members/route";

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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/productions
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/productions — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await deleteProductionHandler(
      req("/api/productions", { method: "DELETE", body: JSON.stringify({ id: "x" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await deleteProductionHandler(
      req("/api/productions", { method: "DELETE", body: JSON.stringify({ id: PROD_PLANET }), session: userSession() }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/productions — input validation", () => {
  it("missing id → 400", async () => {
    const res = await deleteProductionHandler(
      req("/api/productions", { method: "DELETE", body: JSON.stringify({}), session: adminSession() }),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/productions — happy path", () => {
  const DEL_PROD = "test-api-del-prod";

  beforeAll(async () => {
    await createProduction(DEL_PROD, "API删除测试演出");
  });

  it("admin deletes production → 200 and production is gone", async () => {
    const res = await deleteProductionHandler(
      req("/api/productions", { method: "DELETE", body: JSON.stringify({ id: DEL_PROD }), session: adminSession() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const listRes = await listProductionsHandler(req("/api/productions", { session: adminSession() }));
    const { productions } = (await listRes.json()) as { productions: { id: string }[] };
    expect(productions.some((p) => p.id === DEL_PROD)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/production/[id] — rename
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/production/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${PROD_PLANET}`, { method: "PATCH" }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/production/[id] — authorization", () => {
  it("non-member non-admin → 403", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${PROD_PLANET}`, {
        method: "PATCH", body: JSON.stringify({ name: "越权改名" }), session: userSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/production/[id] — member without manage_permissions → 403", () => {
  const NOPERM_PROD = "test-api-noperm";

  beforeAll(async () => {
    await createProduction(NOPERM_PROD, "无权限测试演出");
    await addProductionMember(NOPERM_PROD, TEST_USER); // no "制作人" role assigned
  });

  afterAll(async () => {
    await deleteProduction(NOPERM_PROD).catch(() => {});
  });

  it("member without 制作人 role → 403", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${NOPERM_PROD}`, {
        method: "PATCH", body: JSON.stringify({ name: "越权改名" }), session: userSession(),
      }),
      ctx({ id: NOPERM_PROD }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/production/[id] — input validation", () => {
  it("admin, empty name → 400", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${PROD_PLANET}`, {
        method: "PATCH", body: JSON.stringify({ name: "  " }), session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/production/[id] — happy path", () => {
  const RENAME_PROD = "test-api-rename";

  beforeAll(async () => {
    await createProduction(RENAME_PROD, "重命名测试演出（原名）");
  });

  afterAll(async () => {
    await deleteProduction(RENAME_PROD).catch(() => {});
  });

  it("admin renames production → 200", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${RENAME_PROD}`, {
        method: "PATCH", body: JSON.stringify({ name: "重命名测试演出（新名）" }), session: adminSession(),
      }),
      ctx({ id: RENAME_PROD }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/production/[id]/versions
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/production/[id]/versions — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await listVersionsHandler(
      req(`/api/production/${PROD_PLANET}/versions`),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await listVersionsHandler(
      req(`/api/production/${PROD_PLANET}/versions`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/production/[id]/versions — happy path", () => {
  it("admin → 200 with versions array", async () => {
    const res = await listVersionsHandler(
      req(`/api/production/${PROD_PLANET}/versions`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: { id: string }[] };
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/production/[id]/versions
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/production/[id]/versions — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await createVersionHandler(
      req(`/api/production/${PROD_PLANET}/versions`, { method: "POST", body: JSON.stringify({}) }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await createVersionHandler(
      req(`/api/production/${PROD_PLANET}/versions`, {
        method: "POST", body: JSON.stringify({}), session: userSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/production/[id]/versions — happy path", () => {
  const VER_PROD = "test-api-ver";

  beforeAll(async () => {
    await createProduction(VER_PROD, "版本测试演出");
  });

  afterAll(async () => {
    await deleteProduction(VER_PROD).catch(() => {});
  });

  it("admin creates version → 201 with version object", async () => {
    const res = await createVersionHandler(
      req(`/api/production/${VER_PROD}/versions`, {
        method: "POST", body: JSON.stringify({ name: "测试版本" }), session: adminSession(),
      }),
      ctx({ id: VER_PROD }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { version: { id: string; name: string } };
    expect(body.version.id).toBeTruthy();
    expect(body.version.name).toBe("测试版本");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/production/[id]/members
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/production/[id]/members — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${PROD_PLANET}/members`),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${PROD_PLANET}/members`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with members array", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${PROD_PLANET}/members`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[] };
    expect(Array.isArray(body.members)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/production/[id]/members
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/production/[id]/members — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, { method: "POST", body: JSON.stringify({ openId: TEST_USER }) }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "POST", body: JSON.stringify({ openId: TEST_USER }), session: userSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/production/[id]/members — input validation", () => {
  it("missing openId → 400", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "POST", body: JSON.stringify({}), session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/production/[id]/members — happy path", () => {
  const MBR_PROD = "test-api-mbr";

  beforeAll(async () => {
    await createProduction(MBR_PROD, "成员测试演出");
  });

  afterAll(async () => {
    await deleteProduction(MBR_PROD).catch(() => {});
  });

  it("admin adds member → 200", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${MBR_PROD}/members`, {
        method: "POST", body: JSON.stringify({ openId: TEST_USER, name: "测试成员" }), session: adminSession(),
      }),
      ctx({ id: MBR_PROD }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/production/[id]/members
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/production/[id]/members — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await updateMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "PATCH", body: JSON.stringify({ openId: TEST_USER, email: "x@example.com" }),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin updating another user → 403", async () => {
    const res = await updateMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "PATCH",
        body: JSON.stringify({ openId: "some-other-open-id", email: "x@example.com" }),
        session: userSession(), // session.openId = TEST_USER ≠ body.openId
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/production/[id]/members
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/production/[id]/members — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await removeMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "DELETE", body: JSON.stringify({ openId: TEST_USER }),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await removeMemberHandler(
      req(`/api/production/${PROD_PLANET}/members`, {
        method: "DELETE", body: JSON.stringify({ openId: TEST_USER }), session: userSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/production/[id] — script state loader
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/production/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await loadProdHandler(
      req(`/api/production/${PROD_PLANET}`),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await loadProdHandler(
      req(`/api/production/${PROD_PLANET}`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/production/[id] — happy path", () => {
  it("admin → 200 with state, versionId, versions", async () => {
    const res = await loadProdHandler(
      req(`/api/production/${PROD_PLANET}`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { blocks: unknown[] }; versionId: string; versions: unknown[] };
    expect(Array.isArray(body.state.blocks)).toBe(true);
    expect(body.state.blocks.length).toBeGreaterThan(0);
    expect(body.versionId).toBeTruthy();
    expect(Array.isArray(body.versions)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/script/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/script/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await getScriptHandler(
      req(`/api/script/${PROD_PLANET}`),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await getScriptHandler(
      req(`/api/script/${PROD_PLANET}`, { session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/script/[id] — auth guard + adminBypass:false enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/script/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await patchScriptHandler(
      req(`/api/script/${PROD_PLANET}`, { method: "PATCH" }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await patchScriptHandler(
      req(`/api/script/${PROD_PLANET}`, { method: "PATCH", body: "{}", session: userSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/script/[id] — script:edit adminBypass:false", () => {
  // script:edit has adminBypass:false — even admin needs "编剧" or "制作人" role.
  // This test verifies a plain member (no qualifying role) gets 403 on a block insert.
  const SCRIPT_PERM_PROD = "test-api-script-perm";
  let scriptPermVersionId = "";

  beforeAll(async () => {
    await createProduction(SCRIPT_PERM_PROD, "剧本权限测试演出");
    await addProductionMember(SCRIPT_PERM_PROD, TEST_USER); // no 编剧 / 制作人 role
    scriptPermVersionId = (await getActiveVersionId(SCRIPT_PERM_PROD))!;
  });

  afterAll(async () => {
    await deleteProduction(SCRIPT_PERM_PROD).catch(() => {});
  });

  it("member without 编剧/制作人 role → 403 on block insert", async () => {
    const patch = JSON.stringify({
      clientSeq: 1,
      blockOps: [{
        op: "insert",
        block: { id: "test-perm-blk", type: "stage", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null },
        afterId: null,
      }],
      charOps: [],
      sceneOps: [],
    });
    const res = await patchScriptHandler(
      req(`/api/script/${SCRIPT_PERM_PROD}?v=${scriptPermVersionId}`, {
        method: "PATCH", body: patch, session: userSession(),
      }),
      ctx({ id: SCRIPT_PERM_PROD }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/script:edit/);
  });
});
