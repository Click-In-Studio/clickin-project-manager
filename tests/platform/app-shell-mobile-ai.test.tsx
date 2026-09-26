// @vitest-environment jsdom
//
// #702：手机底栏保持四个业务导航位，AI 是按档位出现的紧凑中央操作位；
// 对话面板在窄屏覆盖整个视口，收起只隐藏、不卸载正在运行的会话。
import { readFileSync } from "node:fs";
import { act, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MobileAiAction from "@/components/shell/app-shell/MobileAiAction";
import MobileTab from "@/components/shell/app-shell/MobileTab";

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onClick?.(event);
    }}>{children}</a>
  ),
}));

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

describe("#702 手机 AI 入口", () => {
  it("用固定宽度圆形按钮表达独立操作，打开态可被辅助技术识别", () => {
    const onClick = vi.fn();
    act(() => root.render(<MobileAiAction open onClick={onClick} />));

    const button = container.querySelector<HTMLButtonElement>("button[data-ai-toggle]")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("收起 AI 助手");
    expect(button.parentElement?.className).toContain("w-12");
    act(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("内容链接也执行关闭 AI 的回调，再交给路由导航", () => {
    const onClick = vi.fn();
    act(() => root.render(
      <MobileTab label="今日" symbol="⌂" active={false} href="/" onClick={onClick} />,
    ));

    act(() => container.querySelector<HTMLAnchorElement>("a")!.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("三个移动导航语境都复用档位门，面板本体允许窄屏显示", () => {
    const shell = readFileSync("components/shell/AppShell.tsx", "utf8");
    const popout = readFileSync("components/agent/AgentPopout.tsx", "utf8");

    expect(shell.match(/aiEntryVisible && <MobileAiAction/g)).toHaveLength(3);
    expect(shell).toContain("const aiEntryVisible = productionId ? (currentProduction?.planAi ?? false) : true");
    expect(popout).toContain("agent-mobile-full fixed");
    expect(popout).not.toMatch(/hidden[^\n]*lg:flex/);
    expect(popout).toContain("inert={!open}");

    const globalCss = readFileSync("app/globals.css", "utf8");
    const phonePanelRule = globalCss.match(/@media \(max-width: 1023px\) \{[\s\S]*?\.agent-mobile-full \{([\s\S]*?)\n  \}/)?.[1];
    expect(phonePanelRule).toContain("inset: 0 !important");
    expect(phonePanelRule).toContain("width: 100% !important");
    expect(phonePanelRule).toContain("max-width: none !important");
    expect(phonePanelRule).toContain("height: 100dvh !important");
  });
});
