import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { requestOrigin } from "@/lib/account/request-origin";

// #591：反代漏配 X-Forwarded-Proto 时 Next 会自己补 `http`，公网域名不能信这个头。

function req(headers: Record<string, string>, url = "http://127.0.0.1:3001/api/auth/feishu/initiate") {
  return new NextRequest(url, { headers });
}

describe("requestOrigin", () => {
  it("公网域名：即便 Next 补了 x-forwarded-proto=http 也拼成 https", () => {
    expect(requestOrigin(req({ host: "app.clickinmusical.com", "x-forwarded-proto": "http" })))
      .toBe("https://app.clickinmusical.com");
  });

  it("公网域名：x-forwarded-host 优先于 host，两个域都照请求来", () => {
    expect(requestOrigin(req({ host: "127.0.0.1:3001", "x-forwarded-host": "backstage.clickinmusical.com" })))
      .toBe("https://backstage.clickinmusical.com");
  });

  it("本机回环：照 x-forwarded-proto 来，缺头按明文", () => {
    expect(requestOrigin(req({ host: "localhost:3000", "x-forwarded-proto": "http" }))).toBe("http://localhost:3000");
    expect(requestOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(requestOrigin(req({ host: "127.0.0.1:3000", "x-forwarded-proto": "https" }))).toBe("https://127.0.0.1:3000");
  });

  it("没有任何 host 头：回落到请求自身 origin，不拼出 'https://' 这种非法 URL", () => {
    const origin = requestOrigin(req({}));
    expect(origin).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):3001$/);
    expect(() => new URL("/login", origin)).not.toThrow();
  });
});
