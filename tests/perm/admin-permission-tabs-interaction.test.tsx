// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPermissionCenterClient from "@/components/admin/AdminPermissionCenterClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function mount() {
  await act(async () => {
    root.render(
      <AdminPermissionCenterClient
        productionId="prod-tabs"
        productionName="测试项目"
        depts={[]}
        initialDeptRows={{}}
        initialRoles={[]}
        members={[]}
        initialOverrides={{}}
        vocabulary={{ verbs: {}, subs: {} }}
        initialApprovers={[]}
        delegableTypes={[]}
        nonDelegableTypes={[]}
        caps={{
          deptView: true,
          deptEdit: false,
          roleView: true,
          roleEdit: false,
          overrideView: true,
          overrideEdit: false,
          approverView: true,
          approverEdit: false,
          rootOperation: false,
        }}
      />,
    );
  });
}

const tab = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent === label)!;

describe("权限中心顶部页签交互", () => {
  it("点击页签会更新选中态、面板关联并保持选中项可见", async () => {
    await mount();
    expect(tab("部门权限").getAttribute("aria-selected")).toBe("true");

    await act(async () => { tab("人事权限").click(); });

    expect(tab("人事权限").getAttribute("aria-selected")).toBe("true");
    expect(tab("人事权限").tabIndex).toBe(0);
    expect(tab("部门权限").tabIndex).toBe(-1);
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"))
      .toBe("permission-tab-override");
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("方向键与 Home/End 在四个页签间移动焦点和选中态", async () => {
    await mount();
    const first = tab("部门权限");
    first.focus();

    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(tab("角色权限"));
    expect(tab("角色权限").getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      tab("角色权限").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(tab("资源审批人"));
    expect(tab("资源审批人").getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      tab("资源审批人").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-selected")).toBe("true");
  });
});
