// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TaskGanttView from "@/components/ops/planning/TaskGanttView";
import {
  clampGanttLabelWidth,
  ganttLabelWidthBounds,
  parseGanttLabelWidth,
} from "@/components/ops/planning/gantt-layout";
import type { Props } from "@/components/ops/planning/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const props: Props = {
  productionId: "production-gantt",
  events: [],
  tasks: [{
    id: "task-a",
    title: "排练计划",
    status: "in_progress",
    departmentId: null,
    departmentName: null,
    eventId: null,
    eventTitle: null,
    startTime: "2026-09-30T04:00:00.000Z",
    endTime: "2026-10-02T04:00:00.000Z",
    effectiveStartTime: "2026-09-30T04:00:00.000Z",
    effectiveEndTime: "2026-10-02T04:00:00.000Z",
    isBlocked: false,
    description: "",
  }],
  milestones: [{ id: "milestone-a", name: "首演", endDate: "2026-10-01" }],
  phases: [{
    id: "phase-a",
    name: "排练期",
    deptId: null,
    deptName: null,
    startDate: "2026-09-29",
    endDate: "2026-10-10",
    milestoneIds: ["milestone-a"],
  }],
  departments: [],
  members: [],
  deptOptions: [],
  phasePerm: { canCreate: false, canEdit: false, canDelete: false, pocDeptIds: [], deptPocEnabled: false },
  editableEventIds: [],
  editableTaskIds: [],
};

let visibleWidth = 319;

class TestResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element) { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  disconnect() {}
  unobserve() {}
}

function pointerEvent(type: string, clientX: number, pointerType = "mouse") {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: pointerType },
  });
  return event;
}

describe("甘特图名称列宽度", () => {
  let container: HTMLDivElement;
  let root: Root;
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    visibleWidth = 319;
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => visibleWidth);
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clientWidthSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(<TaskGanttView {...props} />);
      await Promise.resolve();
    });
  }

  it.each([
    [319, 106],
    [337, 112],
    [456, 152],
    [768, 240],
    [1280, 240],
  ])("%ipx 可见宽度的初始列宽不超过约三分之一（期望 %ipx）", (width, expected) => {
    expect(ganttLabelWidthBounds(width).initial).toBe(expected);
    expect(ganttLabelWidthBounds(width).initial).toBeLessThanOrEqual(Math.floor(width / 3));
  });

  it("把损坏偏好丢弃，并按当前可见宽度收紧有效偏好", () => {
    expect(parseGanttLabelWidth("oops")).toBeNull();
    expect(parseGanttLabelWidth("280")).toBe(280);
    expect(clampGanttLabelWidth(280, 319)).toBe(159);
    expect(clampGanttLabelWidth(12, 1280)).toBe(96);
  });

  it("恢复项目内偏好，并让表头、阶段、任务共用同一列宽变量", async () => {
    window.localStorage.setItem("planning-gantt-label-width:production-gantt", "140");
    await render();

    const separator = container.querySelector<HTMLElement>('[role="separator"]');
    const matrix = separator?.parentElement;
    expect(separator?.getAttribute("aria-valuenow")).toBe("140");
    expect(matrix?.style.getPropertyValue("--gantt-label-column-width")).toBe("140px");
    expect(matrix?.querySelectorAll('[class*="ganttGridRow"]')).toHaveLength(3);
  });

  it("鼠标和触摸拖动都能改列宽，并保存到现有本地偏好", async () => {
    await render();
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => {
      separator.dispatchEvent(pointerEvent("pointerdown", 100));
      separator.dispatchEvent(pointerEvent("pointermove", 130));
      separator.dispatchEvent(pointerEvent("pointerup", 130));
    });
    expect(separator.getAttribute("aria-valuenow")).toBe("136");
    expect(window.localStorage.getItem("planning-gantt-label-width:production-gantt")).toBe("136");

    await act(async () => {
      separator.dispatchEvent(pointerEvent("pointerdown", 130, "touch"));
      separator.dispatchEvent(pointerEvent("pointermove", 145, "touch"));
      separator.dispatchEvent(pointerEvent("pointerup", 145, "touch"));
    });
    expect(separator.getAttribute("aria-valuenow")).toBe("151");
    expect(window.localStorage.getItem("planning-gantt-label-width:production-gantt")).toBe("151");
  });

  it("键盘方向键和 Home/End 遵守窄屏上下界并保存", async () => {
    await render();
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" })));
    expect(separator.getAttribute("aria-valuenow")).toBe("159");
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })));
    expect(separator.getAttribute("aria-valuenow")).toBe("96");
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
    expect(separator.getAttribute("aria-valuenow")).toBe("120");
    expect(window.localStorage.getItem("planning-gantt-label-width:production-gantt")).toBe("120");
  });

  it("日、月、季、年四种粒度都可切换，列宽保持不变", async () => {
    await render();
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    const widthBefore = separator.getAttribute("aria-valuenow");
    for (const label of ["日", "月", "季", "年"]) {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(candidate => candidate.textContent === label)!;
      await act(async () => button.click());
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(separator.getAttribute("aria-valuenow")).toBe(widthBefore);
    }
  });
});
