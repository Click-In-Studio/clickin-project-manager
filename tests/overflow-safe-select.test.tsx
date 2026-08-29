// @vitest-environment jsdom

import { act, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import OverflowSafeSelect from "@/components/OverflowSafeSelect";
import { Z_INDEX } from "@/lib/z-index";

describe("OverflowSafeSelect", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrollIntoView.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(children: ReactNode) {
    await act(async () => root.render(children));
  }

  async function openMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return trigger!;
  }

  it("puts caller styles and layout classes on the actual flex/grid item", async () => {
    await render(
      <OverflowSafeSelect
        className="col-span-2 w-full"
        style={{ border: "2px solid red", padding: "3px 4px", background: "rgb(1, 2, 3)", minHeight: 24 }}
        value="a"
        onChange={() => {}}
      >
        <option value="a">Alpha</option>
      </OverflowSafeSelect>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.parentElement).toBe(container);
    expect(trigger.className).toBe("ofs-trigger col-span-2 w-full");
    expect(trigger.style.border).toBe("2px solid red");
    expect(trigger.style.padding).toBe("3px 4px");
    expect(trigger.style.background).toBe("rgb(1, 2, 3)");
    expect(trigger.style.minHeight).toBe("24px");
  });

  // 默认外观必须留在 CSS 的 components 层，一旦回退成内联 style，就会无条件压过
  // 调用方的 Tailwind 类（内联样式优先级更高），17 个纯 className 调用点会集体变形。
  it("leaves className-only call sites free of inline appearance defaults", async () => {
    await render(
      <OverflowSafeSelect
        className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
        value="a"
        onChange={() => {}}
      >
        <option value="a">Alpha</option>
      </OverflowSafeSelect>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.className).toBe("ofs-trigger rounded-lg border border-zinc-200 px-3 py-2 text-sm");
    expect(trigger.getAttribute("style")).toBeNull();
  });

  // 原生 <select> 是 inline-block 收缩到内容；写死 width:100% 会让横排 flex 里的
  // 下拉撑满整行，flex-wrap 容器里更会独占一行（筛选条会从一行炸成四行）。
  it("does not force a width on callers that did not ask for one", async () => {
    await render(
      <OverflowSafeSelect style={{ padding: "7px 9px", fontSize: 12 }} value="a" onChange={() => {}}>
        <option value="a">Alpha</option>
      </OverflowSafeSelect>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.style.width).toBe("");
    expect(trigger.style.minHeight).toBe("");
  });

  it("emits a real select change event and supports keyboard selection", async () => {
    let received: { value: string; name: string; cancellable: boolean } | undefined;
    await render(
      <OverflowSafeSelect
        aria-label="状态"
        name="status"
        value="a"
        onChange={(event) => {
          received = {
            value: event.target.value,
            name: event.target.name,
            cancellable: typeof event.preventDefault === "function" && typeof event.stopPropagation === "function",
          };
        }}
      >
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </OverflowSafeSelect>,
    );

    const trigger = await openMenu();
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(received).toEqual({ value: "b", name: "status", cancellable: true });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("flattens optgroups and fragment/component-wrapped options", async () => {
    function OptionWrapper({ children }: { children: ReactNode }) {
      return <>{children}</>;
    }

    await render(
      <OverflowSafeSelect aria-label="资源" defaultValue="plain" onChange={() => {}}>
        <Fragment>
          <option value="plain">普通</option>
          <OptionWrapper>
            <option value="wrapped">包装项</option>
          </OptionWrapper>
        </Fragment>
        <optgroup label="禁用组" disabled>
          <option value="disabled">不可选</option>
        </optgroup>
      </OverflowSafeSelect>,
    );

    await openMenu();
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent?.trim())).toEqual(["普通✓", "包装项", "不可选"]);
    expect(options[2]?.disabled).toBe(true);
    expect(document.body.textContent).toContain("禁用组");
  });

  it("keeps the portal above the highest modal and clamps it inside the viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
    await render(
      <div style={{ position: "fixed", inset: 0, zIndex: 9999 }}>
        <OverflowSafeSelect aria-label="模态框下拉" value="a" onChange={() => {}}>
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </OverflowSafeSelect>
      </div>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    trigger.getBoundingClientRect = () => ({
      x: 280, y: 180, left: 280, right: 360, top: 180, bottom: 214,
      width: 80, height: 34, toJSON: () => ({}),
    });
    await openMenu();

    const menu = document.body.querySelector<HTMLDivElement>('[role="listbox"]')!;
    expect(Number(menu.style.zIndex)).toBe(Z_INDEX.selectMenu);
    expect(Number(menu.style.zIndex)).toBeGreaterThan(9999);
    expect(menu.style.left).toBe("90px");
    expect(menu.style.width).toBe("220px");
    expect(menu.style.bottom).toBe("66px");
    expect(menu.style.maxHeight).toBe("164px");
  });

  it("marks portal interactions so a containing drawer does not treat them as outside clicks", async () => {
    let selectedValue = "a";
    let drawerClosed = false;
    const drawer = document.createElement("aside");
    container.appendChild(drawer);
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || drawer.contains(target)) return;
      if (target instanceof Element && target.closest("[data-overflow-safe-select-menu]")) return;
      drawerClosed = true;
    };
    document.addEventListener("pointerdown", outside);

    await act(async () => root.render(
      <OverflowSafeSelect aria-label="抽屉下拉" value={selectedValue} onChange={(event) => { selectedValue = event.target.value; }}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </OverflowSafeSelect>,
    ));
    await openMenu();
    const menu = document.body.querySelector<HTMLElement>("[data-overflow-safe-select-menu]");
    const beta = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(option => option.textContent?.includes("Beta"));
    expect(menu).not.toBeNull();

    await act(async () => {
      beta?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      beta?.click();
    });

    expect(drawerClosed).toBe(false);
    expect(selectedValue).toBe("b");
    document.removeEventListener("pointerdown", outside);
    drawer.remove();
  });

  it("leaves the menu marker in the DOM for the Escape that closes it, so a containing drawer can defer", async () => {
    let drawerClosed = false;
    // 抽屉的 Esc 监听器（document 上，晚于 React 的根监听器注册 ⇒ 后跑）。
    const esc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("[data-overflow-safe-select-menu]")) return;
      drawerClosed = true;
    };
    document.addEventListener("keydown", esc);

    await render(
      <OverflowSafeSelect aria-label="抽屉下拉" value="a" onChange={() => {}}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </OverflowSafeSelect>,
    );
    const trigger = await openMenu();
    expect(document.body.querySelector("[data-overflow-safe-select-menu]")).not.toBeNull();

    // 第一次 Esc：菜单收起，抽屉不动。
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector("[data-overflow-safe-select-menu]")).toBeNull();
    expect(drawerClosed).toBe(false);

    // 第二次 Esc：没有菜单挡着了，抽屉该关就关（豁免不能变成永久吞键）。
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(drawerClosed).toBe(true);

    document.removeEventListener("keydown", esc);
  });

  it("scrolls the keyboard-active option into view and does not mislabel unknown values", async () => {
    await render(
      <OverflowSafeSelect aria-label="长列表" value="missing" onChange={() => {}}>
        {Array.from({ length: 12 }, (_, index) => (
          <option key={index} value={String(index)}>Option {index}</option>
        ))}
      </OverflowSafeSelect>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toContain("请选择");
    await openMenu();
    scrollIntoView.mockClear();
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
