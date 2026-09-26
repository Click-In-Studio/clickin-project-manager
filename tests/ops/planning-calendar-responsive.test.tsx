// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CalendarView from "@/components/ops/planning/CalendarView";
import type { Props } from "@/components/ops/planning/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function event(id: string, title: string, day: number) {
  return {
    id,
    title,
    status: "published",
    startTime: `2031-04-${String(day).padStart(2, "0")}T01:00:00.000Z`,
    endTime: `2031-04-${String(day).padStart(2, "0")}T03:00:00.000Z`,
    description: "",
    location: "",
  } as Props["events"][number];
}

const props: Props = {
  productionId: "production-calendar",
  events: [
    event("one", "单项日期", 10),
    event("two-a", "两项之一", 11),
    event("two-b", "两项之二", 11),
    event("many-a", "合成排练", 12),
    event("many-b", "灯光联排", 12),
    event("many-c", "服化检查", 12),
    event("many-d", "舞台清场", 12),
  ],
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

describe("CalendarView responsive interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mobile = false;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("planning-calendar-cursor:production-calendar", "2031-04");
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: mobile,
      media: "(max-width: 760px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    mobile = false;
  });

  async function render() {
    await act(async () => {
      root.render(<CalendarView {...props} />);
      await Promise.resolve();
    });
  }

  function dateButton(date: string) {
    return container.querySelector<HTMLButtonElement>(`[aria-label^="${date}，"]`)!;
  }

  it("标明 0、1、2、3+ 条事项，并从桌面 +N 展开全部事项再进入详情", async () => {
    await render();

    expect(dateButton("2031-04-10").getAttribute("aria-label")).toContain("1 项");
    expect(dateButton("2031-04-11").getAttribute("aria-label")).toContain("2 项");
    expect(dateButton("2031-04-12").getAttribute("aria-label")).toContain("4 项");
    expect(dateButton("2031-04-13").getAttribute("aria-label")).toContain("暂无事项");

    const more = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "+1 项")!;
    await act(async () => more.click());

    const dayDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="calendar-day-drawer-title"]')!;
    expect(dayDialog.textContent).toContain("合成排练");
    expect(dayDialog.textContent).toContain("舞台清场");

    const item = [...dayDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("合成排练"))!;
    await act(async () => item.click());
    expect(container.querySelector('[aria-label="合成排练详情"]')).not.toBeNull();

    const back = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("返回当天"))!;
    await act(async () => back.click());
    expect(container.querySelector('[aria-labelledby="calendar-day-drawer-title"]')).not.toBeNull();
  });

  it("移动端日期只展开当天列表，空态关闭后常驻加号沿用所选日期新建", async () => {
    mobile = true;
    await render();

    await act(async () => dateButton("2031-04-13").click());
    expect(container.textContent).toContain("当天暂无事项");
    expect(container.querySelector('[aria-label="2031-04-13 快捷新建"]')).toBeNull();

    const closeDay = container.querySelector<HTMLButtonElement>('[aria-label="关闭当天事项"]')!;
    await act(async () => closeDay.click());

    const floatingCreate = container.querySelector<HTMLButtonElement>('[aria-label="在2031-04-13快捷新建事件或任务"]')!;
    await act(async () => floatingCreate.click());
    const createDialog = container.querySelector<HTMLElement>('[aria-label="2031-04-13 快捷新建"]')!;
    expect(createDialog).not.toBeNull();

    await act(async () => createDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[aria-label="2031-04-13 快捷新建"]')).toBeNull();
    expect(document.activeElement).toBe(floatingCreate);
  });
});
