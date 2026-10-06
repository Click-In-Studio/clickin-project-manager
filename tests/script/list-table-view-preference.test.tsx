// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CharactersManager from "@/components/script/CharactersManager";
import Dramaturgy from "@/components/script/Dramaturgy";
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
import { NO_CHARACTER_PERMS } from "@/lib/script/character-perms-types";
import { NO_SCENE_FIELD_PERMS } from "@/lib/script/scene-field-perms-shared";

vi.mock("next/navigation", () => ({
  usePathname: () => "/production/p1/dramaturgy",
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function PreferenceProbe({ scope }: { scope: ListTableViewScope }) {
  const [view, setView] = useListTableViewPreference(scope);
  return (
    <div>
      <output>{view ?? "pending"}</output>
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

  it("服务端与客户端首帧不先渲染错误视图，布局阶段再恢复已有偏好", async () => {
    window.localStorage.setItem(listTableViewStorageKey("dramaturgy"), "list");

    const initialHtml = renderToString(<PreferenceProbe scope="dramaturgy" />);
    expect(initialHtml).toContain("<output>pending</output>");
    expect(initialHtml).not.toContain("<output>table</output>");

    await renderProbe("dramaturgy");
    expect(container.querySelector("output")?.textContent).toBe("list");
  });

  it("两个消费页面的服务端首屏都有稳定骨架，不会在偏好恢复前输出空白正文", () => {
    const dramaturgyHtml = renderToString(
      <Dramaturgy
        productionId="p1"
        productionName="测试演出"
        versionId={null}
        initialScenes={[]}
        openingChapterMarkerId={null}
        canEdit={false}
        fieldPerms={NO_SCENE_FIELD_PERMS}
      />,
    );
    const charactersHtml = renderToString(
      <CharactersManager
        productionId="p1"
        initialCharacters={[]}
        perms={NO_CHARACTER_PERMS}
      />,
    );

    for (const html of [dramaturgyHtml, charactersHtml]) {
      expect(html).toContain('role="status"');
      expect(html).toContain("正在打开");
      expect(html).toContain('aria-busy="true"');
    }
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

  it("切换到没有保存偏好的 scope 时恢复默认表格", async () => {
    window.localStorage.setItem(listTableViewStorageKey("dramaturgy"), "list");

    await renderProbe("dramaturgy");
    expect(container.querySelector("output")?.textContent).toBe("list");

    await renderProbe("characters");
    expect(container.querySelector("output")?.textContent).toBe("table");
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
