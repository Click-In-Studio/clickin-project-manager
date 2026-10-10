// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScriptRecovery } from "@/components/script/script-editor/use-script-recovery";
import { readFileSync } from "node:fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let recovery: ReturnType<typeof useScriptRecovery>;
const pause = vi.fn();
const reconcile = vi.fn<() => Promise<void>>();
function Probe() {
  const current = useScriptRecovery({ pause, reconcile });
  useLayoutEffect(() => { recovery = current; });
  return <div>{current.status}</div>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  pause.mockReset();
  reconcile.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("剧本恢复时序（#933）", () => {
  it("首次挂载不重复加载", () => {
    expect(container.textContent).toBe("ready");
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("连接已恢复，但快照未应用时持续显示重连中并禁止保存", async () => {
    const load = deferred();
    reconcile.mockReturnValueOnce(load.promise);
    act(() => recovery.suspend());
    expect(recovery.suspendedRef.current).toBe(true);
    let done!: Promise<void>;
    await act(async () => { done = recovery.recover(); await Promise.resolve(); });
    expect(container.textContent).toBe("reconnecting");
    expect(reconcile).toHaveBeenCalledTimes(1);
    await act(async () => { load.resolve(); await done; });
    expect(container.textContent).toBe("ready");
    expect(recovery.suspendedRef.current).toBe(false);
  });
  it("重复恢复信号串行对账，不并发；读取期间的新修改要求再读", async () => {
    const load = deferred();
    reconcile.mockReturnValueOnce(load.promise);
    let first!: Promise<void>;
    await act(async () => { first = recovery.recover(); await Promise.resolve(); });
    act(() => { void recovery.recover(); void recovery.recover(); });
    expect(reconcile).toHaveBeenCalledTimes(1);
    await act(async () => { load.resolve(); await first; });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("ready");
  });
  it("失败后不解锁，重试成功才恢复编辑", async () => {
    reconcile.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await recovery.recover(); });
    expect(container.textContent).toBe("failed");
    expect(recovery.suspendedRef.current).toBe(true);
    await act(async () => { await recovery.recover(); });
    expect(container.textContent).toBe("ready");
  });
  it("恢复过程中再次断线，旧加载完成不能宣告恢复成功", async () => {
    const load = deferred();
    reconcile.mockReturnValueOnce(load.promise);
    let done!: Promise<void>;
    await act(async () => { done = recovery.recover(); await Promise.resolve(); });
    act(() => recovery.suspend());
    await act(async () => { load.resolve(); await done; });
    expect(container.textContent).toBe("reconnecting");
    expect(recovery.suspendedRef.current).toBe(true);
    await act(async () => { await recovery.recover(); });
    expect(container.textContent).toBe("ready");
  });
});

describe("真实 ScriptEditor 接线守卫", () => {
  const editor = readFileSync("components/script/ScriptEditor.tsx", "utf8");
  it("隐藏暂停写入，恢复建连与自动重连都触发恢复", () => {
    expect(editor).toContain("if (!streamVisible && streamStartedRef.current) suspendRecovery()");
    expect(editor).toContain("nextEs.onopen = () =>");
    expect(editor).toContain("nextEs.onerror = () =>");
    expect(editor).toContain("if (opened || recoverySuspendedRef.current)");
    expect(editor).toContain('type: "connected"');
    expect(editor).toContain("if (!receivedConnection && recoverySuspendedRef.current) void recoverScript();");
    expect(editor).toContain('type: "join"');
  });
  it("恢复先等待在途保存，带旧依据提交，再丢弃旧工作态重载窗口", () => {
    const reconcile = editor.slice(editor.indexOf("reconcile: async () =>"), editor.indexOf("useLayoutEffect(() => {\n    recoveryTriggerRef"));
    expect(reconcile.indexOf("await sync.waitForIdle()")).toBeGreaterThan(-1);
    expect(reconcile.indexOf("await sync.waitForIdle()")).toBeLessThan(reconcile.indexOf("await sync.flush(true)"));
    expect(reconcile.indexOf("await sync.flush(true)")).toBeLessThan(reconcile.indexOf("await fetchScriptWindowBootstrap"));
    expect(reconcile).toContain("applyWindowBootstrap(bootstrap, true)");
    expect(reconcile).toContain("sync.resetAfterRecovery()");
    expect(reconcile).toContain("if (sync.isStopped()) return");
    expect(editor).toContain("{ ...batch.patch, basis: batch.basis }");
  });
  it("正常窗口与骨架刷新都交给正文维护者，组件不单独改保存基线", () => {
    expect(editor).toContain("script.applyBootstrap(bootstrap, replace)");
    expect(editor).toContain("script.mergeWindow(body)");
    expect(editor).not.toMatch(/syncedStateRef|syncedBlockTagMapRef|loadedBlockIdsRef/);
  });
  it("重连、失败与冲突有明确提示", () => {
    expect(editor).toContain('"重连失败，暂时无法编辑" : "重连中…"');
    expect(editor).toContain("剧本已被他人修改，部分本地修改未上传，已加载最新内容");
  });
});
