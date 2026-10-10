// @vitest-environment jsdom
import React, { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCueSync } from "@/components/ops/cue-page/use-cue-sync";
import InlineField from "@/components/ops/cue-page/InlineField";
import type { Cue } from "@/lib/ops/cue-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cue = (listId: string, name: string): Cue => ({ id: `cue-${listId}`, cueId: `cue-${listId}`, cueListId: listId,
  number: "1", name, content: "初始内容", warning: false,
  start: { kind: "gap", afterBlockId: null }, end: { kind: "gap", afterBlockId: null } });
const initial = [cue("l1", "初始灯光"), cue("l2", "初始音响")];
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let calls: Array<{ url: string; method: string; body: unknown; request: ReturnType<typeof deferred> }>;
let root: Root, container: HTMLDivElement, sync: ReturnType<typeof useCueSync>;
function Probe({ version = "v1", snapshot = initial }: { version?: string; snapshot?: Cue[] }) {
  const current = useCueSync({ productionId: "p-sync", versionId: version, initialCues: snapshot,
    visibleListIdsRef: useRef(new Set(["l1", "l2"])), activeListIdRef: useRef("l1") });
  useLayoutEffect(() => { sync = current; });
  return <>{current.cues.map(c => <span key={c.id}>{c.name}</span>)}</>;
}
const current = (id = "l1") => sync.cues.find(c => c.cueListId === id)!;
const patches = () => calls.filter(call => call.method === "PATCH");
const gets = () => calls.filter(call => call.method === "GET");
async function respond(call: typeof calls[number], status: number, data: unknown) {
  await act(async () => call.request.resolve({ ok: status >= 200 && status < 300, status, json: async () => data }));
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function refetch() { act(() => sync.scheduleCueRefetch()); await tick(300); }
function save(fields = { name: "本地编辑" }) { act(() => { void sync.updateCueField(current(), fields); }); }
beforeEach(() => {
  vi.useFakeTimers(); calls = [];
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    const request = deferred();
    calls.push({ url, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined, request });
    return request.promise; // 故意不服从 abort：旧响应即使完成，也必须由结算边界拒绝。
  }));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Cue 弱网对账与写入时序（#934 / #936）", () => {
  it("首次挂载不重复读取", () => { expect(calls).toHaveLength(0); });
  it.each([403, 503])("HTTP %i 失败保留旧 Cue；200 空表才清空", async status => {
    await refetch(); await respond(gets()[0], status, {}); await respond(gets()[1], 200, []);
    expect(current().name).toBe("初始灯光"); expect(current("l2")).toBeUndefined(); expect(sync.readFailed).toBe(true);
    await tick(2000); await respond(gets().at(-1)!, 200, []);
    expect(current()).toBeUndefined(); expect(sync.readFailed).toBe(false);
  });
  it("断网保留旧表，连续失败后自动重试成功", async () => {
    await refetch(); await act(async () => gets()[0].request.reject(new TypeError("offline")));
    await respond(gets()[1], 200, [initial[1]]);
    await tick(2000); await respond(gets().at(-1)!, 503, {});
    expect(current().name).toBe("初始灯光");
    await tick(2000); await respond(gets().at(-1)!, 200, [cue("l1", "恢复后最新")]);
    expect(current().name).toBe("恢复后最新");
  });
  it("多表独立结算：一张悬挂或失败不阻止另一张更新", async () => {
    await refetch(); await respond(gets()[0], 200, [cue("l1", "最新灯光")]);
    expect(current().name).toBe("最新灯光"); expect(current("l2").name).toBe("初始音响");
    await respond(gets()[1], 503, {}); expect(current("l2").name).toBe("初始音响");
  });
  it("较旧成功或失败不能覆盖较新成功", async () => {
    await refetch(); await refetch();
    await respond(gets()[2], 200, [cue("l1", "最新灯光")]); await respond(gets()[3], 200, [cue("l2", "最新音响")]);
    await respond(gets()[0], 200, [initial[0]]); await respond(gets()[1], 503, {});
    expect(current().name).toBe("最新灯光"); expect(current("l2").name).toBe("最新音响"); expect(sync.readFailed).toBe(false);
  });
  it("保存前的读取晚到也不能回退成功保存", async () => {
    await refetch(); save(); expect(current().name).toBe("本地编辑");
    await respond(patches()[0], 200, { cue: cue("l1", "本地编辑") });
    await respond(gets()[0], 200, [initial[0]]); await respond(gets()[1], 200, [initial[1]]);
    expect(current().name).toBe("本地编辑"); expect(sync.saveStates.size).toBe(0);
  });
  it("保存失败保留草稿，自动重试仍带原始依据", async () => {
    save(); await respond(patches()[0], 503, {});
    expect(current().name).toBe("本地编辑"); expect(sync.saveStates.get(current().id)).toBe("waiting");
    await tick(2000);
    expect(patches()).toHaveLength(2); expect(patches()[1].body).toEqual({ name: "本地编辑", basis: { name: "初始灯光" } });
    await respond(patches()[1], 200, { cue: cue("l1", "本地编辑") }); expect(sync.saveStates.size).toBe(0);
  });
  it("新对账不能替旧草稿换依据；冲突后保留草稿且不自动重试", async () => {
    save(); await respond(patches()[0], 503, {});
    await tick(300); await respond(gets()[0], 200, [cue("l1", "别人的修改")]);
    expect(current().name).toBe("本地编辑");
    await tick(1700); expect(patches()[1].body).toEqual(patches()[0].body);
    await respond(patches()[1], 409, { error: "Cue 已被修改" });
    await tick(10000); expect(patches()).toHaveLength(2); expect(current().name).toBe("本地编辑");
    expect(sync.saveStates.get(current().id)).toBe("conflict");
    act(() => sync.discardConflicts()); expect(current().name).toBe("别人的修改");
  });
  it("同一 Cue 连续编辑串行保存，不会让旧写响应覆盖新草稿", async () => {
    save({ name: "第一笔" }); save({ name: "第二笔" });
    expect(patches()).toHaveLength(1); expect(current().name).toBe("第二笔");
    await respond(patches()[0], 200, { cue: cue("l1", "第一笔") });
    expect(patches()).toHaveLength(2); expect(patches()[1].body).toEqual({ name: "第二笔", basis: { name: "第一笔" } });
    expect(current().name).toBe("第二笔");
    await respond(patches()[1], 200, { cue: cue("l1", "第二笔") }); expect(sync.saveStates.size).toBe(0);
  });
  it("对账删除正在编辑或未同步的 Cue，不使本地草稿消失", async () => {
    act(() => sync.editingCue(current(), true)); await refetch(); await respond(gets()[0], 200, []);
    expect(current().name).toBe("初始灯光");
    save(); act(() => sync.editingCue(initial[0], false));
    await respond(patches()[0], 409, { error: "已删除" }); expect(current().name).toBe("本地编辑");
  });
  it("新建整表响应若跨过另一笔本地写入，不覆盖后者", () => {
    let finish!: ReturnType<typeof sync.beginListWrite>;
    act(() => { finish = sync.beginListWrite("l1"); });
    save(); act(() => finish(() => sync.replaceListCues("l1", [])));
    expect(current().name).toBe("本地编辑");
  });
  it("切换语境后旧读取和旧保存响应均不能写回新页面", async () => {
    await refetch(); save();
    act(() => root.render(<Probe version="v2" snapshot={[cue("l1", "新页面")]}/>));
    await respond(gets()[0], 200, [initial[0]]); await respond(patches()[0], 200, { cue: cue("l1", "旧保存") });
    expect(current().name).toBe("新页面"); expect(sync.saveStates.size).toBe(0);
  });
});

describe("Cue 输入依据", () => {
  it("聚焦中线上值更新，失焦提交仍携带开始编辑时的旧值", () => {
    const commit = vi.fn();
    act(() => root.render(<InlineField value="最初名称" onCommit={commit}/>));
    const input = container.querySelector("input")!;
    act(() => { input.focus(); });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "本地草稿");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => root.render(<InlineField value="线上新名称" onCommit={commit}/>));
    expect(input.value).toBe("本地草稿");
    act(() => input.blur()); expect(commit).toHaveBeenCalledWith("本地草稿", "最初名称");
  });
  it("Escape 不提交尚未同步的输入", () => {
    const commit = vi.fn();
    act(() => root.render(<InlineField value="原值" onCommit={commit}/>));
    const input = container.querySelector("input")!;
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "草稿");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(commit).not.toHaveBeenCalled(); expect(input.value).toBe("原值");
  });
});
