// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DramaturgyWorkspaceHeading } from "@/components/script/DramaturgyWorkspaceTabs";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("工作区切换始终是一个完整标签功能块，原导航顺序和目标保留", () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<DramaturgyWorkspaceHeading productionId="demo-misty-harbor" active="overview" />));
  const block = container.querySelector('[data-toolbar-block="workspace"]')!;
  const links = [...block.querySelectorAll("a")];
  expect(links.map(link => link.textContent)).toEqual(["构作视图", "角色", "灵感文档"]);
  expect(links[0].getAttribute("aria-current")).toBe("page");
  expect(links.map(link => link.getAttribute("href"))).toEqual([
    "/production/demo-misty-harbor/dramaturgy", "/production/demo-misty-harbor/characters", "/production/demo-misty-harbor/dramaturgy/inspiration",
  ]);
  act(() => root.unmount()); container.remove();
});
