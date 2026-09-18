import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { POST } from "@/app/api/bug-reports/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { listBugReports, countRecentBugReports, BUG_REPORT_HOURLY_LIMIT } from "@/lib/help/bug-report-db";

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
