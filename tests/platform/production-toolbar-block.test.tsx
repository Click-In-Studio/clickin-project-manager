// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ProductionToolbarBlock } from "@/components/shell/ProductionTopMenu";
import { layoutProgressiveToolbar, selectStoredToolbarBlocks } from "@/components/shell/app-shell/toolbar-stage";

describe("逐块收纳", () => {
  const blocks = [
    { id: "selector", width: 90, priority: 50 },
    { id: "mode", width: 60, priority: 40 },
    { id: "edit", width: 60, priority: 10 },
    { id: "display", width: 60, priority: 30 },
    { id: "export", width: 60, priority: 20 },
  ];
  it("只收纳需要的功能块，变宽逐项恢复，原视觉顺序不参与优先级排序", () => {
    expect(selectStoredToolbarBlocks(blocks, 330, 60)).toEqual([]);
    expect(selectStoredToolbarBlocks(blocks, 329, 60)).toEqual(["edit", "export"]);
    expect(selectStoredToolbarBlocks(blocks, 250, 60)).toEqual(["edit", "export", "display"]);
    expect(blocks.map(block => block.id)).toEqual(["selector", "mode", "edit", "display", "export"]);
  });
  it("权限减少或名称变宽时使用当前工具集重新决定收纳", () => {
    expect(selectStoredToolbarBlocks(blocks.slice(0, 2), 200, 60)).toEqual([]);
    expect(selectStoredToolbarBlocks([{ ...blocks[0], width: 200 }, ...blocks.slice(1)], 330, 60))
      .toEqual(["edit", "export", "display"]);
  });
  it("两栏间移动保留输入节点和组件状态，无重复控件；卸载清理外栏容器", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const topbar = document.createElement("header");
    const slot = document.createElement("div"); slot.id = "production-page-toolbar-slot";
    const rootElement = document.createElement("div");
    rootElement.dataset.productionTopMenuRoot = "true"; rootElement.dataset.toolbarProgressive = "true";
    slot.append(rootElement); topbar.append(slot);
    const secondary = document.createElement("div"); secondary.id = "production-page-toolbar-overflow-slot";
    document.body.append(topbar, secondary);
    let available = 150;
    Object.defineProperty(topbar, "clientWidth", { get: () => available });
    const root = createRoot(rootElement);
    function Input() {
      const [text, setText] = useState("新角色名");
      return <input value={text} onChange={event => setText(event.target.value)} />;
    }
    act(() => root.render(<><ProductionToolbarBlock id="selector" priority={50}><button>剧本选择器</button></ProductionToolbarBlock>
      <ProductionToolbarBlock id="role" priority={10}><Input /></ProductionToolbarBlock></>));
    for (const host of document.querySelectorAll<HTMLElement>("[data-toolbar-block]")) {
      host.getBoundingClientRect = () => ({ width: 90 } as DOMRect);
    }
    const input = document.querySelector("input")!;
    expect(layoutProgressiveToolbar(topbar)).toBe(true);
    expect(secondary.contains(input)).toBe(true);
    available = 400;
    expect(layoutProgressiveToolbar(topbar)).toBe(false);
    expect(rootElement.querySelector("input")).toBe(input);
    expect(input.value).toBe("新角色名");
    expect(document.querySelectorAll("input")).toHaveLength(1);
    act(() => root.unmount());
    expect(secondary.childElementCount).toBe(0);
    topbar.remove(); secondary.remove();
  });
});
