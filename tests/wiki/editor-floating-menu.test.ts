// 下拉菜单视口定位（#671）——纯函数，断言的是「往哪开、夹在哪、能多高」。
import { describe, expect, it } from "vitest";
import { MIN_MENU_HEIGHT, suggestionMenuLayout } from "@/lib/editor/editor-floating-menu";

const viewport = { width: 1280, height: 700 };

describe("suggestionMenuLayout", () => {
  it("光标贴近底部：向上开，top 是菜单底边（配 translateY(-100%)），高度不缩", () => {
    const layout = suggestionMenuLayout({ left: 640, top: 650, bottom: 670 }, viewport);
    expect(layout.placement).toBe("top");
    expect(layout.top).toBe(646);
    expect(layout.maxHeight).toBe(256);
  });

  it("下方空间充足：向下开，top 在光标下方 gap 处", () => {
    const layout = suggestionMenuLayout({ left: 120, top: 80, bottom: 100 }, viewport);
    expect(layout.placement).toBe("bottom");
    expect(layout.top).toBe(104);
    expect(layout.left).toBe(120);
  });

  it("贴右边缘：左移夹进视口；矮视口：高度按余量缩", () => {
    const layout = suggestionMenuLayout({ left: 1180, top: 110, bottom: 130 }, { width: 1280, height: 240 });
    expect(layout.left).toBe(1280 - 360 - 8);
    expect(layout.maxHeight).toBeLessThan(256);
    expect(layout.maxHeight).toBeGreaterThanOrEqual(MIN_MENU_HEIGHT);
  });

  it("贴左边缘：不会小于 padding", () => {
    const layout = suggestionMenuLayout({ left: 2, top: 80, bottom: 100 }, viewport);
    expect(layout.left).toBe(8);
  });

  it("两边都挤（上方极小、下方更小）：向上开但高度不为 0，保住可见", () => {
    // 上方 40px、下方 10px：按余量算上方只剩 28px，若不设下限菜单就是一条缝
    const layout = suggestionMenuLayout({ left: 100, top: 40, bottom: 60 }, { width: 800, height: 70 });
    expect(layout.placement).toBe("top");
    expect(layout.maxHeight).toBe(MIN_MENU_HEIGHT);
  });

  it("窄视口（手机）：宽度收进视口内", () => {
    const layout = suggestionMenuLayout({ left: 10, top: 80, bottom: 100 }, { width: 300, height: 800 });
    expect(layout.maxWidth).toBe(300 - 16);
    expect(layout.left + layout.maxWidth).toBeLessThanOrEqual(300 - 8);
  });
});
