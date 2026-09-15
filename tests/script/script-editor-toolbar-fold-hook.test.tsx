// @vitest-environment jsdom
//
// #487 S4：ScriptEditor 工具栏三级折叠出 hook。量的是 scrollWidth vs clientWidth：放不下就降一级
// （full → short → compact），回到「全宽 + 16px 回滞」才升回去；挂在项目顶栏槽位里不自量；
// 菜单开着 / 正在离开页面时不量；顶栏自己的折叠阶段优先于本地测量。
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PRODUCTION_TOOLBAR_STAGE, type ProductionToolbarStage } from "@/components/shell/ProductionTopMenu";
import { useScriptToolbarFold } from "@/components/script/script-editor/use-script-toolbar-fold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} disconnect() {} unobserve() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopObserver;

type Snapshot = ReturnType<typeof useScriptToolbarFold>;
const seen: Snapshot[] = [];
const latest = () => seen[seen.length - 1];
const closeToolbarMenu = vi.fn();
// 三档各自的所需宽度：切档后 DOM 真的变窄，scrollWidth 要跟着档位走，否则一次降级会连降到底。
// 这是简化代理——按「上一次渲染出的档位」报宽，不模拟真实布局多帧收敛；钉的是每次测量只走一级
// 与回滞阈值，不是布局时序。
const NEED = { full: 800, short: 600, compact: 400 } as const;
const size = { client: 1000 };
let menuOpen: "x" | null = null;

function Probe({ stage, versionId }: { stage: ProductionToolbarStage; versionId: string | null }) {
  const navigatingAwayRef = useRef(false);
  const toolbarOpenMenuRef = useRef<"x" | null>(menuOpen);
  toolbarOpenMenuRef.current = menuOpen;
  const s = useScriptToolbarFold({
    toolbarStage: stage, navigatingAwayRef, toolbarOpenMenuRef: toolbarOpenMenuRef as never, closeToolbarMenu,
    activeVersionId: versionId, isLockedMode: false, canEditMetadata: true,
  });
  seen.push(s);
  return <div ref={s.setToolbarElement} data-testid="toolbar" />;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seen.length = 0;
  closeToolbarMenu.mockReset();
  menuOpen = null;
  size.client = 1000;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return size.client; } });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return NEED[(seen[seen.length - 1]?.toolbarMode ?? "full") as keyof typeof NEED]; } });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render(stage: ProductionToolbarStage = PRODUCTION_TOOLBAR_STAGE.full, versionId: string | null = "v1") {
  act(() => root.render(<Probe stage={stage} versionId={versionId} />));
}
/** 改尺寸后触发重量（真实场景由 ResizeObserver 驱动；这里用 setToolbarElement 的 tick） */
function remeasure(client: number) {
  size.client = client;
  act(() => latest().setToolbarElement(container.querySelector('[data-testid="toolbar"]') as HTMLDivElement));
}

describe("useScriptToolbarFold — 三级折叠与回滞", () => {
  it("放得下保持 full；放不下 full→short→compact 逐级降", () => {
    render();
    expect(latest().toolbarMode).toBe("full");
    expect(latest().toolbarCompact).toBe(false);
    remeasure(700); // full 需要 800 > 700 → short（600 放得下）
    expect(latest().toolbarMode).toBe("short");
    expect(latest().toolbarShort).toBe(true);
    remeasure(500); // short 需要 600 > 500 → compact
    expect(latest().toolbarMode).toBe("compact");
    expect(latest().toolbarCompact).toBe(true);
  });

  it("升级要过回滞：compact 回 short 需 ≥ short 宽 + 16；回 full 需 ≥ full 宽 + 16", () => {
    render();
    remeasure(500); // full 800 > 500 → short；short 600 > 500 → compact
    expect(latest().toolbarMode).toBe("compact");
    remeasure(610); // 600 + 16 = 616 > 610：不够
    expect(latest().toolbarMode).toBe("compact");
    remeasure(616);
    expect(latest().toolbarMode).toBe("short");
    remeasure(815);
    expect(latest().toolbarMode).toBe("short");
    remeasure(816);
    expect(latest().toolbarMode).toBe("full");
  });

  it("菜单开着时不量", () => {
    render();
    menuOpen = "x";
    remeasure(700);
    expect(latest().toolbarMode).toBe("full");
  });
});

describe("useScriptToolbarFold — 与项目顶栏阶段的关系", () => {
  it("顶栏阶段到 primaryShort / primaryStored 时本地未折也按 short / compact 走；lowPriorityStored 折 presence", () => {
    render(PRODUCTION_TOOLBAR_STAGE.primaryShort);
    expect(latest().toolbarShort).toBe(true);
    expect(latest().toolbarCompact).toBe(false);
    render(PRODUCTION_TOOLBAR_STAGE.primaryStored);
    expect(latest().toolbarCompact).toBe(true);
    expect(latest().toolbarShort).toBe(false);
    expect(latest().presenceFolded).toBe(false);
    render(PRODUCTION_TOOLBAR_STAGE.lowPriorityStored);
    expect(latest().presenceFolded).toBe(true);
  });

  it("版本切换即重置为 full 并关菜单；resetToolbarMeasurement(false) 不关菜单", () => {
    render();
    remeasure(700);
    expect(latest().toolbarMode).toBe("short");
    closeToolbarMenu.mockClear();
    render(PRODUCTION_TOOLBAR_STAGE.full, "v2");
    expect(closeToolbarMenu).toHaveBeenCalled();
    // 重置后 tick 未变、宽度仍放不下 → 重量会再次降级；这里只看 reset 本身
    act(() => latest().resetToolbarMeasurement(false));
    expect(closeToolbarMenu).toHaveBeenCalledTimes(1);
  });
});
