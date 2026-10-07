// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScriptModeMenu from "@/components/script/script-editor/ScriptModeMenu";
import RehearsalModeDialog from "@/components/script/script-editor/RehearsalModeDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("剧本个人模式菜单", () => {
  it("窄屏由外层更多菜单承载，仍渲染可操作的模式面板", () => {
    const onSelect = vi.fn();
    act(() => root.render(
      <ScriptModeMenu
        compact
        open
        currentLabel="只读"
        selectedMode="read"
        canSelectEdit
        pending={false}
        error=""
        menuClassName="menu"
        onToggle={() => {}}
        onSelect={onSelect}
      />,
    ));
    expect(container.querySelector('[data-script-toolbar-menu-trigger="mode"]')?.className).toContain("hidden");
    expect(container.querySelector('[data-production-overflow-menu-child="true"]')).not.toBeNull();
    const edit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("编辑"));
    act(() => edit?.click());
    expect(onSelect).toHaveBeenCalledWith("edit");
  });

  it("无内容编辑能力时保留编辑项但禁用，并显示保存错误", () => {
    act(() => root.render(
      <ScriptModeMenu
        compact={false}
        open
        currentLabel="只读"
        selectedMode="read"
        canSelectEdit={false}
        pending={false}
        error="尚有内容未保存"
        menuClassName="menu"
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    ));
    const edit = container.querySelector('button[role="menuitemradio"]') as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toContain("没有剧本内容编辑权限");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("尚有内容未保存");
  });
});

describe("排练模式切换对话框", () => {
  it("保存中锁住关闭和确认，失败原因保持可见", () => {
    act(() => root.render(
      <RehearsalModeDialog entering pending error="尚有内容未保存" onClose={() => {}} onConfirm={() => {}} />,
    ));
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain("保存中…");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("尚有内容未保存");
  });
});
