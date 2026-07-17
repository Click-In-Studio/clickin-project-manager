/**
 * API race conditions and network fluctuation simulation.
 *
 * Three groups:
 *  1. Race conditions — general API (cue list abbr collision, concurrent renames)
 *  2. Script op concurrency — applyPatchToDB uses pg_advisory_xact_lock to
 *     serialise concurrent patches; both ops must survive and appear in final state.
 *  3. Network fluctuation — malformed bodies, at-least-once delivery documentation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  createProduction, deleteProduction, getActiveVersionId,
  addProductionMember, setMemberRoles,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { TEST_USER } from "./helpers";
import type { Block, ScriptState } from "@/lib/script-types";

// ── Route handlers ────────────────────────────────────────────────────────────
import { POST as createCueListHandler } from "@/app/api/production/[id]/cuelists/route";
import {
  PATCH as renameProdHandler,
  GET as getProdScriptHandler,
} from "@/app/api/production/[id]/route";
import {
  GET as getScriptHandler,
  PATCH as patchScriptHandler,
} from "@/app/api/script/[id]/route";
import { POST as createProductionHandler } from "@/app/api/productions/route";

// ── Helpers ────────────────────────────────────────────────────────────────────

function adminSession() {
  return createSession({ openId: TEST_USER, name: "测试管理员", avatarUrl: null, isAdmin: true });
}
/** Non-admin session for TEST_USER — relies on DB role membership for permissions. */
function memberSession() {
  return createSession({ openId: TEST_USER, name: "测试成员", avatarUrl: null, isAdmin: false });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

function stageBlock(id: string, content: string): Block {
  return {
    id, type: "stage", content,
    characterIds: [], characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null,
  };
}

// ── Test productions ──────────────────────────────────────────────────────────

const RACE_PROD   = "test-race-cuelist";   // cue list abbr collision
const RENAME_PROD = "test-race-rename";    // concurrent rename
const SCRIPT_PROD = "test-race-script";   // script op concurrency

let scriptVersionId = "";
const extraProds: string[] = []; // productions created inside tests

beforeAll(async () => {
  await Promise.all([
    createProduction(RACE_PROD, "竞态-走位表"),
    createProduction(RENAME_PROD, "竞态-重命名"),
    (async () => {
      await createProduction(SCRIPT_PROD, "竞态-剧本");
      // script:edit has adminBypass:false — user must hold 制作人 role
      await addProductionMember(SCRIPT_PROD, TEST_USER);
      await setMemberRoles(SCRIPT_PROD, TEST_USER, ["制作人"]);
      scriptVersionId = (await getActiveVersionId(SCRIPT_PROD))!;
    })(),
  ]);
});

afterAll(async () => {
  await Promise.all([
    deleteProduction(RACE_PROD).catch(() => {}),
    deleteProduction(RENAME_PROD).catch(() => {}),
    deleteProduction(SCRIPT_PROD).catch(() => {}),
    ...extraProds.map((id) => deleteProduction(id).catch(() => {})),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Race conditions — general API
// ─────────────────────────────────────────────────────────────────────────────

describe("race — cue list abbr uniqueness collision", () => {
  it("3 concurrent POSTs with same abbr: exactly 1×201 and 2×409", async () => {
    const body = (name: string) =>
      JSON.stringify({ name, abbr: "LX" });

    const results = await Promise.all([
      createCueListHandler(
        req(`/api/production/${RACE_PROD}/cuelists`, { method: "POST", body: body("灯光A"), session: adminSession() }),
        ctx({ id: RACE_PROD }),
      ),
      createCueListHandler(
        req(`/api/production/${RACE_PROD}/cuelists`, { method: "POST", body: body("灯光B"), session: adminSession() }),
        ctx({ id: RACE_PROD }),
      ),
      createCueListHandler(
        req(`/api/production/${RACE_PROD}/cuelists`, { method: "POST", body: body("灯光C"), session: adminSession() }),
        ctx({ id: RACE_PROD }),
      ),
    ]);

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
  });
});

describe("race — concurrent production renames", () => {
  it("2 concurrent renames both return 200, production remains accessible", async () => {
    const [r1, r2] = await Promise.all([
      renameProdHandler(
        req(`/api/production/${RENAME_PROD}`, { method: "PATCH", body: JSON.stringify({ name: "重命名结果A" }), session: adminSession() }),
        ctx({ id: RENAME_PROD }),
      ),
      renameProdHandler(
        req(`/api/production/${RENAME_PROD}`, { method: "PATCH", body: JSON.stringify({ name: "重命名结果B" }), session: adminSession() }),
        ctx({ id: RENAME_PROD }),
      ),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Production must still exist and hold one of the two expected names
    const row = await getPool().query<{ name: string }>(
      "SELECT name FROM production WHERE id = $1",
      [RENAME_PROD],
    );
    expect(["重命名结果A", "重命名结果B"]).toContain(row.rows[0].name);
  });
});

describe("race — concurrent POST /api/productions (server-generated IDs)", () => {
  it("3 concurrent creates all succeed with distinct IDs", async () => {
    const makeReq = (name: string) =>
      req("/api/productions", { method: "POST", body: JSON.stringify({ name }), session: adminSession() });

    const results = await Promise.all([
      createProductionHandler(makeReq("并发演出A")),
      createProductionHandler(makeReq("并发演出B")),
      createProductionHandler(makeReq("并发演出C")),
    ]);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ id: string }>));
    const ids = bodies.map((b) => b.id);

    results.forEach((r) => expect(r.status).toBe(201));
    expect(new Set(ids).size).toBe(3); // all distinct — server uid() prevents collisions
    ids.forEach((id) => extraProds.push(id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Script op concurrency — pg_advisory_xact_lock serialisation
// ─────────────────────────────────────────────────────────────────────────────

describe("script op concurrency — advisory lock ensures both patches survive", () => {
  const BLOCK_A = "race-block-aaaa";
  const BLOCK_B = "race-block-bbbb";

  it("2 concurrent block inserts both appear in final state", async () => {
    const patch = (blockId: string, content: string) =>
      JSON.stringify({
        clientSeq: 1,
        blockOps: [{ op: "insert", block: stageBlock(blockId, content), afterId: null }],
        charOps: [],
        sceneOps: [],
      });

    const url = `/api/script/${SCRIPT_PROD}?v=${scriptVersionId}`;

    const [r1, r2] = await Promise.all([
      patchScriptHandler(
        req(url, { method: "PATCH", body: patch(BLOCK_A, "竞态A内容"), session: memberSession() }),
        ctx({ id: SCRIPT_PROD }),
      ),
      patchScriptHandler(
        req(url, { method: "PATCH", body: patch(BLOCK_B, "竞态B内容"), session: memberSession() }),
        ctx({ id: SCRIPT_PROD }),
      ),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; serverSeq: number };
    const b2 = (await r2.json()) as { ok: boolean; serverSeq: number };
    expect(b1.ok).toBe(true);
    expect(b2.ok).toBe(true);
    // Server seqs must be distinct (each patch gets its own tick)
    expect(b1.serverSeq).not.toBe(b2.serverSeq);

    // Verify both blocks are persisted in the DB
    const state = await getScriptHandler(
      req(url, { session: memberSession() }),
      ctx({ id: SCRIPT_PROD }),
    );
    expect(state.status).toBe(200);
    const scriptState = (await state.json()) as ScriptState;
    const ids = scriptState.blocks.map((b) => b.id);
    expect(ids).toContain(BLOCK_A);
    expect(ids).toContain(BLOCK_B);
  });

  it("2 concurrent updates on the same block: last write wins, no crash", async () => {
    // After the previous test, BLOCK_A exists — update it from two clients simultaneously
    const patch = (content: string) =>
      JSON.stringify({
        clientSeq: 2,
        blockOps: [{ op: "update", block: stageBlock(BLOCK_A, content) }],
        charOps: [],
        sceneOps: [],
      });

    const url = `/api/script/${SCRIPT_PROD}?v=${scriptVersionId}`;

    const [r1, r2] = await Promise.all([
      patchScriptHandler(
        req(url, { method: "PATCH", body: patch("并发修改X"), session: memberSession() }),
        ctx({ id: SCRIPT_PROD }),
      ),
      patchScriptHandler(
        req(url, { method: "PATCH", body: patch("并发修改Y"), session: memberSession() }),
        ctx({ id: SCRIPT_PROD }),
      ),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Block must still exist; content is one of the two values (last write wins)
    const state = await getScriptHandler(
      req(url, { session: memberSession() }),
      ctx({ id: SCRIPT_PROD }),
    );
    const scriptState = (await state.json()) as ScriptState;
    const blockA = scriptState.blocks.find((b) => b.id === BLOCK_A);
    expect(blockA).not.toBeUndefined();
    expect(["并发修改X", "并发修改Y"]).toContain(blockA!.content);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Network fluctuation simulation
// ─────────────────────────────────────────────────────────────────────────────

describe("network fluctuation — malformed request bodies", () => {
  it("malformed JSON body: handler does not hang — throws or returns ≥400", async () => {
    const malformed = new NextRequest("http://localhost/api/productions", {
      method: "POST",
      body: "{ not valid json ]]]",
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${adminSession()}` }),
    });
    const status = await createProductionHandler(malformed)
      .then((r) => r.status)
      .catch(() => 500);
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("empty body (zero-byte, simulating connection reset): handler does not hang", async () => {
    const emptyBody = new NextRequest("http://localhost/api/productions", {
      method: "POST",
      body: null,
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${adminSession()}` }),
    });
    const status = await createProductionHandler(emptyBody)
      .then((r) => r.status)
      .catch(() => 500);
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("truncated JSON body: handler does not hang", async () => {
    const truncated = new NextRequest("http://localhost/api/productions", {
      method: "POST",
      body: '{"name": "未完成的',   // UTF-8 string cut mid-way
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${adminSession()}` }),
    });
    const status = await createProductionHandler(truncated)
      .then((r) => r.status)
      .catch(() => 500);
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("network fluctuation — retry / at-least-once delivery", () => {
  it("client retry: two POSTs with same name → two distinct productions (no server-side idempotency)", async () => {
    // Simulates: client sent request, didn't receive response, immediately retried.
    // Server generates a new ID each time → at-least-once semantics (by design).
    const makeReq = () =>
      req("/api/productions", {
        method: "POST",
        body: JSON.stringify({ name: "重试演出-相同名称" }),
        session: adminSession(),
      });

    const r1 = await createProductionHandler(makeReq());
    const r2 = await createProductionHandler(makeReq());
    const id1 = ((await r1.json()) as { id: string }).id;
    const id2 = ((await r2.json()) as { id: string }).id;

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(id1).not.toBe(id2); // distinct server-generated IDs confirm at-least-once
    extraProds.push(id1, id2);
  });

  it("concurrent reads during a write return consistent (not partial) state", async () => {
    // Fire a script write and two reads simultaneously.
    // All reads must return HTTP 200 with a valid ScriptState — no half-written view.
    const url = `/api/script/${SCRIPT_PROD}?v=${scriptVersionId}`;
    const writeReq = patchScriptHandler(
      req(url, {
        method: "PATCH",
        body: JSON.stringify({
          clientSeq: 3,
          blockOps: [{ op: "insert", block: stageBlock("race-block-cccc", "并发读写测试"), afterId: null }],
          charOps: [],
          sceneOps: [],
        }),
        session: memberSession(),
      }),
      ctx({ id: SCRIPT_PROD }),
    );
    const [writeRes, read1, read2] = await Promise.all([
      writeReq,
      getScriptHandler(req(url, { session: memberSession() }), ctx({ id: SCRIPT_PROD })),
      getScriptHandler(req(url, { session: memberSession() }), ctx({ id: SCRIPT_PROD })),
    ]);

    expect(writeRes.status).toBe(200);
    expect(read1.status).toBe(200);
    expect(read2.status).toBe(200);

    // Each read must return a valid ScriptState — no null, no partial JSON
    const s1 = (await read1.json()) as ScriptState;
    const s2 = (await read2.json()) as ScriptState;
    expect(Array.isArray(s1.blocks)).toBe(true);
    expect(Array.isArray(s2.blocks)).toBe(true);
  });
});
