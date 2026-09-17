import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCursorRelay, applyPeerCursor } from "@/lib/wiki/collab-cursor";

// #515：光标是纯位置量，远端拿新坐标套旧文档会乱跳。本地脏时压住独立通道、搭保存
// 那一笔的 update 帧；干净时才走 400ms 节流的 presence POST。

describe("createCursorRelay", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make(dirty: { v: boolean }) {
    const post = vi.fn();
    const relay = createCursorRelay({ isDirty: () => dirty.v, post, throttleMs: 400 });
    return { relay, post };
  }

  it("干净：trailing 节流，发的是最后一个位置", () => {
    const { relay, post } = make({ v: false });
    relay.report({ blockIndex: 0, offset: 1 });
    relay.report({ blockIndex: 0, offset: 2 });
    vi.advanceTimersByTime(399);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ blockIndex: 0, offset: 2 });
  });

  it("脏：不走独立通道；保存取走后标记已送，afterSave 不补发", () => {
    const dirty = { v: true };
    const { relay, post } = make(dirty);
    relay.report({ blockIndex: 3, offset: 7 });
    vi.advanceTimersByTime(1000);
    expect(post).not.toHaveBeenCalled();
    const c = relay.takeForSave();
    expect(c).toEqual({ blockIndex: 3, offset: 7 });
    relay.markSent(c);
    dirty.v = false;
    relay.afterSave();
    vi.advanceTimersByTime(1000);
    expect(post).not.toHaveBeenCalled();
  });

  it("节流窗口内用户开始打字（变脏）：到点不发，留给保存带走", () => {
    const dirty = { v: false };
    const { relay, post } = make(dirty);
    relay.report({ blockIndex: 1, offset: 0 });
    dirty.v = true;
    vi.advanceTimersByTime(400);
    expect(post).not.toHaveBeenCalled();
    expect(relay.takeForSave()).toEqual({ blockIndex: 1, offset: 0 });
  });

  it("保存提前返回（没带上光标）→ afterSave 干净时经独立通道补发", () => {
    const dirty = { v: true };
    const { relay, post } = make(dirty);
    relay.report({ blockIndex: 2, offset: 5 });
    relay.takeForSave(); // 空标题/无变化：保存路径没调 markSent
    dirty.v = false;
    relay.afterSave();
    vi.advanceTimersByTime(400);
    expect(post).toHaveBeenCalledWith({ blockIndex: 2, offset: 5 });
  });

  it("PATCH 在飞期间光标又动了：保存结束后干净 → 补发最新位置", () => {
    const dirty = { v: true };
    const { relay, post } = make(dirty);
    relay.report({ blockIndex: 2, offset: 5 });
    const c = relay.takeForSave();
    relay.markSent(c);
    relay.report({ blockIndex: 2, offset: 9 }); // 请求在飞
    dirty.v = false;
    relay.afterSave();
    vi.advanceTimersByTime(400);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ blockIndex: 2, offset: 9 });
  });

  it("takeForSave 撤掉独立通道的计时器：同一位置不会既搭车又单发", () => {
    const { relay, post } = make({ v: false });
    relay.report({ blockIndex: 0, offset: 3 });
    const c = relay.takeForSave();
    relay.markSent(c);
    vi.advanceTimersByTime(1000);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("applyPeerCursor", () => {
  const peers = [
    { clientId: "a", blockIndex: 0, offset: 0 },
    { clientId: "b", blockIndex: 1, offset: 1 },
  ];

  it("发起端在表里：只改它的光标，其余引用不变", () => {
    const next = applyPeerCursor(peers, "b", { blockIndex: 4, offset: 2 });
    expect(next).not.toBe(peers);
    expect(next[0]).toBe(peers[0]);
    expect(next[1]).toEqual({ clientId: "b", blockIndex: 4, offset: 2 });
  });

  it("发起端不在表里（SSE 已断）：不造幽灵条目，返回原引用", () => {
    expect(applyPeerCursor(peers, "zzz", { blockIndex: 4, offset: 2 })).toBe(peers);
  });

  it("帧不带光标（AI 写入 / 老帧）或无发起端：原样返回", () => {
    expect(applyPeerCursor(peers, "b", undefined)).toBe(peers);
    expect(applyPeerCursor(peers, null, { blockIndex: 4, offset: 2 })).toBe(peers);
  });

  it("null 光标=阅读态：清成 null", () => {
    const next = applyPeerCursor(peers, "a", null);
    expect(next[0]).toEqual({ clientId: "a", blockIndex: null, offset: null });
  });

  it("位置没变：返回原引用（免无谓重渲染）", () => {
    expect(applyPeerCursor(peers, "b", { blockIndex: 1, offset: 1 })).toBe(peers);
  });
});
