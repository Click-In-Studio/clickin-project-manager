// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import QuickCreateModal, { type QuickCreateResult } from "@/components/ops/planning/QuickCreateModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("项目日历快捷新建", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let onCreated = vi.fn<(result: QuickCreateResult) => void>();
  let onClose = vi.fn<() => void>();

  beforeEach(async () => {
    refresh.mockClear();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        event: {
          id: "created-event",
          productionId: "production-calendar",
          title: "合成排练",
          eventType: "rehearsal",
          location: "",
          startTime: "2031-04-12T02:15:00.000Z",
          endTime: "2031-04-12T04:45:00.000Z",
          status: "draft",
          description: "",
          stageManagers: [],
          chatId: null,
          versionId: null,
          createdBy: "test-user",
          createdAt: "2031-04-01T00:00:00.000Z",
          updatedAt: "2031-04-01T00:00:00.000Z",
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    onCreated = vi.fn<(result: QuickCreateResult) => void>();
    onClose = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QuickCreateModal
          productionId="production-calendar"
          date="2031-04-10"
          departments={[]}
          events={[]}
          onCreated={onCreated}
          onClose={onClose}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function setInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function chooseTime(label: string, hour: string, minute: string) {
    const labelElement = [...container.querySelectorAll("span")]
      .find(element => element.textContent === label)!;
    const field = labelElement.parentElement!;
    await act(async () => field.querySelector<HTMLButtonElement>("button")!.click());
    const hourButton = [...field.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === `${hour} 时`)!;
    await act(async () => hourButton.click());
    const minuteButton = [...field.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === `${minute} 分`)!;
    await act(async () => minuteButton.click());
  }

  async function submit() {
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("修改日期和起止时间后，事件按 CST 的新日期提交", async () => {
    await setInput(container.querySelector<HTMLInputElement>('[aria-label="新建日期"]')!, "2031-04-12");
    await setInput(container.querySelector<HTMLInputElement>('input[placeholder^="例如：第三场"]')!, "  合成排练  ");
    await chooseTime("开始时间", "10", "15");
    await chooseTime("结束时间", "12", "45");

    expect(container.querySelector('[aria-label="2031-04-12 快捷新建"]')).not.toBeNull();
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/production/production-calendar/events");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      title: "合成排练",
      eventType: "rehearsal",
      startTime: "2031-04-12T02:15:00.000Z",
      endTime: "2031-04-12T04:45:00.000Z",
    });
    expect(onCreated).toHaveBeenCalledWith({
      date: "2031-04-12",
      selection: expect.objectContaining({
        kind: "event",
        value: expect.objectContaining({ id: "created-event", title: "合成排练" }),
      }),
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("任务路径也使用修改后的 CST 日期和起止时间", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        task: {
          id: "created-task",
          title: "确认无线麦频点",
          status: "todo",
          departmentId: null,
          eventId: null,
          startTime: "2031-04-12T16:30:00.000Z",
          endTime: "2031-04-12T17:45:00.000Z",
          effectiveStartTime: "2031-04-12T16:30:00.000Z",
          effectiveEndTime: "2031-04-12T17:45:00.000Z",
          description: "由项目日历快捷创建。",
        },
      }),
    });
    const taskButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "任务")!;
    await act(async () => taskButton.click());
    await setInput(container.querySelector<HTMLInputElement>('[aria-label="新建日期"]')!, "2031-04-13");
    await setInput(container.querySelector<HTMLInputElement>('input[placeholder^="例如：确认"]')!, "确认无线麦频点");
    await chooseTime("开始时间", "00", "30");
    await chooseTime("结束时间", "01", "45");

    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/production/production-calendar/tasks");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      title: "确认无线麦频点",
      startTime: "2031-04-12T16:30:00.000Z",
      endTime: "2031-04-12T17:45:00.000Z",
      departmentId: null,
      eventId: null,
      description: "由项目日历快捷创建。",
    });
    expect(onCreated).toHaveBeenCalledWith({
      date: "2031-04-13",
      selection: expect.objectContaining({
        kind: "task",
        value: expect.objectContaining({ id: "created-task", isBlocked: false }),
      }),
    });
  });

  it("结束时间不晚于开始时间时不提交", async () => {
    await setInput(container.querySelector<HTMLInputElement>('input[placeholder^="例如：第三场"]')!, "错误时间事件");
    await chooseTime("开始时间", "12", "00");
    await chooseTime("结束时间", "11", "00");

    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("结束时间必须晚于开始时间");
    expect(onClose).not.toHaveBeenCalled();
  });
});
