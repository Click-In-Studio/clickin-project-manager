import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pg", () => ({
  getPool: () => ({ query }),
}));

import { GET } from "@/app/health/route";
import { proxy } from "@/proxy";

describe("Web 健康检查", () => {
  const secret = "health-test-secret";
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.INTERNAL_NOTIFY_SECRET;
    process.env.INTERNAL_NOTIFY_SECRET = secret;
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.INTERNAL_NOTIFY_SECRET;
    else process.env.INTERNAL_NOTIFY_SECRET = savedSecret;
  });
  beforeEach(() => query.mockReset());

  function request(authorization?: string) {
    const req = new NextRequest("http://localhost/health", {
      headers: authorization ? { Authorization: authorization } : {},
    });
    const response = proxy(req);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    return req;
  }

  it("只放行精确健康路径，其他同名前缀仍需登录", () => {
    for (const pathname of ["/health-extra", "/health/private"]) {
      const response = proxy(new NextRequest(`http://localhost${pathname}`));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    }
  });

  it("拒绝没有内部密钥的请求", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("数据库可读时返回 200", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const response = await GET(request(`Bearer ${secret}`));

    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("数据库不可读时失败关闭", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });
});
