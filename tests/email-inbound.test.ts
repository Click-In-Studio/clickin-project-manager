import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/email-inbound/route";

const SECRET = "test-secret-32-bytes-xxxxxxxxxx";

const VALID_PAYLOAD = {
  from: "sender@example.com",
  to: "agent@clickinmusical.com",
  subject: "Test",
  text: "Hello",
  html: "<p>Hello</p>",
  messageId: "<abc@example.com>",
  inReplyTo: null,
  references: null,
};

function makeReq(body: unknown, authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/api/email-inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader !== undefined ? { Authorization: authHeader } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.EMAIL_INBOUND_SECRET = SECRET;
});

afterAll(() => {
  delete process.env.EMAIL_INBOUND_SECRET;
});

describe("POST /api/email-inbound", () => {
  it("rejects missing auth", async () => {
    const res = await POST(makeReq(VALID_PAYLOAD));
    expect(res.status).toBe(401);
  });

  it("rejects wrong secret", async () => {
    const res = await POST(makeReq(VALID_PAYLOAD, "Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects malformed json", async () => {
    const res = await POST(makeReq("not-json{{{", `Bearer ${SECRET}`));
    expect(res.status).toBe(400);
  });

  it("rejects payload missing required fields", async () => {
    const res = await POST(makeReq({ subject: "no from/to" }, `Bearer ${SECRET}`));
    expect(res.status).toBe(400);
  });

  it("accepts valid payload", async () => {
    const res = await POST(makeReq(VALID_PAYLOAD, `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
