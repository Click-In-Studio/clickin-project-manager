import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/agent/sessions/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";

// production 会话签发的守卫测试：sessionKey 由后端签发是隔离的根——
// 成员才发 production key，非成员 403，格式非法 400。

let memberId: string;
let outsiderId: string;
let prodId: string;

beforeAll(async () => {
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `签发甲${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `签发乙${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(memberId));
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

function makeReq(userId: string, body?: unknown): NextRequest {
  const cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  return new NextRequest("http://localhost/api/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body ?? {}),
  });
}

describe("POST /api/agent/sessions（production 签发）", () => {
  it("成员获得含 productionId 的 key", async () => {
    const res = await POST(makeReq(memberId, { productionId: prodId }));
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    expect(key).toContain(`:${prodId}:`);
    expect(key.startsWith(`clickin:chat:${memberId}:`)).toBe(true);
  });

  it("非成员 403", async () => {
    const res = await POST(makeReq(outsiderId, { productionId: prodId }));
    expect(res.status).toBe(403);
  });

  it("格式非法的 productionId 400", async () => {
    const res = await POST(makeReq(memberId, { productionId: "evil:inject" }));
    expect(res.status).toBe(400);
  });

  it("malformed JSON 是真 400，不会静默签发个人会话（#206 review 回归）", async () => {
    const cookie = `${SESSION_COOKIE}=${createSession({ userId: memberId, name: "测试", avatarUrl: null, isAdmin: false })}`;
    const res = await POST(
      new NextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("无 productionId 照常签发个人 key", async () => {
    const res = await POST(makeReq(memberId));
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    // 个人 key 只有 4 段：clickin:chat:<userId>:<uuid>
    expect(key.split(":").length).toBe(4);
  });
});
