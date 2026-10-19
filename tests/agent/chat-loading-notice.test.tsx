// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChatLoadingNotice from "@/components/agent/ChatLoadingNotice";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("短时轻提示，八秒后才提示可能网络不佳；恢复与切换后重新计时", async () => {
  await act(async () => root.render(<ChatLoadingNotice active label="正在加载对话…" />));
  expect(container.textContent).toBe("正在加载对话…");
  await act(async () => vi.advanceTimersByTime(7_999));
  expect(container.textContent).not.toContain("网络");
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.textContent).toContain("可能网络不佳");
  await act(async () => root.render(<ChatLoadingNotice active={false} label="正在加载对话…" />));
  expect(container.textContent).toBe("");
  await act(async () => root.render(<ChatLoadingNotice active label="正在连接回复…" />));
  expect(container.textContent).toBe("正在连接回复…");
  await act(async () => vi.advanceTimersByTime(8_000));
  await act(async () => root.render(<ChatLoadingNotice key="other-session" active label="正在加载对话…" />));
  expect(container.textContent).toBe("正在加载对话…");
});
