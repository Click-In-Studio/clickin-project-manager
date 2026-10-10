// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCenterItem, ApprovalCenterPage } from "@/lib/approval/approval-center-types";

import ApprovalCenterClient from "@/components/approval/ApprovalCenterClient";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PendingRequest = {
  url: string;
  init?: RequestInit;
  resolve: (response: unknown) => void;
};

const pendingRequests: PendingRequest[] = [];
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
let container: HTMLDivElement;
let root: Root;

function item(id: string, title: string): ApprovalCenterItem {
  return {
    id: `expense:${id}`,
    sourceId: id,
    source: "expense",
    businessType: "expense",
    applicant: { id: "user_1", name: "申请人" },
    title,
    note: null,
    status: "rejected",
    sourceStatus: "rejected",
    canFinalizeForViewer: false,
    createdAt: "2026-10-02T08:00:00.000Z",
    resolvedAt: "2026-10-02T09:00:00.000Z",
    detail: {
      kind: "expense",
      categoryId: null,
      categoryName: null,
      amount: "100.00",
      currency: "CNY",
    },
  };
}

function page(items: ApprovalCenterItem[] = []): ApprovalCenterPage {
  return {
    items,
    total: items.length,
    viewCounts: { pending: 0, processed: 0, cc: 0, submitted: 0 },
    businessTypeCounts: { resource_access: 0, expense: items.length },
    nextCursor: null,
  };
}

async function resolveRequest(request: PendingRequest, body: unknown = page()) {
  await act(async () => {
    request.resolve({ ok: true, json: () => Promise.resolve(body) });
    await Promise.resolve();
  });
}

function queueButton(label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.startsWith(label));
}

function selectFor(label: string) {
  const wrapper = Array.from(container.querySelectorAll<HTMLLabelElement>("label"))
    .find(element => element.textContent?.startsWith(label));
  return wrapper?.querySelector<HTMLSelectElement>("select") ?? null;
}

async function changeSelect(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(async () => {
  pendingRequests.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url, init) => new Promise(resolve => {
    pendingRequests.push({ url, init, resolve });
  }));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ApprovalCenterClient productionId="prod_1" actorId="user_1" archived={false} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("审批中心筛选状态", () => {
  it("手机筛选继续使用视口内的自定义下拉菜单", async () => {
    const queueNav = container.querySelector<HTMLElement>('nav[aria-label="选择审批队列"]');
    await act(async () => { queueNav?.querySelector<HTMLButtonElement>("button")?.click(); });

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 319 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const timeTriggers = container.querySelectorAll<HTMLButtonElement>('[role="combobox"][aria-label="时间筛选"]');
    const trigger = timeTriggers.item(timeTriggers.length - 1);
    Object.defineProperty(trigger, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 12, right: 96, top: 120, bottom: 148, width: 84, height: 28, x: 12, y: 120, toJSON: () => ({}) }),
    });

    await act(async () => { trigger.click(); });
    const menu = document.body.querySelector<HTMLElement>('[data-overflow-safe-select-menu][aria-label="时间筛选"]');
    expect(menu).not.toBeNull();
    expect(Number.parseFloat(menu!.style.left)).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(menu!.style.left) + Number.parseFloat(menu!.style.width)).toBeLessThanOrEqual(309);

    const option = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find(button => button.textContent?.includes("近 7 天"));
    await act(async () => { option?.click(); });
    expect(document.body.querySelector('[data-overflow-safe-select-menu][aria-label="时间筛选"]')).toBeNull();
    expect(trigger.parentElement?.querySelector("select")?.value).toBe("7d");
  });

  it("各队列使用自己的默认排序并保留各自的手动选择", async () => {
    expect(pendingRequests[0].url).toContain("view=pending");
    expect(pendingRequests[0].url).toContain("sort=oldest");
    await resolveRequest(pendingRequests[0]);

    await act(async () => { queueButton("我已处理")?.click(); });
    expect(pendingRequests[1].url).toContain("view=processed");
    expect(pendingRequests[1].url).toContain("sort=newest");
    await resolveRequest(pendingRequests[1]);

    await changeSelect(selectFor("排序")!, "oldest");
    expect(pendingRequests[2].url).toContain("view=processed");
    expect(pendingRequests[2].url).toContain("sort=oldest");
    await resolveRequest(pendingRequests[2]);

    await act(async () => { queueButton("待我处理")?.click(); });
    expect(pendingRequests[3].url).toContain("view=pending");
    expect(pendingRequests[3].url).toContain("sort=oldest");
    await resolveRequest(pendingRequests[3]);

    await act(async () => { queueButton("我已处理")?.click(); });
    expect(pendingRequests[4].url).toContain("view=processed");
    expect(pendingRequests[4].url).toContain("sort=oldest");
  });

  it("旧请求晚到时不会覆盖当前筛选结果", async () => {
    await resolveRequest(pendingRequests[0]);

    await changeSelect(selectFor("状态")!, "approved");
    const approvedRequest = pendingRequests[1];
    expect(approvedRequest.url).toContain("status=approved");

    await changeSelect(selectFor("状态")!, "rejected");
    const rejectedRequest = pendingRequests[2];
    expect(rejectedRequest.url).toContain("status=rejected");

    await resolveRequest(rejectedRequest, page([item("new", "当前筛选结果")]));
    expect(container.textContent).toContain("当前筛选结果");

    await resolveRequest(approvedRequest, page([item("old", "过期请求结果")]));
    expect(container.textContent).toContain("当前筛选结果");
    expect(container.textContent).not.toContain("过期请求结果");
  });
});


function listButtons() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="审批列表"] > button'));
}

function moreButton() {
  return container.querySelector<HTMLButtonElement>('[aria-label="审批列表分页"] button')!;
}

function paged(items: ApprovalCenterItem[], nextCursor: string | null): ApprovalCenterPage {
  return {
    ...page(items), nextCursor,
    viewCounts: { pending: 101, processed: 0, cc: 0, submitted: 0 },
    businessTypeCounts: { expense: 101, resource_access: 0 },
  };
}

describe("审批中心游标分页", () => {
  it("进入手机列表沿用桌面已加载记录与游标", async () => {
    await resolveRequest(pendingRequests[0], paged([item("first", "已有记录")], "shared-cursor"));
    const nav = container.querySelector<HTMLElement>('nav[aria-label="选择审批队列"]')!;
    await act(async () => { nav.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(pendingRequests).toHaveLength(1);
    const pagers = container.querySelectorAll<HTMLElement>('[aria-label="审批列表分页"]');
    expect(pagers).toHaveLength(2);
    await act(async () => { pagers[1].querySelector<HTMLButtonElement>("button")!.click(); });
    expect(new URL(pendingRequests[1].url, "http://localhost").searchParams.get("cursor")).toBe("shared-cursor");
    await resolveRequest(pendingRequests[1], { ...paged([item("next", "续页记录")], null),
      viewCounts: { pending: 2, processed: 0, cc: 0, submitted: 0 } });
    for (const pager of container.querySelectorAll('[aria-label="审批列表分页"]')) {
      expect(pager.textContent).toContain("已加载 2 / 共 2 条");
      expect(pager.textContent).toContain("已全部加载");
    }
  });

  it("续页去重追加，第 101 条可打开真实业务详情，末页停止请求", async () => {
    const first = Array.from({ length: 100 }, (_, i) => item(String(i), `审批记录 ${i}`));
    await resolveRequest(pendingRequests[0], paged(first, "cursor-100"));
    expect(container.textContent).toContain("已加载 100 / 共 101 条");
    await act(async () => { moreButton().click(); moreButton().click(); });
    expect(pendingRequests).toHaveLength(2);
    expect(new URL(pendingRequests[1].url, "http://localhost").searchParams.get("cursor")).toBe("cursor-100");
    expect(listButtons()).toHaveLength(100);
    expect(moreButton().disabled).toBe(true);
    await resolveRequest(pendingRequests[1], paged([first[99], item("100", "第 101 条审批")], null));
    expect(listButtons()).toHaveLength(101);
    expect(container.textContent).toContain("已加载 101 / 共 101 条");
    expect(container.textContent).toContain("已全部加载");
    expect(moreButton()).toBeNull();
    await act(async () => { listButtons().find(button => button.textContent?.includes("第 101 条审批"))!.click(); });
    expect(pendingRequests[2].url).toContain("/finance/expenses/100");
    await resolveRequest(pendingRequests[2], {
      expense: { id: "100", title: "第 101 条真实详情", status: "pending", currentApproverIds: ["user_1"],
      amount: "100", currency: "CNY", events: [], documents: [], canFinalize: true, mutationSeq: 0 },
    });
    expect(container.textContent).toContain("第 101 条真实详情");
    expect(container.textContent).toContain("批准");
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "批准")!.click();
    });
    expect(pendingRequests[3].url).toContain("/finance/expenses/100");
    expect(pendingRequests[3].init?.method).toBe("POST");
    expect(JSON.parse(pendingRequests[3].init?.body as string)).toMatchObject({ action: "approve", expectedMutationSeq: 0 });
    await resolveRequest(pendingRequests[3], { ok: true });
    const refresh = pendingRequests.find((request, index) => index > 3 && request.url.includes("/approval-items?"))!;
    expect(new URL(refresh.url, "http://localhost").searchParams.has("cursor")).toBe(false);
    expect(container.textContent).not.toContain("第 101 条审批");
  });

  it("续页失败保留列表和游标，重试同一页；首批失败也能重试", async () => {
    await act(async () => {
      pendingRequests[0].resolve({ ok: false, json: async () => ({ error: "首批失败" }) });
    });
    expect(container.textContent).toContain("首批失败");
    await act(async () => { moreButton().click(); });
    await resolveRequest(pendingRequests[1], paged([item("first", "已有记录")], "retry-cursor"));
    await act(async () => { moreButton().click(); });
    await act(async () => {
      pendingRequests[2].resolve({ ok: false, json: async () => ({ error: "网络失败" }) });
    });
    expect(container.textContent).toContain("已有记录");
    expect(container.textContent).toContain("网络失败");
    await act(async () => { moreButton().click(); });
    expect(pendingRequests[3].url).toBe(pendingRequests[2].url);
    await resolveRequest(pendingRequests[3], paged([item("last", "重试成功")], null));
    expect(container.textContent).toContain("已有记录");
    expect(container.textContent).toContain("重试成功");
    expect(container.textContent).not.toContain("网络失败");
  });

  it.each(["队列", "业务类型", "搜索", "时间", "状态", "排序"])("%s变化清空旧列表与游标，旧续页响应不能混入新结果", async filter => {
    await resolveRequest(pendingRequests[0], paged([item("old", "旧筛选记录")], "old-cursor"));
    await act(async () => { moreButton().click(); });
    const oldPage = pendingRequests[1];
    if (filter === "队列") await act(async () => { queueButton("我已处理")!.click(); });
    if (filter === "业务类型") await act(async () => { queueButton("费用报销")!.click(); });
    if (filter === "时间") await changeSelect(selectFor("时间")!, "7d");
    if (filter === "状态") await changeSelect(selectFor("状态")!, "approved");
    if (filter === "排序") await changeSelect(selectFor("排序")!, "newest");
    if (filter === "搜索") {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索审批"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "餐费");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    }
    expect(container.textContent).not.toContain("旧筛选记录");
    const current = pendingRequests[2];
    expect(new URL(current.url, "http://localhost").searchParams.has("cursor")).toBe(false);
    const expectedParam: Record<string, [string, string]> = {
      队列: ["view", "processed"], 业务类型: ["type", "expense"], 搜索: ["q", "餐费"],
      状态: ["status", "approved"], 排序: ["sort", "newest"],
    };
    if (expectedParam[filter]) {
      const [key, value] = expectedParam[filter];
      expect(new URL(current.url, "http://localhost").searchParams.get(key)).toBe(value);
    }
    if (filter === "时间") expect(new URL(current.url, "http://localhost").searchParams.has("from")).toBe(true);
    await resolveRequest(current, paged([item("new", "新筛选记录")], "new-cursor"));
    await resolveRequest(oldPage, paged([item("stale", "过期续页记录")], "stale-cursor"));
    expect(container.textContent).toContain("新筛选记录");
    expect(container.textContent).not.toContain("过期续页记录");
    await act(async () => { moreButton().click(); });
    const next = new URL(pendingRequests[3].url, "http://localhost").searchParams;
    expect(next.get("cursor")).toBe("new-cursor");
    next.delete("cursor");
    expect(next.toString()).toBe(new URL(current.url, "http://localhost").searchParams.toString());
  });

  it("旧续页失败与收尾不能覆盖新请求的加载状态", async () => {
    await resolveRequest(pendingRequests[0], paged([item("old", "旧记录")], "old-cursor"));
    await act(async () => { moreButton().click(); });
    await changeSelect(selectFor("排序")!, "newest");
    await act(async () => {
      pendingRequests[1].resolve({ ok: false, json: async () => ({ error: "旧续页失败" }) });
    });
    expect(container.textContent).toContain("加载中…");
    expect(container.textContent).not.toContain("旧续页失败");
    await resolveRequest(pendingRequests[2], paged([item("new", "新结果")], null));
    expect(container.textContent).toContain("新结果");
  });

  it("切换时间范围重新计算起点并废弃原范围游标", async () => {
    await resolveRequest(pendingRequests[0]);
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await changeSelect(selectFor("时间")!, "7d");
      const first = new URL(pendingRequests[1].url, "http://localhost").searchParams;
      expect(first.get("from")).toBe(new Date(now - 7 * 86_400_000).toISOString());
      await resolveRequest(pendingRequests[1], paged([item("old", "近七天记录")], "7d-cursor"));
      dateSpy.mockReturnValue(now + 60_000);
      await changeSelect(selectFor("时间")!, "30d");
      const next = new URL(pendingRequests[2].url, "http://localhost").searchParams;
      expect(next.get("from")).toBe(new Date(now + 60_000 - 30 * 86_400_000).toISOString());
      expect(next.has("cursor")).toBe(false);
      expect(container.textContent).not.toContain("近七天记录");
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("续页固定相对时间起点，并保持选择中的详情", async () => {
    await resolveRequest(pendingRequests[0]);
    await changeSelect(selectFor("时间")!, "7d");
    await resolveRequest(pendingRequests[1], paged([item("selected", "选择中的记录")], "time-cursor"));
    await act(async () => { listButtons()[0].click(); });
    expect(pendingRequests[2].url).toContain("/finance/expenses/selected");
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      await act(async () => { moreButton().click(); });
      const firstParams = new URL(pendingRequests[1].url, "http://localhost").searchParams;
      const nextParams = new URL(pendingRequests[3].url, "http://localhost").searchParams;
      expect(nextParams.get("from")).toBe(firstParams.get("from"));
      await resolveRequest(pendingRequests[3], paged([item("next", "下一条")], null));
      expect(listButtons()[0].getAttribute("aria-current")).toBe("true");
    } finally {
      dateSpy.mockRestore();
    }
  });
});
