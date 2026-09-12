// 个人中心「返回工作区」目标的纯函数测试。这个值来自用户可控的 ?from=，
// 校验一旦松掉就是开放式重定向，所以逃逸形状要逐个钉死。
import { describe, it, expect } from "vitest";
import { normalizeAccountReturnHref, WORKSPACE_HOME } from "@/lib/account-return";

describe("normalizeAccountReturnHref", () => {
  it("接受 AppShell 生成的项目首页，并去掉尾斜杠", () => {
    expect(normalizeAccountReturnHref("/production/abc123xy")).toBe("/production/abc123xy");
    expect(normalizeAccountReturnHref("/production/abc123xy/")).toBe("/production/abc123xy");
    // 存量 UUID 项目 id
    expect(normalizeAccountReturnHref("/production/0f8c1e2a-4b5d-4c7e-9a10-2b3c4d5e6f70"))
      .toBe("/production/0f8c1e2a-4b5d-4c7e-9a10-2b3c4d5e6f70");
  });

  it("拒绝站外地址——放行任何一条都是开放式重定向", () => {
    expect(normalizeAccountReturnHref("https://evil.example/production/x")).toBeNull();
    expect(normalizeAccountReturnHref("//evil.example")).toBeNull();
    expect(normalizeAccountReturnHref("//evil.example/production/x")).toBeNull();
    expect(normalizeAccountReturnHref("http:/production/x")).toBeNull();
    expect(normalizeAccountReturnHref("javascript:alert(1)")).toBeNull();
    expect(normalizeAccountReturnHref("/\\evil.example")).toBeNull();
  });

  it("拒绝项目首页以外的站内路径——from 不是通用跳转参数", () => {
    expect(normalizeAccountReturnHref("/")).toBeNull();
    expect(normalizeAccountReturnHref("/login")).toBeNull();
    expect(normalizeAccountReturnHref("/production")).toBeNull();
    expect(normalizeAccountReturnHref("/production/")).toBeNull();
    // 深层页面不放行：多一段就多一类需要判权限的目标，且 AppShell 也不会生成
    expect(normalizeAccountReturnHref("/production/abc123xy/admin/permissions")).toBeNull();
    // 带 query / fragment 的形状会绕开「只是项目首页」这个前提
    expect(normalizeAccountReturnHref("/production/abc?x=1")).toBeNull();
    expect(normalizeAccountReturnHref("/production/abc#f")).toBeNull();
  });

  it("空值一律 null，由调用方兜底到工作区首页", () => {
    expect(normalizeAccountReturnHref(null)).toBeNull();
    expect(normalizeAccountReturnHref(undefined)).toBeNull();
    expect(normalizeAccountReturnHref("")).toBeNull();
    expect(WORKSPACE_HOME).toBe("/");
  });
});
