// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import PermissionActivationModal from "@/components/perm/PermissionActivationModal";

const PENDING = [
  "node:script/*/blocks@view",
  "node:character/*/members@view",
  "node:cue_list/*/cues@view",
  "node:event/*/meta@view",
  "node:report/*/replies@create",
  "node:asset/*@create",
  "node:finance/*/expenses@create",
  "node:dept/*/notes@create",
  "node:wiki/*/meta@view",
];

describe("PermissionActivationModal responsive layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(
      <PermissionActivationModal
        pending={PENDING}
        confirming={false}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        title="开通查看权限"
      />,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the dialog inside the dynamic viewport and accounts for safe areas", () => {
    const overlay = container.firstElementChild as HTMLDivElement;
    const dialog = overlay.querySelector<HTMLElement>("[role=dialog]")!;

    expect(overlay.style.paddingTop).toContain("safe-area-inset-top");
    expect(overlay.style.paddingBottom).toContain("safe-area-inset-bottom");
    expect(dialog.style.maxHeight).toContain("100dvh");
    expect(dialog.style.maxHeight).toContain("safe-area-inset-bottom");
  });

  it("scrolls only the permission list while keeping wrapped actions reachable", () => {
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    const body = dialog.children[1] as HTMLElement;
    const footer = dialog.children[2] as HTMLElement;
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>("button")];

    expect(dialog.style.display).toBe("flex");
    expect(body.style.overflowY).toBe("auto");
    expect(body.style.overflowX).toBe("hidden");
    expect(body.style.minHeight).toBe("0px");
    expect(footer.style.flexWrap).toBe("wrap");
    expect(buttons.map(button => button.style.minHeight)).toEqual(["44px", "44px"]);
    expect(buttons[1].textContent).toBe(`一键激活（${PENDING.length} 项）`);
  });
});
