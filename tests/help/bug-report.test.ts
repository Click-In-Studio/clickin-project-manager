import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getPool } from "@/lib/pg";

// 外部边界（Resend）打桩：本地 .env.local 有真 key，不桩会真发到 dev@。断言调用参数，
// 邮件内容与 reply-to 的接线在这里盯住。
const sendEmail = vi.fn(async () => {});
vi.mock("@/lib/platform/email/email-send", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

import { POST } from "@/app/api/bug-reports/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { listBugReports, countRecentBugReports, BUG_REPORT_HOURLY_LIMIT, BUG_REPORT_INBOX } from "@/lib/help/bug-report-db";

// 「报告问题」（#538）：只收登录用户、限频、上下文里的 production_id 要核 FK。

let prodId = "";
let userId = "";

function req(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "vitest/1.0" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/bug-reports", { method: "POST", headers, body: JSON.stringify(body) });
}
// route 签名要 NextRequest（用到 .cookies）；用 NextRequest 包一层
async function post(body: unknown, cookie?: string) {
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest(req(body, cookie)));
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const { rows } = await getPool().query<{ owner_id: string }>("SELECT owner_id FROM production WHERE id = $1", [prodId]);
  userId = rows[0].owner_id;
});
afterAll(async () => {
  await getPool().query("DELETE FROM bug_report WHERE user_id = $1", [userId]);
  await cleanupProduction(prodId).catch(() => {});
});

const cookieFor = (uid: string) => `${SESSION_COOKIE}=${createSession({ userId: uid, name: "测试", avatarUrl: null, isAdmin: false })}`;

describe("POST /api/bug-reports", () => {
  it("未登录 401", async () => {
    const res = await post({ body: "x", pagePath: "/" });
    expect(res.status).toBe(401);
  });

  it("空正文 400", async () => {
    const res = await post({ body: "   ", pagePath: "/" }, cookieFor(userId));
    expect(res.status).toBe(400);
  });

  it("落库带上下文；不存在的 production_id 记 NULL 而不是整条失败", async () => {
    const res = await post({
      kind: "manual", body: "这一页写的和实际不一样", contact: "飞书找我",
      pagePath: `/production/${prodId}/script`, manualSlug: "creation/script/reading",
      productionId: prodId, viewport: "1440x900",
    }, cookieFor(userId));
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    expect(id).toMatch(/^br_/);

    const res2 = await post({ body: "项目 id 是瞎写的", pagePath: "/production/nope/x", productionId: "nope" }, cookieFor(userId));
    expect(res2.status).toBe(200);

    // 落库后抄一封到反馈邮箱（fire-and-forget，等一拍）；联系方式不是邮箱时不设 reply-to
    await new Promise((r) => setTimeout(r, 50));
    const mails = sendEmail.mock.calls.map((c) => c[0] as { to: string; subject: string; text: string; replyTo?: string });
    const m = mails.find((x) => x.text.includes("这一页写的和实际不一样"))!;
    expect(m.to).toBe(BUG_REPORT_INBOX);
    expect(m.subject).toContain("手册写得不对");
    expect(m.text).toContain("creation/script/reading");
    expect(m.replyTo).toBeUndefined();

    const rows = await listBugReports({ status: "new", limit: 500 });
    const mine = rows.filter((r) => r.userId === userId);
    const a = mine.find((r) => r.manualSlug === "creation/script/reading")!;
    expect(a.kind).toBe("manual");
    expect(a.productionId).toBe(prodId);
    expect(a.userAgent).toBe("vitest/1.0");
    expect(a.viewport).toBe("1440x900");
    const b = mine.find((r) => r.pagePath === "/production/nope/x")!;
    expect(b.productionId).toBeNull();
    expect(b.kind).toBe("bug");
  });

  it("联系方式是邮箱时设为 reply-to；邮件失败不影响落库", async () => {
    sendEmail.mockImplementationOnce(async () => { throw new Error("resend down"); });
    const r1 = await post({ body: "邮件挂了也要落库", pagePath: "/", contact: "who@example.com" }, cookieFor(userId));
    expect(r1.status).toBe(200);
    const r2 = await post({ body: "带邮箱联系方式", pagePath: "/", contact: "who@example.com" }, cookieFor(userId));
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const last = sendEmail.mock.calls.at(-1)![0] as { replyTo?: string };
    expect(last.replyTo).toBe("who@example.com");
    const rows = await listBugReports({ status: "new", limit: 500 });
    expect(rows.some((r) => r.userId === userId && r.body === "邮件挂了也要落库")).toBe(true);
  });

  it("每人每小时限频", async () => {
    const already = await countRecentBugReports(userId);
    for (let i = already; i < BUG_REPORT_HOURLY_LIMIT; i++) {
      const r = await post({ body: `填充 ${i}`, pagePath: "/" }, cookieFor(userId));
      expect(r.status).toBe(200);
    }
    const res = await post({ body: "第 N+1 条", pagePath: "/" }, cookieFor(userId));
    expect(res.status).toBe(429);
  });
});
