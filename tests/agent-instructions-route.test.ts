import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/agent/instructions/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { upsertFeishuUser } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// /api/agent/instructions 的 guard + 行为测试。制作级权限：owner 直通
// （canAccessNode 第 1 步旁路），非成员无任何资格源 → 403；「他人的内容
// 不回显」由 GET 的 canEdit 门保证。

let ownerId: string;
let outsiderId: string;
let prodId: string;

function makeReq(method: "GET" | "PUT", opts: { userId?: string; query?: string; body?: unknown } = {}): NextRequest {
  const cookie = opts.userId
    ? `${SESSION_COOKIE}=${createSession({ userId: opts.userId, name: "测试", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest(`http://localhost/api/agent/instructions${opts.query ?? ""}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeAll(async () => {
  ({ userId: ownerId } = await upsertFeishuUser(`test-open-${shortId()}`, `owner-${shortId()}`, null, false));
  ({ userId: outsiderId } = await upsertFeishuUser(`test-open-${shortId()}`, `路人-${shortId()}`, null, false));
  ({ prodId } = await makeProduction(ownerId));
});

afterAll(async () => {
  await getPool().query(`DELETE FROM agent_instructions WHERE scope_id IN ($1, $2, $3)`, [ownerId, outsiderId, prodId]);
  await cleanupProduction(prodId).catch(() => {});
});

describe("GET /api/agent/instructions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
  });

  it("returns own user-scope content without productionId", async () => {
    await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "user", content: "我的偏好" } }));
    const res = await GET(makeReq("GET", { userId: ownerId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "我的偏好" });
  });

  it("owner sees production content with canEdit true", async () => {
    await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "production", productionId: prodId, content: "制作口径" } }));
    const res = await GET(makeReq("GET", { userId: ownerId, query: `?productionId=${prodId}` }));
    const body = (await res.json()) as { production?: { content: string | null; canEdit: boolean } };
    expect(body.production).toEqual({ content: "制作口径", canEdit: true });
  });

  it("non-member gets canEdit false and NO content", async () => {
    const res = await GET(makeReq("GET", { userId: outsiderId, query: `?productionId=${prodId}` }));
    const body = (await res.json()) as { production?: { content: string | null; canEdit: boolean } };
    expect(body.production).toEqual({ content: null, canEdit: false });
  });
});

describe("PUT /api/agent/instructions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await PUT(makeReq("PUT", { body: { scope: "user", content: "x" } }));
    expect(res.status).toBe(401);
  });

  it("rejects invalid scope / missing content / over-length with 400", async () => {
    expect((await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "system", content: "x" } }))).status).toBe(400);
    expect((await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "user" } }))).status).toBe(400);
    expect(
      (await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "user", content: "x".repeat(4001) } }))).status,
    ).toBe(400);
    expect(
      (await PUT(makeReq("PUT", { userId: ownerId, body: { scope: "production", content: "x" } }))).status,
    ).toBe(400); // 缺 productionId
  });

  it("user scope writes only to the session user's own row", async () => {
    const res = await PUT(makeReq("PUT", { userId: outsiderId, body: { scope: "user", content: "路人的偏好" } }));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query(
      `SELECT scope_id FROM agent_instructions WHERE scope_type = 'user' AND content = '路人的偏好'`,
    );
    expect(rows.map((r) => r.scope_id)).toEqual([outsiderId]);
  });

  it("production scope: non-member is refused with 403", async () => {
    const res = await PUT(
      makeReq("PUT", { userId: outsiderId, body: { scope: "production", productionId: prodId, content: "越权写入" } }),
    );
    expect(res.status).toBe(403);
    expect(await import("@/lib/agent-instructions").then((m) => m.getAgentInstructions("production", prodId))).not.toBe(
      "越权写入",
    );
  });

  it("production scope: owner writes successfully (canAccessNode owner bypass)", async () => {
    const res = await PUT(
      makeReq("PUT", { userId: ownerId, body: { scope: "production", productionId: prodId, content: "新口径" } }),
    );
    expect(res.status).toBe(200);
    expect(await import("@/lib/agent-instructions").then((m) => m.getAgentInstructions("production", prodId))).toBe(
      "新口径",
    );
  });
});
