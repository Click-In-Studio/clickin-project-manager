// @vitest-environment jsdom
//
// #487 C3：CuePage 拖拽簇出 hook。钉住：按下后 5px 内不算拖；越过阈值后按鼠标位置解析锚点
// （gap 区 > 芯片列 > 正文块）并实时预览；松手按类型落库——move 两端同锚、expand 按锚序决定
// 哪端动、两端把手各改一端、原地不动不落库；落库后 justDraggedRef 置位吞掉紧随的 click。
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useCueDrag } from "@/components/ops/cue-page/use-cue-drag";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A0: CueAnchor = { kind: "block", blockId: "b0", offset: 0 };
const cue = { id: "c1", cueListId: "l1", number: "1", start: A0, end: A0 } as unknown as Cue;
const updateCueField = vi.fn(async () => {});
const blockIndexMap = new Map([["b0", 0], ["b1", 1], ["b2", 2]]);

type Snapshot = ReturnType<typeof useCueDrag>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
function Probe() {
  const blockIndexMapRef = useRef(blockIndexMap);
  const updateCueFieldRef = useRef(updateCueField);
  seen.push(useCueDrag({ cues: [cue], blockIndexMapRef, updateCueFieldRef }));
  return (
    <div>
      <div data-block-id="b1" data-testid="block1">正文</div>
      <div data-block-id="b2" data-testid="block2"><span data-gap-after="b2" data-testid="gap2" /></div>
      <div data-chip-col-for="b0" data-testid="chip0" />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
let pointTarget: Element | null = null;

beforeEach(() => {
  seen.length = 0;
  updateCueField.mockClear();
  document.body.style.cursor = "";
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => pointTarget;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)!;
function press(cueId: string, dragType: "move" | "expand" | "handle-start" | "handle-end", originalAnchor?: CueAnchor) {
  act(() => latest().startCueDrag({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 } as unknown as React.MouseEvent, cueId, dragType, originalAnchor));
}
function move(x: number, y: number, over: Element | null) {
  pointTarget = over;
  act(() => { document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true })); });
}
function release() { act(() => { document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }); }

describe("useCueDrag — 阈值与锚点解析", () => {
  it("5px 内不算拖：无预览、松手不落库、不吞 click", () => {
    press("c1", "move");
    move(3, 3, q("block1"));
    expect(latest().dragLive).toBe(null);
    release();
    expect(updateCueField).not.toHaveBeenCalled();
    expect(latest().justDraggedRef.current).toBe(false);
  });

  it("越过阈值：光标变十字，锚点按 gap > 芯片列 > 正文块 解析并预览", () => {
    press("c1", "move");
    move(10, 0, q("gap2"));
    expect(document.body.style.cursor).toBe("crosshair");
    expect(latest().dragLive).toEqual({ cueId: "c1", dragType: "move", anchor: { kind: "gap", afterBlockId: "b2" }, originalAnchor: null });
    move(12, 0, q("chip0"));
    expect(latest().dragLive?.anchor).toEqual({ kind: "block", blockId: "b0", offset: 0 });
    move(14, 0, q("block1"));
    expect(latest().dragLive?.anchor).toEqual({ kind: "block", blockId: "b1", offset: 0 });
    move(16, 0, container); // 不在任何锚点区：保持上一个锚点
    expect(latest().dragLive?.anchor).toEqual({ kind: "block", blockId: "b1", offset: 0 });
  });

  it("「:end」后缀的把手 id 去掉后缀再找 cue", () => {
    press("c1:end", "handle-end");
    move(10, 0, q("block1"));
    release();
    expect(updateCueField).toHaveBeenCalledWith(cue, { end: { kind: "block", blockId: "b1", offset: 0 }, warning: false });
  });
});

describe("useCueDrag — 松手落库", () => {
  const B1: CueAnchor = { kind: "block", blockId: "b1", offset: 0 };
  const B2: CueAnchor = { kind: "block", blockId: "b2", offset: 0 };

  it("move：两端同锚；光标复位、预览清空、justDragged 置位", () => {
    press("c1", "move");
    move(10, 0, q("block1"));
    release();
    expect(updateCueField).toHaveBeenCalledWith(cue, { start: B1, end: B1, warning: false });
    expect(document.body.style.cursor).toBe("");
    expect(latest().dragLive).toBe(null);
    expect(latest().justDraggedRef.current).toBe(true);
  });

  it("expand：拖到原锚之后 → 原锚做 start；之前 → 原锚做 end；原地 → 不落库", () => {
    press("c1", "expand", B1);
    move(10, 0, q("block2"));
    release();
    expect(updateCueField).toHaveBeenLastCalledWith(cue, { start: B1, end: B2, warning: false });

    press("c1", "expand", B2);
    move(10, 0, q("block1"));
    release();
    expect(updateCueField).toHaveBeenLastCalledWith(cue, { start: B1, end: B2, warning: false });

    updateCueField.mockClear();
    press("c1", "expand", B1);
    move(10, 0, q("block1"));
    release();
    expect(updateCueField).not.toHaveBeenCalled();
  });

  it("handle-start 只改 start", () => {
    press("c1", "handle-start");
    move(10, 0, q("block2"));
    release();
    expect(updateCueField).toHaveBeenCalledWith(cue, { start: B2, warning: false });
  });
});
