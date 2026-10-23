// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChatMarkdown from "@/components/agent/ChatMarkdown";

vi.mock("@/components/wiki/StreamingWikiMarkdown", () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }));
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
it("50ms 窗口持续收到快照也按期刷新最新值，不会一直 debounce 等到结束", async () => {
  await act(async () => root.render(<ChatMarkdown content="" streaming />));
  for (let i = 1; i <= 7; i++) {
    await act(async () => root.render(<ChatMarkdown content={"字".repeat(i)} streaming />));
    await act(async () => vi.advanceTimersByTime(7));
  }
  expect(container.textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.textContent).toBe("字".repeat(7));
});
it("停止或正常结束立即显示最终全文并取消剩余定时器", async () => {
  await act(async () => root.render(<ChatMarkdown content="初始" streaming />));
  await act(async () => root.render(<ChatMarkdown content="等待中的内容" streaming />));
  await act(async () => root.render(<ChatMarkdown content="最终完整内容" streaming={false} />));
  expect(container.textContent).toBe("最终完整内容");
  await act(async () => vi.advanceTimersByTime(100));
  expect(container.textContent).toBe("最终完整内容");
});
it("切会话隔离缓冲；重连开始新一轮时保留已经完成的文字", async () => {
  await act(async () => root.render(<ChatMarkdown key="one" content="旧会话" streaming />));
  await act(async () => root.render(<ChatMarkdown key="one" content="旧会话未刷新部分" streaming />));
  await act(async () => root.render(<ChatMarkdown key="two" content="新会话" streaming={false} />));
  await act(async () => vi.advanceTimersByTime(100));
  expect(container.textContent).toBe("新会话");
  await act(async () => root.render(<ChatMarkdown key="two" content="新会话继续" streaming />));
  expect(container.textContent).toBe("新会话");
  await act(async () => vi.advanceTimersByTime(50));
  expect(container.textContent).toBe("新会话继续");
});
