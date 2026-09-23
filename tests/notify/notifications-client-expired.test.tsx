// @vitest-environment jsdom
//
// #658：待确认通知被新通知覆盖（expiredAt）后按钮灰掉，没人能再「处理」它。客户端若仍
// 按待确认算，它会永远留在「全部」「待确认」里、未读数也减不下去。这里钉的是退化口径：
// 失效 = 告知——读过即算完成，从「全部」和「待确认」消失、归到「已处理」。
// 反证：把 actMode 里的 expiredAt 分支去掉，三条都会红。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { UserNotification } from "@/lib/notify/inbox-db";

// 正文渲染与本测试无关（shiki 懒加载拖慢且不稳）
vi.mock("@/components/wiki/WikiMarkdown", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import MyNotificationsClient from "@/components/notify/MyNotificationsClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let notifications: UserNotification[] = [];
const fetchMock = vi.fn(() => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ notifications }),
}));

function notif(over: Partial<UserNotification>): UserNotification {
  return {
    id: "n1", userId: "u1", productionId: null, kind: "call_time",
    entityType: "call_time", entityId: "ct1", title: "标题", body: "",
    viewHref: null, category: "action", createdAt: "2026-09-23T00:00:00.000Z",
    readAt: null, actionRequired: true,
    actions: [{ id: "a1", presentation: "primary_button", label: "确认", effects: [{ type: "mark_acted" }] }],
    actedAt: null, actionResult: null, expiredAt: null, approvalRequestId: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockClear();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => { root.render(<MyNotificationsClient compact />); });
  await act(async () => { await Promise.resolve(); });
}

const tabButton = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent?.startsWith(label))!;
const titles = () => Array.from(container.querySelectorAll("article h3")).map((h) => h.textContent);

describe("MyNotificationsClient — 已失效的待确认（#658）", () => {
  it("失效且已读：不在「全部」「待确认」里，归到「已处理」并标「已读」", async () => {
    notifications = [notif({ title: "旧 Call", expiredAt: "2026-09-23T01:00:00.000Z", readAt: "2026-09-23T02:00:00.000Z" })];
    await mount();
    expect(titles()).toEqual([]);
    expect(tabButton("待确认").querySelector("span")).toBeNull();
    await act(async () => { tabButton("已处理").click(); });
    expect(titles()).toEqual(["旧 Call"]);
    expect(container.textContent).toContain("已读");
  });

  it("失效但未读：仍在「全部」里等人看，但不算待确认", async () => {
    notifications = [notif({ title: "旧 Call", expiredAt: "2026-09-23T01:00:00.000Z" })];
    await mount();
    expect(titles()).toEqual(["旧 Call"]);
    expect(container.textContent).toContain("1 条未读");
    expect(tabButton("待确认").querySelector("span")).toBeNull();
    expect(container.textContent).toContain("已失效");
  });

  it("未失效的待确认读过仍是待确认（口径没被一起放宽）", async () => {
    notifications = [notif({ title: "新 Call", readAt: "2026-09-23T02:00:00.000Z" })];
    await mount();
    expect(titles()).toEqual(["新 Call"]);
    expect(tabButton("待确认").querySelector("span")?.textContent).toBe("1");
  });
});
