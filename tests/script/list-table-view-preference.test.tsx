// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ListTableViewToggle, { ListTableViewToggleOverflow } from "@/components/script/ListTableViewToggle";
import {
  listTableViewStorageKey,
  type ListTableViewScope,
  useListTableViewPreference,
} from "@/components/script/use-list-table-view-preference";
import {
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
} from "@/components/shell/ProductionTopMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function PreferenceProbe({ scope }: { scope: ListTableViewScope }) {
  const [view, setView] = useListTableViewPreference(scope);
  return (
    <div>
      <output>{view}</output>
      <button type="button" onClick={() => setView("list")}>选列表</button>
      <button type="button" onClick={() => setView("table")}>选表格</button>
    </div>
  );
}

describe("构作与角色的列表 / 表格偏好", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderProbe(scope: ListTableViewScope) {
    await act(async () => root.render(<PreferenceProbe scope={scope} />));
  }

  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!button) throw new Error(`没找到「${label}」`);
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  it("首次进入默认表格，主动切换后写入当前页面的浏览器偏好", async () => {
    await renderProbe("dramaturgy");
    expect(container.querySelector("output")?.textContent).toBe("table");

    click("选列表");
    expect(container.querySelector("output")?.textContent).toBe("list");
    expect(window.localStorage.getItem(listTableViewStorageKey("dramaturgy"))).toBe("list");
  });

  it("构作与角色分别记忆，已有选择在再次进入时恢复", async () => {
    window.localStorage.setItem(listTableViewStorageKey("dramaturgy"), "list");
    window.localStorage.setItem(listTableViewStorageKey("characters"), "table");

    await renderProbe("dramaturgy");
    expect(container.querySelector("output")?.textContent).toBe("list");

    await renderProbe("characters");
    expect(container.querySelector("output")?.textContent).toBe("table");
    expect(window.localStorage.getItem(listTableViewStorageKey("dramaturgy"))).toBe("list");
  });

  it("工具栏与收纳菜单都按表格在前、列表在后排列", () => {
    const closeOverflow = vi.fn();
    act(() => root.render(
      <ProductionToolbarContext.Provider value={{
        stage: PRODUCTION_TOOLBAR_STAGE.full,
        closeOverflow,
        overflowOpen: true,
        hasStoredControls: false,
        setHasStoredControls: () => {},
      }}>
        <ListTableViewToggle value="table" onChange={() => {}} />
        <ListTableViewToggleOverflow value="table" onChange={() => {}} />
      </ProductionToolbarContext.Provider>,
    ));

    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).toEqual(["⊞表格", "☰列表", "⊞表格✓", "☰列表"]);
  });
});
