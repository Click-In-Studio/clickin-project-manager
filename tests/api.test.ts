/**
 * API layer tests — route handlers called directly (no HTTP server).
 *
 * Covers: auth guard (no cookie / tampered / expired), admin-only authorization,
 * member-only authorization, input validation, and happy-path responses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { deleteProduction, createProduction, archiveProduction, addProductionMember, getActiveVersionId, upsertFeishuUser } from "@/lib/db";
import { deleteProductionEvent } from "@/lib/event-db";
import { TEST_USER, TEST_OWNER } from "./helpers";
import { makeProduction, makeBlocks, cleanupProduction, makeLegacyVersion } from "./factories";
import { getPool } from "@/lib/pg";

// ── Route handlers under test ──────────────────────────────────────────────────
import {
  GET as listProductionsHandler,
  POST as createProductionHandler,
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
  GET as getScriptHandler,
  PATCH as patchScriptHandler,
} from "@/app/api/script/[id]/route";
import { POST as createScriptCommentHandler } from "@/app/api/script/[id]/comments/route";
import {
  GET as listMembersHandler,
  POST as addMemberHandler,
  PATCH as updateMemberHandler,
  DELETE as removeMemberHandler,
} from "@/app/api/production/[id]/members/route";

// ── Session helpers ────────────────────────────────────────────────────────────

function adminSession() {
  return createSession({ userId: TEST_USER, name: "测试管理员", avatarUrl: null, isAdmin: true });
}
function userSession() {
  return createSession({ userId: TEST_USER, name: "测试普通用户", avatarUrl: null, isAdmin: false });
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

// ── Factory production shared across auth/authz tests ─────────────────────────

let AP_PROD = "";
let apVersionId = "";

beforeAll(async () => {
  ({ prodId: AP_PROD, versionId: apVersionId } = await makeProduction());
  await makeBlocks(AP_PROD, apVersionId, 3);
});

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
  await cleanupProduction(AP_PROD).catch(() => {});
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
  it("未登录 → 401", async () => {
    const res = await createProductionHandler(
      req("/api/productions", { method: "POST", body: JSON.stringify({ name: "无会话不应创建" }) }),
    );
    expect(res.status).toBe(401);
  });

  // #280 建项目门 = 用户等级：user_plan 无行的普通注册用户 → 403（不是 isAdmin——
  // 那道门是无人能过的孤门，不要退回）。TEST_USER 在 global-setup 里给了 internal 档。
  it("无等级的普通注册用户 → 403", async () => {
    const { userId } = await upsertFeishuUser(`test-noplan-${Date.now().toString(36)}`, "无档用户", null, false);
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "无档用户不应建成" }),
        session: createSession({ userId, name: "无档用户", avatarUrl: null, isAdmin: false }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("有等级（internal）的登录用户 → 201，且创建者即 owner", async () => {
    const res = await createProductionHandler(
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "普通用户建的项目" }),
        session: userSession(),
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    created.push({ type: "production", id });

    const owner = await getPool().query<{ owner_id: string }>(
      "SELECT owner_id FROM production WHERE id = $1", [id],
    );
    expect(owner.rows[0]?.owner_id).toBe(TEST_USER);
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
  it("admin gets list including factory production", async () => {
    const res = await listProductionsHandler(
      req("/api/productions", { session: adminSession() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productions: { id: string }[] };
    expect(Array.isArray(body.productions)).toBe(true);
    expect(body.productions.some((p) => p.id === AP_PROD)).toBe(true);
  });

  it("non-admin non-member gets empty list", async () => {
    // Use a fresh UUID that is never added to any production_member row
    // (TEST_USER is used by migration factories and may appear as a member).
    const freshUserSession = createSession({
      userId: "00000000-0000-0000-0000-000000000099",
      name: "纯访客",
      avatarUrl: null,
      isAdmin: false,
    });
    const res = await listProductionsHandler(
      req("/api/productions", { session: freshUserSession }),
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
      req(`/api/production/${AP_PROD}/cuelists`, { session: userSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with array", async () => {
    const res = await listCueListsHandler(
      req(`/api/production/${AP_PROD}/cuelists`, { session: adminSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ── POST /api/production/[id]/cuelists — validation + archived guard ───────────

describe("POST /api/production/[id]/cuelists — validation", () => {
  it("admin, empty name → 400", async () => {
    const res = await createCueListHandler(
      req(`/api/production/${AP_PROD}/cuelists`, {
        method: "POST",
        body: JSON.stringify({ name: "" }),
        session: adminSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/production/[id]/cuelists — archived guard", () => {
  const ARCH_PROD = "test-api-arch-prod";

  beforeAll(async () => {
    await createProduction(ARCH_PROD, "API归档测试演出", TEST_OWNER);
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
      req(`/api/production/${AP_PROD}/events`, { session: userSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with events array", async () => {
    const res = await listEventsHandler(
      req(`/api/production/${AP_PROD}/events`, { session: adminSession() }),
      ctx({ id: AP_PROD }),
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
      req(`/api/production/${AP_PROD}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "  " }),
        session: adminSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(400);
  });

  it("non-member non-admin → 403", async () => {
    const res = await createEventHandler(
      req(`/api/production/${AP_PROD}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "不应创建的排练" }),
        session: userSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/production/[id]/events — happy path", () => {
  it("admin creates event, response includes event with id", async () => {
    const res = await createEventHandler(
      req(`/api/production/${AP_PROD}/events`, {
        method: "POST",
        body: JSON.stringify({ title: "API测试排练", eventType: "rehearsal" }),
        session: adminSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { id: string; title: string } };
    expect(body.event.id).toBeTruthy();
    expect(body.event.title).toBe("API测试排练");
    created.push({ type: "event", id: body.event.id, prodId: AP_PROD });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/production/[id] — rename
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/production/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${AP_PROD}`, { method: "PATCH" }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/production/[id] — authorization", () => {
  it("non-member non-admin → 403", async () => {
    const res = await renameProdHandler(
      req(`/api/production/${AP_PROD}`, {
        method: "PATCH", body: JSON.stringify({ name: "越权改名" }), session: userSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/production/[id] — member without manage_permissions → 403", () => {
  const NOPERM_PROD = "test-api-noperm";

  beforeAll(async () => {
    await createProduction(NOPERM_PROD, "无权限测试演出", TEST_OWNER);
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
      req(`/api/production/${AP_PROD}`, {
        method: "PATCH", body: JSON.stringify({ name: "  " }), session: adminSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/production/[id] — happy path", () => {
  const RENAME_PROD = "test-api-rename";

  beforeAll(async () => {
    await createProduction(RENAME_PROD, "重命名测试演出（原名）", TEST_OWNER);
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
// 版本退役 Phase B：历史版本只读（head-only 写保护）
// ─────────────────────────────────────────────────────────────────────────────

describe("head-only 写保护 — 历史版本只读", () => {
  let headProdId = "";
  let legacyVersionId = "";
  let headVersionId = "";

  beforeAll(async () => {
    ({ prodId: headProdId, versionId: legacyVersionId } = await makeProduction());
    await makeBlocks(headProdId, legacyVersionId, 1);
    headVersionId = await makeLegacyVersion(headProdId, legacyVersionId);
  });

  afterAll(async () => {
    await cleanupProduction(headProdId).catch(() => {});
  });

  const patchWith = (v: string) => patchScriptHandler(
    req(`/api/script/${headProdId}?v=${v}`, {
      method: "PATCH", body: JSON.stringify({ clientSeq: 1, blockOps: [], charOps: [], sceneOps: [] }),
      session: adminSession(),
    }),
    ctx({ id: headProdId }),
  );

  it("PATCH ?v=<历史版本> → 409（本演出的旧版本只读）", async () => {
    expect((await patchWith(legacyVersionId)).status).toBe(409);
  });

  it("PATCH ?v=<head> → 200（活跃版本放行）", async () => {
    expect((await patchWith(headVersionId)).status).toBe(200);
  });

  it("PATCH ?v=<不存在的版本> → 404（守卫自带归属判定，不误报 409）", async () => {
    expect((await patchWith("ver_no_such_version")).status).toBe(404);
  });

  it("PATCH ?v=<别的演出的版本> → 404（跨演出 versionId 不泄露只读语义）", async () => {
    const other = await makeProduction();
    try {
      expect((await patchWith(other.versionId)).status).toBe(404);
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/production/[id]/members
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/production/[id]/members — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${AP_PROD}/members`),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${AP_PROD}/members`, { session: userSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });

  it("admin → 200 with members array", async () => {
    const res = await listMembersHandler(
      req(`/api/production/${AP_PROD}/members`, { session: adminSession() }),
      ctx({ id: AP_PROD }),
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
      req(`/api/production/${AP_PROD}/members`, { method: "POST", body: JSON.stringify({ userId: TEST_USER }) }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${AP_PROD}/members`, {
        method: "POST", body: JSON.stringify({ userId: TEST_USER }), session: userSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/production/[id]/members — input validation", () => {
  it("missing userId → 400", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${AP_PROD}/members`, {
        method: "POST", body: JSON.stringify({}), session: adminSession(),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/production/[id]/members — happy path", () => {
  const MBR_PROD = "test-api-mbr";

  beforeAll(async () => {
    await createProduction(MBR_PROD, "成员测试演出", TEST_OWNER);
  });

  afterAll(async () => {
    await deleteProduction(MBR_PROD).catch(() => {});
  });

  it("admin adds member → 200", async () => {
    const res = await addMemberHandler(
      req(`/api/production/${MBR_PROD}/members`, {
        method: "POST", body: JSON.stringify({ userId: TEST_USER, name: "测试成员" }), session: adminSession(),
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
      req(`/api/production/${AP_PROD}/members`, {
        method: "PATCH", body: JSON.stringify({ userId: TEST_USER, email: "x@example.com" }),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin updating another user → 403", async () => {
    const res = await updateMemberHandler(
      req(`/api/production/${AP_PROD}/members`, {
        method: "PATCH",
        body: JSON.stringify({ userId: "some-other-user-id", email: "x@example.com" }),
        session: userSession(), // session.userId = TEST_USER ≠ body.userId
      }),
      ctx({ id: AP_PROD }),
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
      req(`/api/production/${AP_PROD}/members`, {
        method: "DELETE", body: JSON.stringify({ userId: TEST_USER }),
      }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-admin → 403", async () => {
    const res = await removeMemberHandler(
      req(`/api/production/${AP_PROD}/members`, {
        method: "DELETE", body: JSON.stringify({ userId: TEST_USER }), session: userSession(),
      }),
      ctx({ id: AP_PROD }),
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
      req(`/api/production/${AP_PROD}`),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await loadProdHandler(
      req(`/api/production/${AP_PROD}`, { session: userSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/production/[id] — happy path", () => {
  it("admin → 200 with state and versionId", async () => {
    const res = await loadProdHandler(
      req(`/api/production/${AP_PROD}`, { session: adminSession() }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { blocks: unknown[] }; versionId: string };
    expect(Array.isArray(body.state.blocks)).toBe(true);
    expect(body.state.blocks.length).toBeGreaterThan(0);
    expect(body.versionId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/script/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/script/[id] — auth guard", () => {
  it("no cookie → 401", async () => {
    const res = await getScriptHandler(
      req(`/api/script/${AP_PROD}`),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await getScriptHandler(
      req(`/api/script/${AP_PROD}`, { session: userSession() }),
      ctx({ id: AP_PROD }),
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
      req(`/api/script/${AP_PROD}`, { method: "PATCH" }),
      ctx({ id: AP_PROD }),
    );
    expect(res.status).toBe(401);
  });

  it("non-member non-admin → 403", async () => {
    const res = await patchScriptHandler(
      req(`/api/script/${AP_PROD}`, { method: "PATCH", body: "{}", session: userSession() }),
      ctx({ id: AP_PROD }),
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
    await createProduction(SCRIPT_PERM_PROD, "剧本权限测试演出", TEST_OWNER);
    await addProductionMember(SCRIPT_PERM_PROD, TEST_USER);
    scriptPermVersionId = (await getActiveVersionId(SCRIPT_PERM_PROD))!;
    // 批E2 行化：blocks@view 穿读门；comments@create 供下方评论测试（原 script:comment）
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'script', '*', 'blocks', 'view', 'direct'),
              ($1, $2, 'script', '*', 'comments', 'create', 'direct')
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false DO NOTHING`,
      [SCRIPT_PERM_PROD, TEST_USER],
    );
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
    expect(body.error).toMatch(/node:script/);
  });

  it("member without a script-editing role can publish a comment", async () => {
    const res = await createScriptCommentHandler(
      req(`/api/script/${SCRIPT_PERM_PROD}/comments`, {
        method: "POST",
        body: JSON.stringify({ blockId: "test-comment-block", body: "测试评论" }),
        session: userSession(),
      }),
      ctx({ id: SCRIPT_PERM_PROD }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comment: { body: string; userId: string } };
    expect(body.comment).toMatchObject({ body: "测试评论", userId: TEST_USER });
  });
});
