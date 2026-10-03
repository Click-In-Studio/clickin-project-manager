// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/ui/OverflowSafeSelect", () => ({
  default: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select {...props}>{children}</select>
  ),
}));

import AdminDangerSection from "@/components/admin/AdminDangerSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
});

function renderDanger(canArchive: boolean, canDelete: boolean) {
  act(() => root.render(
    <AdminDangerSection
      productionId="prod_1"
      productionName="测试项目"
      isArchived={false}
      canArchive={canArchive}
      canDelete={canDelete}
    />,
  ));
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.trim() === label)!;
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("危险操作保护条件", () => {
  it("无权限时保留原因说明，不渲染可执行控件", () => {
    renderDanger(false, false);
    expect(container.textContent).toContain("需要 production:archive 权限");
    expect(container.textContent).toContain("仅项目所有者可删除");
    expect(container.querySelector("input")).toBeNull();
    expect(button("归档")).toBeUndefined();
  });

  it("归档和删除仍先经过确认，取消确认不发送写请求", async () => {
    renderDanger(true, true);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => button("归档").click());
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("确定归档项目"));
    expect(fetchMock).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="测试项目"]')!;
    act(() => inputValue(input, "测试项目"));
    expect(button("确认删除").disabled).toBe(false);

    await act(async () => button("确认删除").click());
    expect(confirmMock).toHaveBeenLastCalledWith(expect.stringContaining("永久丢失"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
