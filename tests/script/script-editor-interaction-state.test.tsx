// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptDocument } from "@/components/script/script-editor/script-document";
import { ScriptSelection } from "@/components/script/script-editor/script-selection-state";
import { ScriptNavigation } from "@/components/script/script-editor/script-navigation";
import { ScriptWindowRequests } from "@/components/script/script-editor/script-window-requests";
import { useScriptDrag } from "@/components/script/script-editor/use-script-drag";
import { useScriptHistory } from "@/components/script/script-editor/use-script-history";
import { makeBlock } from "@/lib/script/script-block-stream";
import { DEFAULT_SCRIPT_CONFIG, type Block } from "@/lib/script/script-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const block = (id: string, type: Block["type"] = "dialogue"): Block => ({ ...makeBlock(), id, type });
let rows: Block[];
let drag!: ReturnType<typeof useScriptDrag>;
let history!: ReturnType<typeof useScriptHistory>;
let root: Root;
let container: HTMLDivElement;
function Probe() {
  const nextDrag = useScriptDrag();
  const nextHistory = useScriptHistory(() => rows, next => { rows = next; });
  useLayoutEffect(() => { drag = nextDrag; history = nextHistory; }, [nextDrag, nextHistory]);
  return null;
}
function DocumentHistoryProbe({ document }: { document: ScriptDocument }) {
  const nextHistory = useScriptHistory(() => document.getSnapshot().blocks, document.editBlockStructure);
  useLayoutEffect(() => { history = nextHistory; }, [nextHistory]);
  return null;
}
beforeEach(() => {
  rows = [block("a"), block("b")];
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("编辑器交互状态的共同维护", () => {
  it("连续输入合并成一次撤销，redo 和新操作裁剪保持原有块快照语义", () => {
    const original = rows;
    act(() => history.startTyping());
    rows = [block("first")];
    act(() => history.startTyping());
    rows = [block("second")];
    act(() => history.undo());
    expect(rows).toBe(original);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    act(() => history.redo());
    expect(rows[0].id).toBe("second");
    act(() => history.record());
    rows = [block("third")];
    act(() => history.undo());
    expect(rows[0].id).toBe("second");
    act(() => history.record());
    expect(history.canRedo).toBe(false);
  });

  it("恢复清理撤销栈和输入计时器，之后不会撤回恢复前内容", () => {
    act(() => history.startTyping());
    rows = [block("new")];
    act(() => history.reset());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    act(() => history.undo());
    expect(rows[0].id).toBe("new");
  });

  it("拖拽目标、无效原因和结束一次清理，下一次拖拽不会继承上次目标", () => {
    const controller = drag.drag;
    act(() => { controller.begin(["a", "b"]); controller.setTarget({ kind: "block", id: "c", position: "before" }); controller.reject("invalid"); });
    expect(drag.snapshot.dragging).toBe(true);
    expect(controller.read()!.invalidReason).toBe("invalid");
    act(() => { controller.end(); });
    expect(controller.read()).toBeNull();
    expect(drag.snapshot).toEqual({ dragging: false, target: null });
    act(() => controller.begin(["c"]));
    expect(controller.read()).toEqual({ ids: ["c"], target: null, invalidReason: null });
    expect(drag.drag).toBe(controller);
  });

  it("段落多选端点随正文重排、删除与标记转换重新校正", () => {
    rows = [block("marker", "scene_marker"), block("a"), block("b")];
    const selection = new ScriptSelection(() => rows);
    selection.selectOne("marker");
    selection.clickText("a", { shiftKey: true, additive: false });
    expect(selection.validate(["marker", "a"])).toBe(true);
    rows = [rows[1], rows[0], rows[2]];
    selection.reconcile();
    expect(selection.getSnapshot().markerEndIds).toEqual(new Set(["marker"]));
    expect(selection.validate(["marker", "a"])).toBe(false);
    rows = [block("marker"), rows[2]];
    selection.reconcile();
    expect(selection.getSnapshot().selectedIds).toEqual(new Set(["marker"]));
    expect(selection.getSnapshot().markerEndIds.size).toBe(0);
    rows = [rows[1]];
    selection.reconcile();
    expect(selection.getSnapshot().anchorId).toBeNull();
    expect(selection.getSnapshot().selectedIds.size).toBe(0);
  });

  it("定位等待使用稳定 id，重排更新加载索引，目标删除取消等待", () => {
    const navigation = new ScriptNavigation();
    navigation.waitForBlock("b", 200, "center");
    navigation.reconcile(new Map([["b", 50]]));
    expect(navigation.getSnapshot()!.index).toBe(50);
    expect(navigation.takeLoadedTarget(new Set(["other"]))).toBeNull();
    expect(navigation.takeLoadedTarget(new Set(["b"]))).toMatchObject({ id: "b", align: "center" });
    expect(navigation.getSnapshot()).toBeNull();
    navigation.waitForBlock("b", 100, "start");
    navigation.reconcile(new Map());
    expect(navigation.getSnapshot()).toBeNull();
  });

  it("用户滚动取消主动跳转与二次校正，阅读锚点保持独立", () => {
    const navigation = new ScriptNavigation();
    navigation.refreshAtAnchor({ id: "a", top: 20 });
    navigation.jump({ id: "b", kind: "block", align: "center" });
    navigation.completeJump(true);
    navigation.cancelJump();
    expect(navigation.readCorrection()).toBeNull();
    expect(navigation.readPending()).toBeNull();
    expect(navigation.readAnchor()).toEqual({ id: "a", top: 20 });
    expect(navigation.consumeRefresh()).toBe(true);
    expect(navigation.consumeRefresh()).toBe(false);
    navigation.stop();
    expect(navigation.readAnchor()).toBeNull();
  });

  it("恢复或前台插队取消旧预取，迟到回包不能成为当前请求", () => {
    const requests = new ScriptWindowRequests();
    const background = requests.begin("background");
    const foreground = requests.begin("foreground");
    expect(background.controller.signal.aborted).toBe(true);
    expect(requests.isCurrent(background)).toBe(false);
    requests.finish(background);
    expect(requests.isBusy()).toBe(true);
    requests.cancelBackground();
    expect(requests.isCurrent(foreground)).toBe(true);
    requests.cancel();
    expect(requests.isCurrent(foreground)).toBe(false);
  });

  it("历史恢复通过正文维护者重建标记投影和开场配置", () => {
    const document = new ScriptDocument({
      versionId: "head", orderRevision: "r", manifest: [], window: { start: 0, blocks: [], tags: [] },
      scenes: [], characters: [], config: DEFAULT_SCRIPT_CONFIG, tagGroups: [], pageMap: {},
    });
    document.editBlockStructure([block("chapter", "chapter_marker"), block("text")]);
    const snapshot = document.getSnapshot();
    expect(snapshot.config.openingChapterMarkerId).toBe("chapter");
    expect(snapshot.ownedBlocks.find(row => row.id === "text")!.ownerMarkerId).toBe("chapter");
    expect(snapshot.scenes.length).toBeGreaterThan(0);
    expect(snapshot.sceneDetails.map(scene => scene.id)).toEqual(snapshot.scenes.map(scene => scene.id));
    act(() => root.render(<DocumentHistoryProbe document={document} />));
    act(() => history.record());
    document.editBlockStructure([snapshot.blocks[0], block("rehearsal", "rehearsal_marker"), ...snapshot.blocks.slice(1)]);
    expect(document.getSnapshot().ownedBlocks.find(row => row.id === "text")!.ownerMarkerId).toBe("rehearsal");
    act(() => history.undo());
    expect(document.getSnapshot().ownedBlocks.find(row => row.id === "text")!.ownerMarkerId).toBe("chapter");
    expect(document.getSnapshot().rehearsalLabels.rehearsalLabelByMarkerId.has("rehearsal")).toBe(false);
    act(() => history.redo());
    expect(document.getSnapshot().ownedBlocks.find(row => row.id === "text")!.ownerMarkerId).toBe("rehearsal");
    expect(document.getSnapshot().rehearsalLabels.rehearsalLabelByMarkerId.has("rehearsal")).toBe(true);
  });
});
