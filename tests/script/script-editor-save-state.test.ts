import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptDocument } from "@/components/script/script-editor/script-document";
import { ScriptSync, type ScriptSyncOptions } from "@/components/script/script-editor/script-sync";
import type { ScriptSaveBatch } from "@/components/script/script-editor/script-save-batch";
import { makeBlock } from "@/lib/script/script-block-stream";
import { DEFAULT_SCRIPT_CONFIG } from "@/lib/script/script-types";
import { ScriptPatchConflict } from "@/lib/script/script-patch-basis";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function setup(send: ScriptSyncOptions["send"]) {
  const document = new ScriptDocument();
  document.replaceServer({ blocks: [{ ...makeBlock(), id: "a", content: "old" }], scenes: [], characters: [], config: DEFAULT_SCRIPT_CONFIG });
  const options = { canWrite: () => true, ready: () => true, send, afterSave: vi.fn(async () => {}), onConflict: vi.fn() };
  const sync = new ScriptSync(document, options);
  const stop = sync.start();
  return { document, sync, options, stop, edit: (content: string) => document.editBlocks(rows => rows.map(row => row.id === "a" ? { ...row, content } : row)) };
}
const savedContent = (batch: ScriptSaveBatch) => batch.patch.blockOps.flatMap(op => op.op === "update" ? [op.block.content] : []);
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

describe("编辑器串行保存与恢复", () => {
  it("两个 flush 等待同一在途请求，再冲刷等待期间的新输入", async () => {
    const first = deferred<number>(), second = deferred<number>();
    const send = vi.fn<ScriptSyncOptions["send"]>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { sync, edit, stop, document } = setup(send);
    cleanups.push(stop);
    edit("first");
    const saving = sync.save();
    await Promise.resolve();
    const flush1 = sync.flush(), flush2 = sync.flush();
    edit("second");
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await saving;
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(savedContent(send.mock.calls[0][0])).toEqual(["first"]);
    expect(savedContent(send.mock.calls[1][0])).toEqual(["second"]);
    second.resolve(2);
    expect(await flush1).toBe(true);
    expect(await flush2).toBe(true);
    expect(document.hasPending()).toBe(false);
  });

  it("连续输入不延长 maxWait；到五秒发送当时的最新正文", async () => {
    const send = vi.fn<ScriptSyncOptions["send"]>(async () => 1);
    const { edit, stop } = setup(send);
    cleanups.push(stop);
    for (let i = 0; i < 10; i++) { edit(String(i)); await vi.advanceTimersByTimeAsync(500); }
    expect(send).toHaveBeenCalledTimes(1);
    expect(savedContent(send.mock.calls[0][0])).toEqual(["9"]);
  });

  it("保存失败保留依据与修改，重试时发送最新内容", async () => {
    const send = vi.fn<ScriptSyncOptions["send"]>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(2);
    const { sync, edit, stop, document } = setup(send);
    cleanups.push(stop);
    edit("first");
    const basis = document.prepareSave(0)!.basis;
    expect(await sync.flush()).toBe(false);
    expect(sync.getSnapshot().waitingForNetwork).toBe(true);
    edit("latest");
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].basis).toEqual(basis);
    expect(savedContent(send.mock.calls[1][0])).toEqual(["latest"]);
    expect(document.hasPending()).toBe(false);
    expect(sync.getSnapshot().waitingForNetwork).toBe(false);
  });

  it("暂停停止自动提交，恢复 flush 仍可先保存后建立新基线", async () => {
    const send = vi.fn<ScriptSyncOptions["send"]>(async () => 1);
    const { sync, edit, stop } = setup(send);
    cleanups.push(stop);
    edit("pending");
    sync.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(await sync.flush()).toBe(false);
    expect(await sync.flush(true)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("停止后旧失败响应不安排重试，旧成功响应不再刷新 UI", async () => {
    const flight = deferred<number>();
    const { sync, options, edit, stop } = setup(() => flight.promise);
    edit("pending");
    const saving = sync.save();
    await Promise.resolve();
    stop();
    flight.reject(new Error("offline"));
    expect(await saving).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(options.afterSave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("冲突提示保留到用户关闭，但成功恢复后的下一次恢复不能跳过新的本地修改", async () => {
    const send = vi.fn<ScriptSyncOptions["send"]>().mockRejectedValueOnce(new ScriptPatchConflict()).mockResolvedValue(2);
    const { sync, document, edit, stop, options } = setup(send);
    cleanups.push(stop);
    edit("conflict");
    expect(await sync.flush()).toBe(true);
    expect(sync.needsConflictReload()).toBe(true);
    await Promise.resolve();
    expect(options.onConflict).toHaveBeenCalledTimes(1);
    document.replaceServer({ ...document.read(), blocks: [{ ...makeBlock(), id: "a", content: "server" }] });
    sync.resetAfterRecovery();
    expect(sync.getSnapshot().conflict).toBe(true);
    expect(sync.needsConflictReload()).toBe(false);
    edit("new local");
    sync.pause();
    expect(await sync.flush(true)).toBe(true);
    expect(savedContent(send.mock.calls[1][0])).toEqual(["new local"]);
  });
});
