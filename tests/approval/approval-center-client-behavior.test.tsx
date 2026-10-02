// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCenterItem, ApprovalCenterPage } from "@/lib/approval/approval-center-types";

import ApprovalCenterClient from "@/components/approval/ApprovalCenterClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PendingRequest = {
  url: string;
  resolve: (response: unknown) => void;
};

const pendingRequests: PendingRequest[] = [];
const fetchMock = vi.fn<(url: string) => Promise<unknown>>();
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

async function resolveRequest(request: PendingRequest, body: ApprovalCenterPage = page()) {
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

beforeEach(async () => {
  pendingRequests.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(url => new Promise(resolve => {
    pendingRequests.push({ url, resolve });
  }));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ApprovalCenterClient productionId="prod_1" productionName="测试项目" actorId="user_1" archived={false} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("审批中心筛选状态", () => {
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
