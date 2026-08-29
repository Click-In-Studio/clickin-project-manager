import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/agent/approval/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";

// Guard-layer tests for the plugin-approval resolve endpoint. The happy path
// (an actual approval.resolve RPC) needs a live gateway + a pending approval
// broadcast, so it belongs to the Phase 4 live validation checklist, not unit
// tests — everything up to that RPC call is covered here.

const USER_ID = "0b6ab930-e2aa-4020-8334-d749d7be82a5";

function makeReq(body: unknown, withAuth = true): NextRequest {
  const cookie = withAuth
    ? `${SESSION_COOKIE}=${createSession({ userId: USER_ID, name: "测试用户", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest("http://localhost/api/agent/approval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/agent/approval", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await POST(makeReq({ id: "x", decision: "allow-once" }, false));
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(makeReq("{not json"));
    expect(res.status).toBe(400);
  });

  it("rejects missing id with 400", async () => {
    const res = await POST(makeReq({ decision: "allow-once" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid decision with 400", async () => {
    const res = await POST(makeReq({ id: "some-approval", decision: "yes-please" }));
    expect(res.status).toBe(400);
  });

  // allow-always 曾是预留字面量：接口收、按 allow-once 落库、前端从来没有那个按钮。
  // 摘掉后接口也不再收——半实现的"始终允许"比没有更糟。
  it("rejects allow-always with 400（未实现的决议不进接口）", async () => {
    const res = await POST(makeReq({ id: "some-approval", decision: "allow-always" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 for an unknown approval id (no existence leak)", async () => {
    const res = await POST(makeReq({ id: "never-seen-approval", decision: "deny" }));
    expect(res.status).toBe(403);
  });

  it("rejects over-long deny reason with 400", async () => {
    const res = await POST(makeReq({ id: "x", decision: "deny", reason: "长".repeat(501) }));
    expect(res.status).toBe(400);
  });

  it("rejects non-string reason with 400", async () => {
    const res = await POST(makeReq({ id: "x", decision: "deny", reason: 123 }));
    expect(res.status).toBe(400);
  });
});
