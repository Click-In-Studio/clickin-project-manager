import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/agent/questions/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";

// ask_user 问题面的 guard 测试。行为（待答列表、路人/伪造 id 统一 404、回答落表）在
// tests/agent-runtime-routes.test.ts 里对着真表测；这里只测每条拒绝路径与协议形状。

const USER_ID = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const OWN_KEY = `clickin:chat:${USER_ID}:11111111-2222-3333-4444-555555555555`;
const FOREIGN_KEY = "clickin:chat:99999999-8888-7777-6666-555555555555:11111111-2222-3333-4444-555555555555";

function cookie(withAuth = true): Record<string, string> {
  return withAuth ? { Cookie: `${SESSION_COOKIE}=${createSession({ userId: USER_ID, name: "测试用户", avatarUrl: null, isAdmin: false })}` } : {};
}
function getReq(sessionKey?: string, withAuth = true): NextRequest {
  const url = new URL("http://localhost/api/agent/questions");
  if (sessionKey) url.searchParams.set("sessionKey", sessionKey);
  return new NextRequest(url, { headers: cookie(withAuth) });
}
function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/agent/questions", {
    method: "POST", headers: { "Content-Type": "application/json", ...cookie(withAuth) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/agent/questions", () => {
  it("未登录 401；缺 sessionKey 400；他人的会话 403", async () => {
    expect((await GET(getReq(OWN_KEY, false))).status).toBe(401);
    expect((await GET(getReq())).status).toBe(400);
    expect((await GET(getReq(FOREIGN_KEY))).status).toBe(403);
  });

  it("自己的会话（还没有任何问题）→ 空列表", async () => {
    const res = await GET(getReq(OWN_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ questions: [] });
  });
});

describe("POST /api/agent/questions", () => {
  it("未登录 401；坏 JSON / 缺 id / 缺 answers / answers 为空 → 400", async () => {
    expect((await POST(postReq({ id: "aq_x", answers: { q1: ["a"] } }, false))).status).toBe(401);
    expect((await POST(postReq("{not json"))).status).toBe(400);
    expect((await POST(postReq({ answers: { q1: ["a"] } }))).status).toBe(400);
    expect((await POST(postReq({ id: "aq_x" }))).status).toBe(400);
    expect((await POST(postReq({ id: "aq_x", answers: ["a"] }))).status).toBe(400);
    expect((await POST(postReq({ id: "aq_x", answers: { q1: [] } }))).status).toBe(400);
  });

  it("不存在的问题 id → 404（与归属他人同一状态码，不泄露存在性）", async () => {
    expect((await POST(postReq({ id: "aq_never", answers: { q1: ["a"] } }))).status).toBe(404);
    expect((await POST(postReq({ id: "aq_never", cancel: true }))).status).toBe(404);
  });
});
