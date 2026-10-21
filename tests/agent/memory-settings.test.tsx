// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import MemorySettings from "@/components/agent/MemorySettings";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const entry = { id: "m1", body: "先给结论", source: "dream", userEdited: false, revision: 0, inputCount: 3, updatedAt: new Date().toISOString() };
const memory = { productionId: null, revision: 0, historyCutoff: null, entries: [entry] };
let container: HTMLDivElement;
let root: Root;
function input(value: string, label = "记忆内容") {
  const el = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("我的长期记忆管理", () => {
  it("显示AI未确认与批次边界，用户编辑保留失败草稿并可重试", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ memory, projects: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "记忆已变化" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ memory: { ...memory, entries: [{ ...entry, body: "先给结论再说明", userEdited: true, revision: 1 }] } }) });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<MemorySettings />));
    expect(container.textContent).toContain("未经用户确认");
    expect(container.textContent).toContain("记录于");
    await act(async () => input("先给结论再说明"));
    await act(async () => button("保存修改").click());
    expect(container.querySelector("textarea")!.value).toBe("先给结论再说明");
    expect(container.textContent).toContain("记忆已变化");
    await act(async () => button("保存修改").click());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "update", id: "m1", revision: 0, body: "先给结论再说明", productionId: null });
    expect(container.textContent).toContain("用户编辑");
  });
  it("删除先确认范围影响，成功后消失且能看到截断边界", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ memory, projects: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ memory: { ...memory, entries: [], historyCutoff: new Date().toISOString() } }) });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(<MemorySettings />));
    await act(async () => button("删除").click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await act(async () => button("删除").click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("可在已删除列表恢复"));
    expect(container.querySelector('textarea[aria-label="记忆内容"]')).toBeNull();
    expect(container.textContent).toContain("旧历史不会再");
  });
  it("加载失败可以重试；切换范围不携带之前的草稿", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("断网"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ memory, projects: [{ id: "p1", name: "项目甲" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ memory: { ...memory, productionId: "p1", entries: [] }, projects: [{ id: "p1", name: "项目甲" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<MemorySettings />));
    expect(container.textContent).toContain("断网");
    await act(async () => button("重新加载").click());
    await act(async () => input("通用草稿", "新增记忆内容"));
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "p1"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("productionId=p1");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="新增记忆内容"]')!.value).toBe("");
  });
});
