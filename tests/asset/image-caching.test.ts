/**
 * 图片显示优化（缓存链路）的纯逻辑测试：
 * - presignedGet cacheWindow：同一窗口内 URL 字节级稳定（浏览器缓存的前提），
 *   跨窗口 URL 变化，且有效期放宽为 2×窗口
 * - avatar-url helper：R2 key / http 外链 / null 三态、?v= 随存量值变化
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { presignedGet } from "@/lib/r2";
import { userAvatarSrc, productionAvatarSrc } from "@/lib/asset/avatar-url";

afterEach(() => {
  vi.useRealTimers();
});

describe("presignedGet cacheWindow", () => {
  it("同一窗口内多次生成的 URL 完全相同", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T08:10:00Z"));
    const a = presignedGet("assets/x/y.png", 3600, { cacheWindow: 3600 });
    vi.setSystemTime(new Date("2026-09-04T08:55:00Z"));
    const b = presignedGet("assets/x/y.png", 3600, { cacheWindow: 3600 });
    expect(a).toBe(b);
  });

  it("跨窗口 URL 变化", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T08:55:00Z"));
    const a = presignedGet("assets/x/y.png", 3600, { cacheWindow: 3600 });
    vi.setSystemTime(new Date("2026-09-04T09:05:00Z"));
    const b = presignedGet("assets/x/y.png", 3600, { cacheWindow: 3600 });
    expect(a).not.toBe(b);
  });

  it("有效期放宽为 2×窗口，窗口末尾拿到的 URL 仍够用", () => {
    const url = new URL(presignedGet("assets/x/y.png", 3600, { cacheWindow: 3600 }));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
  });

  it("不传 cacheWindow 时行为不变（expiresIn 生效）", () => {
    const url = new URL(presignedGet("assets/x/y.png", 900));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("cacheControl 透传为 response-cache-control 并参与签名", () => {
    const url = new URL(presignedGet("assets/x/y.png", 3600, { cacheControl: "private, max-age=3600" }));
    expect(url.searchParams.get("response-cache-control")).toBe("private, max-age=3600");
  });

  // #679：上一条用 searchParams.get 读，"+" 和 "%20" 都解成空格，是假绿。
  // SigV4 规范查询串要求空格编成 %20；URLSearchParams 编成 "+"，R2 重算签名
  // 时按 %20 走，整条 URL 直接 SignatureDoesNotMatch——预览 PDF / 图片 / 视频全挂。
  it("查询串按 RFC 3986 编码：空格是 %20 不是 +（否则 R2 报 SignatureDoesNotMatch）", () => {
    const url = presignedGet("assets/x/y.pdf", 3600, {
      inline: true,
      contentType: "application/pdf",
      cacheWindow: 3600,
      cacheControl: "private, max-age=3600",
    });
    const query = url.split("?")[1];
    expect(query).toContain("response-cache-control=private%2C%20max-age%3D3600");
    expect(query).not.toContain("+");
  });
});

describe("avatar-url helpers", () => {
  it("R2 key → 代理路由，带 v 和 s 参数", () => {
    const src = userAvatarSrc("u1", "avatars/u1/avatar-abc123");
    expect(src).toMatch(/^\/api\/user\/avatar\/u1\?v=[a-z0-9]+&s=128$/);
  });

  it("key 变则 v 变（换头像即换 URL，immutable 缓存的前提）", () => {
    const a = userAvatarSrc("u1", "avatars/u1/avatar-aaa");
    const b = userAvatarSrc("u1", "avatars/u1/avatar-bbb");
    expect(a).not.toBe(b);
  });

  it("http 外链直接返回，null 返回 null", () => {
    expect(userAvatarSrc("u1", "https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(userAvatarSrc("u1", null)).toBeNull();
  });

  it("演出头像同款语义，size 可选 512", () => {
    const src = productionAvatarSrc("p1", "avatars/production/p1/avatar-xyz", 512);
    expect(src).toMatch(/^\/api\/production\/p1\/avatar\?v=[a-z0-9]+&s=512$/);
    expect(productionAvatarSrc("p1", null)).toBeNull();
  });
});
