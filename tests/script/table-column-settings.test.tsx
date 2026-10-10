// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableColumnSettings from "@/components/script/TableColumnSettings";
import { getDefaultViewConfig, type TableViewConfigData } from "@/components/script/SceneTableView";

let host: HTMLDivElement;
let root: Root;
let config: TableViewConfigData;
const onChange = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  config = getDefaultViewConfig();
  onChange.mockClear();
  onClose.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render() {
  act(() => root.render(<TableColumnSettings config={config} onChange={onChange} onClose={onClose} />));
}
function row(label: string) {
  const result = [...host.querySelectorAll<HTMLElement>("[draggable]")]
    .find(element => element.querySelector("button")?.title.endsWith(`「${label}」`));
  if (!result) throw new Error(`缺少列：${label}`);
  return result;
}

describe("TableColumnSettings 的受控配置", () => {
  it("同一实例接收新 prop 后立即反映显示、冻结与排列，不向父组件回写", () => {
    render();
    expect(row("名称").querySelector("svg")).not.toBeNull();
    config = { ...config, visibleColumns: ["music"], frozenColumns: ["music"], columnOrder: ["music", "name"] };
    render();
    expect([...host.querySelectorAll<HTMLButtonElement>("[draggable] button")].map(button => button.title))
      .toEqual(["取消冻结「音乐」", "冻结「名称」"]);
    expect(row("名称").querySelector("svg")).toBeNull();
    expect(row("音乐").querySelector("svg")).not.toBeNull();
    expect(row("音乐").querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("点击显示开关立即提交新配置；隐藏冻结列同时移除冻结，不丢其他配置", () => {
    render();
    act(() => row("编号").click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      ...config, visibleColumns: config.visibleColumns.filter(key => key !== "number"), frozenColumns: [],
    });
    config = onChange.mock.calls[0][0];
    render();
    expect(row("编号").querySelector("svg")).toBeNull();
    act(() => row("编号").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...config, visibleColumns: [...config.visibleColumns, "number"] });
  });

  it("冻结隐藏列使其可见并移到冻结区域；按钮不会冒泡成显示开关", () => {
    config = { ...config, visibleColumns: ["number", "name"] };
    render();
    act(() => row("音乐").querySelector<HTMLButtonElement>("button")!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      ...config,
      columnOrder: ["number", "music", ...config.columnOrder.filter(key => key !== "number" && key !== "music")],
      visibleColumns: ["number", "name", "music"], frozenColumns: ["number", "music"],
    });
    config = onChange.mock.calls[0][0];
    render();
    act(() => row("音乐").querySelector<HTMLButtonElement>("button")!.click());
    expect(onChange).toHaveBeenLastCalledWith({ ...config, frozenColumns: ["number"] });
  });
});
