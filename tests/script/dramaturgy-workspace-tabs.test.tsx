// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DramaturgyWorkspaceHeading } from "@/components/script/DramaturgyWorkspaceTabs";
import {
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
} from "@/components/shell/ProductionTopMenu";

vi.mock("next/link", () => ({
  default: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DramaturgyWorkspaceHeading compact menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(
      <ProductionToolbarContext.Provider value={{
        stage: PRODUCTION_TOOLBAR_STAGE.primaryShort,
        closeOverflow: () => {},
        overflowOpen: false,
        hasStoredControls: false,
        setHasStoredControls: () => {},
      }}>
        <DramaturgyWorkspaceHeading
          productionId="demo-misty-harbor"
          productionName="雾港"
          active="overview"
        />
      </ProductionToolbarContext.Provider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function trigger() {
    return container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  }

  function menu() {
    return container.querySelector<HTMLElement>('nav[aria-label="构作工作区"]');
  }

  function click(target: EventTarget) {
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  }

  it("opens and closes when the trigger is clicked repeatedly", () => {
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
    expect(trigger().querySelector("svg")?.classList.contains("self-center")).toBe(true);

    click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu()).not.toBeNull();

    click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("closes immediately on an outside pointerdown", () => {
    click(trigger());
    expect(menu()).not.toBeNull();

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("keeps inside pointerdown open and preserves the menu-item destination before closing", () => {
    click(trigger());
    const characters = [...container.querySelectorAll<HTMLAnchorElement>("a")]
      .find((link) => link.textContent === "角色")!;

    act(() => characters.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).not.toBeNull();
    expect(characters.getAttribute("href")).toBe("/production/demo-misty-harbor/characters");

    click(characters);
    expect(menu()).toBeNull();
  });
});
