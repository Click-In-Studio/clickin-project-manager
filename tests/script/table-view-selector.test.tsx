// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableViewSelector, { type SavedView } from "@/components/script/TableViewSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const makeView = (id = "a", name = "音乐总表", isDefault = true): SavedView => ({
  id, name, isDefault, config: { visibleColumns: ["music"] }, createdAt: "old", updatedAt: "old",
});
const edited = { visibleColumns: ["name", "music"] };
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
function Harness({ initial = [makeView()], selected = "a", loadError }: {
  initial?: SavedView[]; selected?: string | null; loadError?: string;
}) {
  const [views, setViews] = useState(initial);
  const [active, setActive] = useState(selected);
  const [config, setConfig] = useState<unknown>(edited);
  return <><TableViewSelector productionId="prod" views={views} activeViewId={active} currentConfig={config}
    onViewsChange={setViews} onSelectView={(view) => { setActive(view.id || null); setConfig(view.config); }}
    loadError={loadError} />
    <output data-state>{JSON.stringify({ views, active, config })}</output></>;
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
const click = async (item: HTMLElement) => { await act(async () => { item.click(); }); };
const state = () => JSON.parse(host.querySelector("output")!.textContent!);
const render = async (props: Parameters<typeof Harness>[0] = {}) => {
  await act(async () => root.render(<Harness {...props} />));
  await click(host.querySelector("button")!);
};
const inputName = async (value: string) => {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("保存视图选择器", () => {
  it("空列表与无效选择使用默认文案，更新禁用且点击不会创建", async () => {
    await render({ initial: [], selected: "missing" });
    expect(host.querySelector("button")!.textContent).toBe("默认视图");
    const actions = [...document.querySelectorAll('[role="dialog"] > div:first-child > button')];
    expect(actions.map(item => item.textContent)).toEqual(["另存新视图", "保存当前视图"]);
    expect(button("保存当前视图").getAttribute("aria-disabled")).toBe("true");
    expect(button("保存当前视图").title).toContain("另存新视图");
    await click(button("保存当前视图")); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("保存使用服务端返回值，保持当前选中及配置", async () => {
    const saved = { ...makeView(), config: edited, updatedAt: "server-time" };
    fetchMock.mockResolvedValue(Response.json(saved));
    await render(); await click(button("保存当前视图"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/production/prod/scene-table-views/a");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ config: edited });
    expect(state().views).toEqual([saved]); expect(state().active).toBe("a");
    expect(document.querySelector('[role="status"]')!.textContent).toContain("成功");
  });
  it("同一帧重复点击只发一次请求，保存期间禁止切换", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    await render({ initial: [makeView(), makeView("b", "舞台总表", false)] });
    const save = button("保存当前视图");
    act(() => { save.click(); save.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button("另存新视图").getAttribute("aria-disabled")).toBe("true");
    const select = document.querySelector<HTMLButtonElement>('button[title="舞台总表"]')!;
    expect(select.disabled).toBe(true);
    await act(async () => { resolve(Response.json({ ...makeView(), config: edited })); });
  });
  it("403 或网络失败不更新状态、不显示成功，并可以重试", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "无权修改他人视图" }, { status: 403 }))
      .mockRejectedValueOnce(new Error("网络中断"));
    await render(); const before = state();
    await click(button("保存当前视图"));
    expect(state()).toEqual(before); expect(document.querySelector('[role="alert"]')!.textContent).toContain("无权修改");
    expect(document.querySelector('[role="status"]')!.textContent).not.toContain("成功");
    await click(button("保存当前视图"));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("网络中断");
    expect(state()).toEqual(before);
  });
  it("新建失败保留输入，成功后列表、选中、按钮名称和配置同步", async () => {
    const created = { ...makeView("new", "新视图"), config: edited };
    fetchMock.mockResolvedValueOnce(Response.json({ error: "权限不足" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json(created, { status: 201 }));
    await render({ initial: [], selected: null }); await click(button("另存新视图")); await inputName("新视图");
    await click(button("保存"));
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("新视图");
    expect(state().views).toEqual([]);
    await click(button("保存"));
    expect(state()).toEqual({ views: [created], active: "new", config: edited });
    expect(host.querySelector("button")!.textContent).toBe("新视图");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).isDefault).toBe(true);
  });
  it("切换长名称视图保留完整名称，选择与配置同步", async () => {
    const longName = "舞台呈现与音乐总表".repeat(12);
    const next = makeView("b", longName, false);
    await render({ initial: [makeView(), next] });
    await click(document.querySelector<HTMLButtonElement>(`button[title="${longName}"]`)!);
    expect(state().active).toBe("b"); expect(state().config).toEqual(next.config);
    expect(host.querySelector("button")!.title).toBe(longName);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("读取失败不能创建或更新，将错误明确呈现", async () => {
    await render({ initial: [], selected: null, loadError: "无权访问" });
    await click(button("另存新视图")); await click(button("保存当前视图"));
    expect(document.querySelector("input")).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("无权访问");
    expect(button("重试读取视图")).toBeTruthy();
  });
  it("设默认不切换配置，删除当前视图后保留配置且不能更新", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    await render({ initial: [makeView(), makeView("b", "舞台总表", false)] });
    await click(document.querySelector<HTMLButtonElement>('[aria-label="将 舞台总表 设为默认"]')!);
    expect(state().views.map((view: SavedView) => view.isDefault)).toEqual([false, true]);
    expect(state().active).toBe("a"); expect(state().config).toEqual(edited);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="删除 音乐总表"]')!);
    await click(button("确认"));
    expect(state().active).toBeNull(); expect(state().config).toEqual(edited);
    expect(host.querySelector("button")!.textContent).toBe("默认视图");
    expect(button("保存当前视图").getAttribute("aria-disabled")).toBe("true");
  });
});
