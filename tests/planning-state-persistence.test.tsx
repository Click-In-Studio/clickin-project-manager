// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlanningClient from "@/components/PlanningClient";

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
};

describe("PlanningClient view state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ groups: [], columns: [], placements: [], items: [], techReqs: [] }),
    })));
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

  it("restores the last section, calendar month, and gantt scale", async () => {
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

    await render({
      ...baseProps,
      events: [
        { id: "event-a", title: "首场", startTime: "2031-04-01T01:00:00.000Z" },
        { id: "event-b", title: "复排", startTime: "2031-04-02T01:00:00.000Z" },
      ] as Parameters<typeof PlanningClient>[0]["events"],
      departments: [{ id: "dept-a", name: "舞台部" }],
      members: [{ userId: "user-b", name: "陈雨", roles: ["编剧"], departmentIds: ["dept-a"] }],
    });

    const controls = [...container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
    expect(controls[0]?.textContent).toContain("复排");
    expect(controls[1]?.textContent).toContain("自定义关注列");
    expect(controls[2]?.textContent).toContain("陈雨");
  });
});
