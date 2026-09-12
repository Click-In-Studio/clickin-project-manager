import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/agent/chat/stream/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";

// Guard + contract tests for the chat stream endpoint. 真流式的 happy path 在
// tests/agent-runtime-routes.test.ts；这里只测每条拒绝路径与 steer 契约: steer:true must answer
// with plain JSON — never a stream — even on failure. (Returning an unread
// stream per steer exhausted the browser connection pool in production.)

const USER_ID = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const OWN_KEY = `clickin:chat:${USER_ID}:11111111-2222-3333-4444-555555555555`;
const FOREIGN_KEY = "clickin:chat:99999999-8888-7777-6666-555555555555:11111111-2222-3333-4444-555555555555";

function makeReq(body: unknown, withAuth = true): NextRequest {
  const cookie = withAuth
    ? `${SESSION_COOKIE}=${createSession({ userId: USER_ID, name: "测试用户", avatarUrl: null, isAdmin: false })}`
    : "";
  return new NextRequest("http://localhost/api/agent/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/agent/chat/stream", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await POST(makeReq({ sessionKey: OWN_KEY, message: "hi" }, false));
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(makeReq("{not json"));
    expect(res.status).toBe(400);
  });

  it("rejects missing message with 400", async () => {
    const res = await POST(makeReq({ sessionKey: OWN_KEY }));
    expect(res.status).toBe(400);
  });

  it("rejects missing sessionKey with 400", async () => {
    const res = await POST(makeReq({ message: "hi" }));
    expect(res.status).toBe(400);
  });

  it("rejects over-long message with 400", async () => {
    const res = await POST(makeReq({ sessionKey: OWN_KEY, message: "x".repeat(16_001) }));
    expect(res.status).toBe(400);
  });

  it("rejects another user's session with 403", async () => {
    const res = await POST(makeReq({ sessionKey: FOREIGN_KEY, message: "hi" }));
    expect(res.status).toBe(403);
  });

  it("steer:true answers with JSON, never a stream", async () => {
    // 该会话没有进行中的 run，steer 必然失败（409）——失败也必须是 JSON 错误响应
    // （老代码对失败的 steer 也回一条没人读的流）。
    const res = await POST(makeReq({ sessionKey: OWN_KEY, message: "hi", steer: true }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});
