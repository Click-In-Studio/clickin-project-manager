import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy, loginNext } from "@/proxy";
import { loginDest, inviteTokenFromDest } from "@/app/login/LoginClient";

// 回归（#516）：proxy 层先于页面拦截无会话请求，重定向到 /login 时曾把 search
// 清空——目的地丢了。页面层 app/invite/[token]/page.tsx 自己写的
// redirect(`/login?next=/invite/<token>`) 因此从未被走到，受邀者登录页拿不到
// 邀请 token，只能被要邀请码。这里钉住：无会话访问 /invite/<token> 必须到达
// /login?next=/invite/<token>。

const TOKEN = "0f5c1e2a-7b3d-4c9e-8a1f-2d3e4f5a6b7c";

function redirectTarget(url: string, cookie?: string): URL | null {
  const req = new NextRequest(new URL(url, "https://app.example.com"), {
    headers: cookie ? { cookie } : {},
  });
  const res = proxy(req);
  const loc = res.headers.get("location");
  return loc ? new URL(loc) : null;
}

describe("proxy：无会话重定向到 /login 带回跳目标", () => {
  it("/invite/<token> → /login?next=/invite/<token>（登录页据此免邀请码）", () => {
    const target = redirectTarget(`/invite/${TOKEN}`);
    expect(target?.pathname).toBe("/login");
    expect(target?.searchParams.get("next")).toBe(`/invite/${TOKEN}`);
    // 与 LoginClient.inviteTokenFromDest 的正则同一口径
    expect(target?.searchParams.get("next")).toMatch(/^\/invite\/[0-9a-f-]{36}$/i);
  });

  it("普通页面深链接也保留 query", () => {
    const target = redirectTarget("/production/abc/tasks?tab=mine");
    expect(target?.pathname).toBe("/login");
    expect(target?.searchParams.get("next")).toBe("/production/abc/tasks?tab=mine");
  });

  it("根路径不带 next（回跳 / 与默认无异）", () => {
    const target = redirectTarget("/");
    expect(target?.pathname).toBe("/login");
    expect(target?.searchParams.has("next")).toBe(false);
  });

  it("有会话不重定向", () => {
    expect(redirectTarget(`/invite/${TOKEN}`, "sid=abc")).toBeNull();
  });

  it("公开前缀不重定向", () => {
    expect(redirectTarget("/login")).toBeNull();
    expect(redirectTarget("/api/auth/email/initiate")).toBeNull();
  });
});

// AI review 提出的疑点：目的地自带 ?/& 时，proxy 编码 → 登录页 loginDest 解码
// 这一往返是否无损。两端分别是 URLSearchParams.set / .get，本该对称，但这条
// 契约跨两个文件，值得钉住。
afterEach(() => vi.unstubAllGlobals());

describe("proxy → LoginClient 往返", () => {
  it("带 ?/& 的深链接经编码后被 loginDest 完整解回", () => {
    const target = redirectTarget("/production/abc/tasks?tab=mine&x=1");
    vi.stubGlobal("window", { location: { search: target!.search } });
    expect(loginDest()).toBe("/production/abc/tasks?tab=mine&x=1");
  });

  it("/invite/<token> 经往返后 inviteTokenFromDest 抠得出 token", () => {
    const target = redirectTarget(`/invite/${TOKEN}`);
    vi.stubGlobal("window", { location: { search: target!.search } });
    expect(inviteTokenFromDest()).toBe(TOKEN);
  });
});

describe("loginNext", () => {
  it("API 路径不作为回跳目标（浏览器不会导航到那里）", () => {
    expect(loginNext("/api/production/x", "")).toBeUndefined();
  });

  it("站内路径 + search 原样拼接", () => {
    expect(loginNext("/wiki/w1", "?v=2")).toBe("/wiki/w1?v=2");
  });
});
