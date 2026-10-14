// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlanningClient from "@/components/ops/PlanningClient";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const baseProps: Parameters<typeof PlanningClient>[0] = {
  productionId: "production-a",
  events: [],
  tasks: [],
  milestones: [],
  phases: [],
  departments: [],
  members: [],
  deptOptions: [],
  phasePerm: { canCreate: false, canEdit: false, canDelete: false, pocDeptIds: [], deptPocEnabled: false },
  editableEventIds: [],
  editableTaskIds: [],
};

const timetableProps: Parameters<typeof PlanningClient>[0] = {
  ...baseProps,
  events: [
    { id: "event-a", title: "首场", startTime: "2031-04-01T01:00:00.000Z" },
    { id: "event-b", title: "复排", startTime: "2031-04-02T01:00:00.000Z" },
  ] as Parameters<typeof PlanningClient>[0]["events"],
  departments: [{ id: "dept-a", name: "舞台部" }],
  members: [{ userId: "user-b", name: "陈雨", roles: ["编剧"], departmentIds: ["dept-a"] }],
};

describe("PlanningClient view state", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ groups: [], columns: [], placements: [], items: [], techReqs: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(props = baseProps) {
    await act(async () => {
      root.render(<PlanningClient {...props} />);
      await Promise.resolve();
    });
  }

  async function selectMode(label: string) {
    const tab = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes(label));
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
  }

  function expectMode(label: string) {
    const selected = container.querySelector('button[aria-pressed="true"]');
    expect(selected?.textContent).toContain(label);
  }

  it.each(["timetable", "gantt"])("starts on the calendar despite the old %s preference", async (saved) => {
    window.localStorage.setItem("planning-last-view:production-a", saved);
    await render();
    expectMode("项目日历");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves the selected section on data refresh but resets on re-entry", async () => {
    await render();
    await selectMode("执行日程");
    expectMode("执行日程");
    await render({ ...baseProps, events: [...baseProps.events] });
    expectMode("执行日程");
    await selectMode("任务甘特");
    expectMode("任务甘特");
    await act(async () => root.render(null));
    await render();
    expectMode("项目日历");
    expect(window.localStorage.getItem("planning-last-view:production-a")).toBeNull();
  });

  it("starts on the calendar when switching projects without unmounting the page", async () => {
    await render();
    await selectMode("执行日程");
    await render({ ...baseProps, productionId: "production-b" });
    expectMode("项目日历");
  });

  it("restores the calendar month and gantt scale", async () => {
    window.localStorage.setItem("planning-last-view:production-a", "calendar");
    window.localStorage.setItem("planning-calendar-cursor:production-a", "2031-04");
    window.localStorage.setItem("planning-gantt-scale:production-a", "quarter");

    await render();

    expect(container.textContent).toContain("2031 年");
    expect(container.querySelector('[aria-label="当前月份 4月"]')).not.toBeNull();

    const ganttTab = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("任务甘特"));
    await act(async () => ganttTab?.click());

    const quarter = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "季");
    expect(quarter?.getAttribute("aria-pressed")).toBe("true");
  });

  it("restores rundown event, column view, and member filter", async () => {
    window.localStorage.setItem("planning-last-view:production-a", "timetable");
    window.localStorage.setItem("planning-timetable-filters:production-a", JSON.stringify({
      eventId: "event-b",
      personFilter: "user-b",
      viewMode: "custom",
    }));

    await render(timetableProps);
    await selectMode("执行日程");

    const controls = [...container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
    expect(controls[0]?.textContent).toContain("复排");
    expect(controls[1]?.textContent).toContain("自定义关注列");
    expect(controls[2]?.textContent).toContain("陈雨");
  });

  // 偏好恢复前不该为默认事件白打一轮 rundown / schedule 请求。
  it("does not fetch the default event before the saved filters are restored", async () => {
    window.localStorage.setItem("planning-last-view:production-a", "timetable");
    window.localStorage.setItem("planning-timetable-filters:production-a", JSON.stringify({ eventId: "event-b" }));

    await render(timetableProps);
    await selectMode("执行日程");

    const urls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(urls.every(url => !url.includes("event-a"))).toBe(true);
    expect(urls.filter(url => url.includes("event-b"))).toHaveLength(4);
  });

  // 无偏好时仍要正常拉首个事件——门不能把首屏请求一起挡死。
  it("still fetches the first event when nothing was saved", async () => {
    window.localStorage.setItem("planning-last-view:production-a", "timetable");

    await render(timetableProps);
    await selectMode("执行日程");

    const urls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(urls.filter(url => url.includes("event-a"))).toHaveLength(4);
  });
});
