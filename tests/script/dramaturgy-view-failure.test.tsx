// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Dramaturgy from "@/components/script/Dramaturgy";
import { ALL_SCENE_FIELD_PERMS } from "@/lib/script/scene-field-perms-shared";

vi.mock("@/components/shell/ProductionTopMenu", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/shell/ProductionTopMenu")>(),
  default: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  useProductionToolbar: () => ({ stage: 0, closeOverflow: vi.fn(), overflowOpen: false }),
  useAnchoredMenu: () => ({ anchorRef: { current: null }, menuRef: { current: null } }),
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS: "workspace-scroll",
  PRODUCTION_TOP_MENU_RIGHT_CLASS: "toolbar-right",
  PRODUCTION_TOOLBAR_STAGE: { primaryStored: 3, secondaryStored: 2 },
  ProductionTopMenuDivider: () => null,
  ProductionOverflowSubmenuButton: () => null,
}));
vi.mock("@/lib/agent/agent-mutations", () => ({ useAgentMutation: vi.fn() }));
vi.mock("@/components/script/TableViewSelector", () => ({ default: () => null }));
vi.mock("@/components/script/ScenesManager", () => ({ default: () => <p>列表内容</p> }));
vi.mock("@/components/script/SceneTableView", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/script/SceneTableView")>();
  return { ...actual, default: function FailureTable({ trackWrite }: { trackWrite: <T>(operation: Promise<T>) => Promise<T> }) {
    const [draft, setDraft] = useState("原值");
    const [error, setError] = useState(false);
    return <div>
      <input aria-label="失败字段" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => { void trackWrite(Promise.reject(new Error("保存被拒绝"))).catch(() => setError(true)); }}>保存字段</button>
      {error && <p role="alert">输入尚未保存</p>}
    </div>;
  } };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("实际页面切换列表/表格保留失败草稿，另一视图仍提示原操作未完成", async () => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ views: [] }) }));
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Dramaturgy productionId="draft-switch" productionName="测试" versionId="v" initialScenes={[]} openingChapterMarkerId={null} canEdit fieldPerms={ALL_SCENE_FIELD_PERMS} />));
    const input = host.querySelector<HTMLInputElement>('[aria-label="失败字段"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "失败草稿");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const click = async (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "保存字段")!.click());
    await click("列表");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("未完成的表格操作");
    await click("表格");
    expect(host.querySelector<HTMLInputElement>('[aria-label="失败字段"]')?.value).toBe("失败草稿");
    expect(host.textContent).toContain("输入尚未保存");
    expect(host.querySelector('header [role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});
