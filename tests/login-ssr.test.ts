import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import LoginClient from "@/app/login/LoginClient";

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

  it("首帧渲染出邀请码输入框（服务端拿不到 next，与客户端首帧一致，不 hydration mismatch）", () => {
    const html = renderToString(createElement(LoginClient, { inviteOnly: true }));
    expect(html).toContain("邀请码");
  });
});
