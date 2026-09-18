import { describe, it, expect } from "vitest";
import { helpRouteCandidates, helpHrefFor } from "@/components/shell/app-shell/help-link";

// 「本页帮助」的 pathname → 手册路由键归一化（#538）。口径必须与 nav-config /
// 手册 frontmatter routes 一致：项目内相对 path、项目外绝对 path、动态段剔除。

const P = "p_abc123";
const INDEX: Record<string, string> = {
  "": "start/interface/navigation",
  "script": "creation/script/reading",
  "events": "production/events/events-overview",
  "events/callsheet": "production/events/publish-callsheet",
  "admin": "admin/overview/overview",
  "admin/roles": "admin/org/roles",
  "/my/tasks": "account/my/tasks",
  "/account": "account/profile/profile",
  "/": "start/interface/navigation",
};

describe("helpRouteCandidates", () => {
  it("项目内页给相对 path，由具体到泛", () => {
    expect(helpRouteCandidates(`/production/${P}/admin/roles`)).toEqual(["admin/roles", "admin"]);
    expect(helpRouteCandidates(`/production/${P}/script`)).toEqual(["script"]);
    expect(helpRouteCandidates(`/production/${P}`)).toEqual([""]);
  });
  it("动态段被剔除：事件详情下的 callsheet 归到 events/callsheet", () => {
    expect(helpRouteCandidates(`/production/${P}/events/ev_9f3k2a1b/callsheet`)).toEqual(["events/callsheet", "events"]);
    expect(helpRouteCandidates(`/production/${P}/wiki/0f3a2b7c-1d2e-4f5a-9b8c-7d6e5f4a3b2c`)).toEqual(["wiki"]);
    expect(helpRouteCandidates(`/production/demo-misty-harbor/tasks/12`)).toEqual(["tasks"]);
  });
  it("项目外页给绝对 path，逐级回退到 /", () => {
    expect(helpRouteCandidates("/my/daily-call/2026-09-04")).toEqual(["/my/daily-call/2026-09-04", "/my/daily-call", "/my", "/"]);
    expect(helpRouteCandidates("/")).toEqual(["/"]);
  });
});

describe("helpHrefFor", () => {
  it("命中最具体的一级", () => {
    expect(helpHrefFor(`/production/${P}/admin/roles`, INDEX)).toBe("/help/admin/org/roles");
    expect(helpHrefFor(`/production/${P}/events/ev_9f3k2a1b/callsheet`, INDEX)).toBe("/help/production/events/publish-callsheet");
  });
  it("具体级没有页时回退到上一级", () => {
    expect(helpHrefFor(`/production/${P}/admin/policies`, INDEX)).toBe("/help/admin/overview/overview");
    expect(helpHrefFor(`/production/${P}/events/ev_1/reqs/rq_2`, INDEX)).toBe("/help/production/events/events-overview");
  });
  it("完全没映射回手册首页", () => {
    expect(helpHrefFor("/unauthorized", INDEX)).toBe("/help/start/interface/navigation");
    expect(helpHrefFor("/unauthorized", {})).toBe("/help");
  });
});
