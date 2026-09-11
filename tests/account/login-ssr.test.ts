import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import LoginClient, { loginDest, inviteTokenFromDest } from "@/app/login/LoginClient";

// 回归：标了 "use client" 的组件在 SSR 阶段仍会在服务端渲染一次，渲染期读 window
// 就是 500。这类故障很隐蔽——Next 会降级到客户端渲染，页面看着完全正常，只有
// 服务端日志里每次访问堆一条 ReferenceError（PR #321 删掉 showForm 门后踩过）。
//
// vitest 跑在 environment: "node"，天然没有 window，正好等价于 SSR 环境。

describe("登录页 SSR 安全", () => {
  it("确认测试环境确实没有 window（否则本测试无意义）", () => {
    expect(typeof window).toBe("undefined");
  });

  it("服务端渲染不抛错 —— inviteOnly 关闭", () => {
    expect(() => renderToString(createElement(LoginClient, {}))).not.toThrow();
  });

  it("服务端渲染不抛错 —— inviteOnly 开启（会走到读 next 参数的分支）", () => {
    expect(() => renderToString(createElement(LoginClient, { inviteOnly: true }))).not.toThrow();
  });

  it("首帧渲染出的是真实表单，不是加载态占位", () => {
    // 双模式引入后首帧固定为登录态，邀请码属于注册态——这里只钉住「SSR 真的把
    // 表单渲染出来了」，模式相关的断言见下面的双模式用例。
    const html = renderToString(createElement(LoginClient, { inviteOnly: true }));
    expect(html).toContain("you@example.com");
  });
});

// AI review（#322）建议给 inviteTokenFromDest 也加一份 typeof window 守卫。这里不加：
// 它不直接碰 window，唯一路径是已守卫的 loginDest()。与其加一行永不生效的守卫，
// 不如用测试把这条依赖钉住——顺带补上 loginDest 的 open-redirect 防护覆盖，
// 那是条真实的安全边界，此前零测试。

afterEach(() => vi.unstubAllGlobals());

function withSearch(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

describe("loginDest / inviteTokenFromDest", () => {
  it("无 window（SSR）→ 站内默认目标，且不抛", () => {
    expect(typeof window).toBe("undefined");
    expect(loginDest()).toBe("/");
    expect(inviteTokenFromDest()).toBeUndefined();
  });

  it("站内相对路径原样返回", () => {
    withSearch("?next=%2Fproduction%2Fabc");
    expect(loginDest()).toBe("/production/abc");
  });

  it("open redirect 防护：协议相对 URL 被拒", () => {
    withSearch("?next=%2F%2Fevil.com");
    expect(loginDest()).toBe("/");
  });

  it("open redirect 防护：绝对 URL 被拒", () => {
    withSearch("?next=https%3A%2F%2Fevil.com");
    expect(loginDest()).toBe("/");
  });

  it("next 缺失 → 站内默认目标", () => {
    withSearch("");
    expect(loginDest()).toBe("/");
  });

  it("邀请链接落地时抠出 token", () => {
    const token = "0f8fad5b-d9cb-469f-a165-70867728950e";
    withSearch(`?next=%2Finvite%2F${token}`);
    expect(inviteTokenFromDest()).toBe(token);
  });

  it("非邀请路径不产出 token", () => {
    withSearch("?next=%2Fproduction%2Fabc");
    expect(inviteTokenFromDest()).toBeUndefined();
  });
});

describe("飞书授权入口带上注册凭据", () => {
  it("首帧是裸链接（SSR 与 hydrate 一致，凭据尚未从 URL 读出）", () => {
    const html = renderToString(createElement(LoginClient, { inviteOnly: true }));
    expect(html).toContain('href="/api/auth/feishu/initiate"');
  });
});

describe("登录/注册双模式", () => {
  // 首帧一律是登录态：localStorage 只能在 effect 里读，SSR 与客户端首帧必须一致。
  const firstFrame = (inviteOnly = true) =>
    renderToString(createElement(LoginClient, { inviteOnly }));

  it("首帧渲染出两个 tab", () => {
    const html = firstFrame();
    expect(html).toContain('role="tablist"');
    expect(html).toContain("登录");
    expect(html).toContain("注册");
  });

  it("首帧是登录态：不出姓名与邀请码，按钮文案为登录", () => {
    const html = firstFrame();
    expect(html).not.toContain("你的名字");
    expect(html).not.toContain("测试期间需受邀注册");
    expect(html).toContain("获取登录验证码");
    expect(html).toContain("使用飞书登录");
  });

  it("SSR 不读 localStorage（读了就会抛，因为 node 环境没有它）", () => {
    expect(typeof localStorage).toBe("undefined");
    expect(() => firstFrame()).not.toThrow();
  });
});
