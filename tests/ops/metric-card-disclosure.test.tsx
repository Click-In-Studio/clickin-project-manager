// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import MetricCardDisclosure from "@/components/ops/MetricCardDisclosure";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("项目首页里程碑完整内容入口", () => {
  it("长文案使用可聚焦按钮，并可展开完整内容后用 Escape 收起", () => {
    const label = "距「技术合成与全体演员联合走台确认」· 一个名称很长的项目";
    act(() => root.render(<MetricCardDisclosure label={label} />));

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.textContent).toBe(label);
    expect(trigger.getAttribute("aria-label")).toContain(label);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger.click());
    const panel = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toBe(label);

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
