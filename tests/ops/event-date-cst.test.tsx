// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReqDetailClient from "@/components/ops/ReqDetailClient";
import QuickCreateModal from "@/components/ops/planning/QuickCreateModal";
import type { EventTechReq, ProductionEvent } from "@/lib/ops/event-db";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const originalTimezone = process.env.TZ;
const boundaryStart = "2026-09-10T16:30:00.000Z";

function event(): ProductionEvent {
  return {
    id: "event-boundary",
    productionId: "production-cst",
    eventType: "rehearsal",
    title: "跨日排练",
    location: "排练厅",
    startTime: boundaryStart,
    endTime: "2026-09-10T18:30:00.000Z",
    status: "published",
    description: "",
    stageManagers: [],
    chatId: null,
    versionId: null,
    createdBy: "creator",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function task(): EventTechReq {
  return {
    id: "task-cst",
    productionId: "production-cst",
    eventId: null,
    scheduleItemIds: [],
    title: "独立任务",
    description: "",
    presetMinutes: null,
    departmentId: null,
    groupId: null,
    status: "pending",
    assignees: [],
    chatId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    createdVia: "explicit",
    startTime: null,
    endTime: null,
    effectiveStartTime: null,
    effectiveEndTime: null,
    phaseIds: [],
  };
}

describe("事件选择器 CST 日期", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    process.env.TZ = "UTC";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  it("日历快捷新建的关联事件按 CST 显示", async () => {
    await act(async () => {
      root.render(
        <QuickCreateModal
          productionId="production-cst"
          date="2026-09-11"
          departments={[]}
          events={[event()]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const taskButton = [...container.querySelectorAll("button")]
      .find(button => button.querySelector("b")?.textContent === "任务")!;
    await act(async () => taskButton.click());

    expect(container.querySelector('option[value="event-boundary"]')?.textContent)
      .toBe("9月11日 · 跨日排练");
  });

  it("任务详情的可挂载事件按 CST 显示", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/access")) {
        return { ok: true, json: async () => ({ canAccess: true }) } as Response;
      }
      if (url.endsWith("/tasks/create-options")) {
        return {
          ok: true,
          json: async () => ({
            events: [{ id: "event-boundary", title: "跨日排练", startTime: boundaryStart, requiresPocDept: false }],
          }),
        } as Response;
      }
      throw new Error(`未预期的请求：${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <ReqDetailClient
          req={task()}
          event={null}
          scheduleItems={[]}
          deptName={null}
          deptPeople={[]}
          allPeople={[]}
          phases={[]}
          phaseOptions={[]}
          taskOptions={[]}
          blockedBy={[]}
          blocks={[]}
          isPocOfDept={false}
          isAssignee={false}
          canViewFull
          productionId="production-cst"
        />,
      );
    });

    const editButton = [...container.querySelectorAll("button")]
      .find(button => button.textContent === "编辑任务信息")!;
    await act(async () => {
      editButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const eventPicker = [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("不关联（独立任务）"))!;
    await act(async () => eventPicker.click());

    expect(document.body.textContent).toContain("9月11日 · 跨日排练");
  });
});
