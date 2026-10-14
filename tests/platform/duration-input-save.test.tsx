// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DurationInput from "@/components/ui/DurationInput";

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
  vi.restoreAllMocks();
});
async function render(onSave: (seconds: number | null) => Promise<void>, canEdit = true) {
  await act(async () => { root.render(<DurationInput value={60} canEdit={canEdit} onSave={onSave} />); });
}
async function edit(text: string) {
  await act(async () => { container.firstElementChild!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function clickOutside() {
  await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
}

describe("时长输入的外部点击保存", () => {
  it("父组件替换保存回调后，只调用当前回调并提交当前输入", async () => {
    const oldSave = vi.fn().mockResolvedValue(undefined);
    const currentSave = vi.fn().mockResolvedValue(undefined);
    await render(oldSave);
    await edit("1:30");
    await render(currentSave);
    await clickOutside();
    expect(oldSave).not.toHaveBeenCalled();
    expect(currentSave).toHaveBeenCalledExactlyOnceWith(90);
    expect(container.querySelector("input")).toBeNull();
  });

  it("保存请求在途时，多次点击外部只提交一次", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render(save);
    await edit("90秒");
    await clickOutside();
    expect(container.querySelector("input")!.disabled).toBe(true);
    await clickOutside();
    await clickOutside();
    expect(save).toHaveBeenCalledExactlyOnceWith(90);
    await act(async () => { finish(); });
    expect(container.querySelector("input")).toBeNull();
  });

  it("编辑能力关闭后，旧监听器不再保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await render(save);
    await edit("90秒");
    await render(save, false);
    await clickOutside();
    expect(save).not.toHaveBeenCalled();
  });

  it("保存失败显示提示并保留输入，之后可重试", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn().mockRejectedValueOnce(new Error("请求失败")).mockResolvedValue(undefined);
    await render(save);
    await edit("90秒");
    await clickOutside();
    expect(container.textContent).toContain("保存时长失败，请重试");
    expect(container.querySelector("input")!.value).toBe("90秒");
    expect(container.querySelector("input")!.disabled).toBe(false);
    await clickOutside();
    expect(save).toHaveBeenCalledTimes(2);
    expect(container.querySelector("input")).toBeNull();
  });

  it("Escape 取消后，外部点击不提交", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await render(save);
    await edit("90秒");
    await act(async () => { container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await clickOutside();
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
  });
});
