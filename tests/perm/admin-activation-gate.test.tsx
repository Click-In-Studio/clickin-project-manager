// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import AdminActivationGate from "@/components/admin/AdminActivationGate";
import { PAGE_PERMISSION_SCOPES } from "@/lib/perm/page-permission-scopes";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => {}),
  usePendingPermissions: vi.fn(),
}));

vi.mock("@/hooks/usePendingPermissions", () => ({
  usePendingPermissions: mocks.usePendingPermissions,
}));

describe("AdminActivationGate", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    mocks.confirm.mockClear();
    mocks.usePendingPermissions.mockReset();
    mocks.usePendingPermissions.mockReturnValue({
      pending: ["node:member/*@create"],
      confirming: false,
      confirm: mocks.confirm,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("进入任一配置中心页面时使用统一管理权限 scope", async () => {
    await act(async () => root.render(
      <AdminActivationGate productionId="prod_admin_scope">
        <div>配置中心内容</div>
      </AdminActivationGate>,
    ));

    expect(mocks.usePendingPermissions).toHaveBeenCalledWith(
      "prod_admin_scope",
      PAGE_PERMISSION_SCOPES.admin,
    );
    expect(container.querySelector("[role=dialog]")?.textContent).toContain("激活管理权限");

    const activate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("一键激活"));
    await act(async () => activate?.click());
    expect(mocks.confirm).toHaveBeenCalledWith(["node:member/*@create"]);
  });

  it("没有待激活管理资格时不显示弹窗", async () => {
    mocks.usePendingPermissions.mockReturnValue({
      pending: [],
      confirming: false,
      confirm: mocks.confirm,
    });

    await act(async () => root.render(
      <AdminActivationGate productionId="prod_no_admin_scope">
        <div>配置中心内容</div>
      </AdminActivationGate>,
    ));

    expect(container.textContent).toContain("配置中心内容");
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });
});
