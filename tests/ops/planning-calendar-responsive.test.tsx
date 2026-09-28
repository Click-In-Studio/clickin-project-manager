// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CalendarView from "@/components/ops/planning/CalendarView";
import styles from "@/components/ops/planning.module.css";
import type { Props } from "@/components/ops/planning/types";

const calendarCss = readFileSync(path.resolve(__dirname, "../../components/ops/planning.module.css"), "utf8");

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

function phase(id: string, name: string, deptName: string | null = null) {
  return {
    id,
    name,
    deptId: deptName ? `${id}-dept` : null,
    deptName,
    startDate: "2031-04-09",
    endDate: "2031-04-15",
    milestoneIds: [],
  } as Props["phases"][number];
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

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

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

    const more = [...container.querySelectorAll<HTMLButtonElement>(`button.${styles.calendarHiddenDesktop}`)]
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

  it("多个重叠阶段只占一行，点开后在当天抽屉列全且不吞事项提示", async () => {
    await act(async () => {
      root.render(<CalendarView {...props} phases={[
        phase("phase-light", "灯光排练", "灯光组"),
        phase("phase-sound", "音响联排", "音响组"),
        phase("phase-costume", "服装检查", "服装组"),
      ]} />);
      await Promise.resolve();
    });

    const day = container.querySelector<HTMLElement>('[data-calendar-date="2031-04-12"]')!;
    expect(day.querySelectorAll('[aria-label^="查看 "][aria-label$=" 个阶段"]')).toHaveLength(1);
    expect(day.querySelector('[aria-label="查看 3 个阶段"]')).not.toBeNull();
    expect(day.textContent).toContain("+2 项");
    expect(day.textContent).not.toContain("灯光排练");

    await act(async () => day.querySelector<HTMLButtonElement>('[aria-label="查看 3 个阶段"]')!.click());
    const drawer = container.querySelector<HTMLElement>('[aria-labelledby="calendar-day-drawer-title"]')!;
    expect(drawer.textContent).toContain("灯光排练");
    expect(drawer.textContent).toContain("音响联排");
    expect(drawer.textContent).toContain("服装检查");
    expect(drawer.textContent).toContain("舞台清场");
  });

  it("移动端日期只展开当天列表，空态关闭后常驻加号沿用所选日期新建", async () => {
    mobile = true;
    await render();

    await act(async () => dateButton("2031-04-13").click());
    expect(container.textContent).toContain("当天暂无安排");
    expect(container.querySelector('[aria-label="2031-04-13 快捷新建"]')).toBeNull();

    const closeDay = container.querySelector<HTMLButtonElement>('[aria-label="关闭当天安排"]')!;
    await act(async () => closeDay.click());

    const floatingCreate = container.querySelector<HTMLButtonElement>('[aria-label="在2031-04-13快捷新建事件或任务"]')!;
    await act(async () => floatingCreate.click());
    const createDialog = container.querySelector<HTMLElement>('[aria-label="2031-04-13 快捷新建"]')!;
    expect(createDialog).not.toBeNull();

    await act(async () => createDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[aria-label="2031-04-13 快捷新建"]')).toBeNull();
    expect(document.activeElement).toBe(floatingCreate);
  });

  it("快捷新建的下拉框先消费 Escape，不会连带关闭弹窗", async () => {
    mobile = true;
    await render();

    const floatingCreate = container.querySelector<HTMLButtonElement>('button[aria-label^="在"][aria-label$="快捷新建事件或任务"]')!;
    await act(async () => floatingCreate.click());

    const createDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label$=" 快捷新建"]')!;
    const eventTypeSelect = createDialog.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => eventTypeSelect.click());
    expect(eventTypeSelect.getAttribute("aria-expanded")).toBe("true");

    await act(async () => eventTypeSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(eventTypeSelect.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="dialog"][aria-label$=" 快捷新建"]')).toBe(createDialog);
  });

  it("密集日期在手机端只预算一条阶段、一条事项和 +N 摘要", async () => {
    mobile = true;
    const denseProps: Props = {
      ...props,
      phases: ["全项目筹备", "舞美进场", "技术合成"].map((name, index) => ({
        id: `phase-${index}`,
        name,
        deptId: null,
        deptName: null,
        startDate: "2031-04-12",
        endDate: "2031-04-15",
        milestoneIds: [],
      })),
    };

    await act(async () => {
      root.render(<CalendarView {...denseProps} />);
      await Promise.resolve();
    });

    const cell = container.querySelector<HTMLElement>('[data-calendar-date="2031-04-12"]')!;
    expect(cell.querySelectorAll('[aria-label="查看 3 个阶段"]')).toHaveLength(1);

    const entryRows = [...cell.querySelectorAll<HTMLButtonElement>('button[title]')]
      .filter(button => button.title !== "查看或操作当天事项" && !button.getAttribute("aria-label")?.includes("个阶段"));
    expect(entryRows).toHaveLength(2);
    expect(entryRows[0].classList.contains(styles.calendarMobileHidden)).toBe(false);
    expect(entryRows.slice(1).every(row => row.classList.contains(styles.calendarMobileHidden))).toBe(true);

    const mobileMore = [...cell.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "+3 项")!;
    expect(mobileMore.classList.contains(styles.calendarHiddenMobile)).toBe(true);
    await act(async () => mobileMore.click());
    const drawer = container.querySelector('[aria-labelledby="calendar-day-drawer-title"]')!;
    expect(drawer.textContent).toContain("全项目筹备");
    expect(drawer.textContent).toContain("舞美进场");
    expect(drawer.textContent).toContain("技术合成");
    expect(drawer.textContent).toContain("舞台清场");
  });

  it("手机断点统一压缩格内预算，并为浮动新建按钮保留提示空间", () => {
    expect(calendarCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.calendarCell \{ height: 90px; padding: 3px 2px; gap: 2px; \}/);
    expect(calendarCss).toMatch(/\.calendarMobileHidden, \.calendarHiddenDesktop, \.calendarHintDesktop \{ display: none; \}/);
    expect(calendarCss).toMatch(/@media \(max-width: 380px\)[\s\S]*?\.calendarCell\s*\{[^}]*height:\s*84px;/);
    expect(calendarCss).toMatch(/\.calendarHint \{ width: calc\(100% - 72px\); min-height: 54px;/);
    expect(calendarCss).toContain(".calendarHintMobile { display: inline; }");
  });
});
