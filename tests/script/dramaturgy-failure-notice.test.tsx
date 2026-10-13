// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DramaturgyFailureNotice from "@/components/script/DramaturgyFailureNotice";
import { useDramaturgyWorkspaceMode } from "@/components/script/use-dramaturgy-workspace-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
function Harness({ context = "table" }: { context?: string }) {
  const workspace = useDramaturgyWorkspaceMode("notice-test", true);
  return <>
    <DramaturgyFailureNotice error={workspace.error} revision={workspace.errorRevision} context={context} />
    <output>{workspace.error}</output>
    <button onClick={() => { void workspace.trackWrite(Promise.reject(new Error("操作失败"))).catch(() => {}); }}>失败</button>
  </>;
}
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); localStorage.clear(); });
async function render(context = "table") { await act(async () => root.render(<Harness context={context} />)); }
async function fail() { await act(async () => host.querySelector("button")!.click()); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)); }
it("三秒收起短提示，保留真实失败状态，同文案再次失败重新计时", async () => {
  await render(); await fail();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await advance(2000); await fail(); await advance(2000);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await advance(1000);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("output")?.textContent).toBe("操作失败");
});
it("切换视图清理短提示定时器，不重新展示旧失败；卸载也清理", async () => {
  await render(); await fail();
  expect(vi.getTimerCount()).toBe(1);
  await render("list");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await fail();
  expect(vi.getTimerCount()).toBe(1);
  act(() => root.unmount()); root = createRoot(host);
  expect(vi.getTimerCount()).toBe(0);
});
