// @vitest-environment jsdom
//
// #487 A2：AppShell 工具栏阶段簇出 hook。溢出收纳那条链靠 getBoundingClientRect /
// ResizeObserver 测量，jsdom 里全是 0 测不出东西（纯函数部分见 app-shell-toolbar-stage.test.ts）。
// 这里只钉不靠测量的三件事：头部阶段跟视口宽度、搜索展开与溢出菜单的联动、换页复位——
// 最后一条是这次搬家唯一的结构改动（复位 effect 按簇拆成两个），必须钉住。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useProductionToolbarStage } from "@/components/shell/app-shell/use-production-toolbar-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver { observe() {} disconnect() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;

type Snapshot = ReturnType<typeof useProductionToolbarStage>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];

function Probe({ pathname }: { pathname: string }) {
  const s = useProductionToolbarStage({ pathname });
  seen.push(s);
  return (
    <header ref={s.topbarRef}>
      <div ref={s.topOverflowRef} data-testid="overflow" />
    </header>
  );
}

let container: HTMLDivElement;
let root: Root;

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  seen.length = 0;
  setInnerWidth(1920);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(pathname: string) { act(() => root.render(<Probe pathname={pathname} />)); }
function navigate(pathname: string) { act(() => root.render(<Probe pathname={pathname} />)); }
function mousedownOn(target: EventTarget) {
  act(() => { target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
}

describe("useProductionToolbarStage — 头部阶段", () => {
  it("挂载按 innerWidth 定阶段，resize 后重算", () => {
    mount("/production/p1/script");
    expect(latest().productionHeaderStage).toBe(0);
    setInnerWidth(1100);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(latest().productionHeaderStage).toBe(1);
    setInnerWidth(900);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(latest().productionHeaderStage).toBe(2);
  });
});

describe("useProductionToolbarStage — 搜索与溢出菜单联动", () => {
  it("搜索原位展开记下当前路由并关掉溢出菜单；收进溢出槽里展开则不动", () => {
    mount("/production/p1/script");
    act(() => latest().setTopOverflowOpen(true));
    expect(latest().topOverflowOpen).toBe(true);
    act(() => latest().handleProductionSearchOpenChange(true, false));
    expect(latest().productionSearchPath).toBe("/production/p1/script");
    expect(latest().topOverflowOpen).toBe(false);

    act(() => latest().setTopOverflowOpen(true));
    act(() => latest().handleProductionSearchOpenChange(true, true));
    expect(latest().productionSearchPath).toBe(null);
    expect(latest().topOverflowOpen).toBe(true);
  });

  it("溢出菜单开着时点外面关闭；点菜单内或标了 data-production-overflow-menu-child 的元素不关", () => {
    mount("/production/p1/script");
    act(() => latest().setTopOverflowOpen(true));
    const overflow = container.querySelector('[data-testid="overflow"]')!;
    mousedownOn(overflow);
    expect(latest().topOverflowOpen).toBe(true);

    const child = document.createElement("div");
    child.setAttribute("data-production-overflow-menu-child", "");
    document.body.appendChild(child);
    mousedownOn(child);
    expect(latest().topOverflowOpen).toBe(true);
    child.remove();

    mousedownOn(document.body);
    expect(latest().topOverflowOpen).toBe(false);
  });

  it("context 里暴露的 closeOverflow 与 stage 跟状态同步", () => {
    mount("/production/p1/script");
    act(() => latest().setTopOverflowOpen(true));
    expect(latest().productionToolbarContext.overflowOpen).toBe(true);
    act(() => latest().productionToolbarContext.closeOverflow());
    expect(latest().topOverflowOpen).toBe(false);
    expect(latest().productionToolbarContext.stage).toBe(latest().productionToolbarStage);
  });
});

describe("useProductionToolbarStage — 换页复位（拆出来的那个 effect）", () => {
  it("换页后搜索路径清空、溢出菜单关闭、工具栏阶段回 0", () => {
    mount("/production/p1/script");
    act(() => latest().handleProductionSearchOpenChange(true, false));
    act(() => latest().setTopOverflowOpen(true));
    expect(latest().productionSearchPath).toBe("/production/p1/script");
    navigate("/production/p1/cues");
    expect(latest().productionSearchPath).toBe(null);
    expect(latest().topOverflowOpen).toBe(false);
    expect(latest().productionToolbarStage).toBe(0);
  });
});
