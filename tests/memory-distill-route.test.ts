import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";

// /api/internal/memory-distill 的守卫与 happy path（distill 逻辑 mock，
// 管线本体的测试在 agent-memory.test.ts）。

vi.mock("@/lib/agent-memory/distill", () => ({
  distillAllUsers: vi.fn(async () => [
    { userId: "u1", status: "distilled", entries: 3 },
    { userId: "u2", status: "no-new-data" },
  ]),
}));

const SECRET = "test-internal-secret";
let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env.INTERNAL_NOTIFY_SECRET;
  process.env.INTERNAL_NOTIFY_SECRET = SECRET;
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.INTERNAL_NOTIFY_SECRET;
  else process.env.INTERNAL_NOTIFY_SECRET = savedSecret;
});

function makeReq(auth?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/memory-distill", {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
}

describe("POST /api/internal/memory-distill", () => {
  it("rejects missing/wrong auth", async () => {
    const { POST } = await import("@/app/api/internal/memory-distill/route");
    expect((await POST(makeReq())).status).toBe(401);
    expect((await POST(makeReq("Bearer wrong"))).status).toBe(401);
    expect((await POST(makeReq(`Bearer ${SECRET}x`))).status).toBe(401);
  });

  it("runs distillation with correct secret and returns summary", async () => {
    const { POST } = await import("@/app/api/internal/memory-distill/route");
    const res = await POST(makeReq(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { distilled: number; noNewData: number; errors: unknown[] } };
    expect(body.summary).toEqual({ distilled: 1, noNewData: 1, shrunk: 0, skipped: [], errors: [] });
  });
});
