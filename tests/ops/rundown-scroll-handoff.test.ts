import { describe, expect, it } from "vitest";
import {
  advanceScrollHandoff,
  beginScrollGesture,
  endScrollGesture,
  initialScrollHandoffState,
  syncScrollBoundary,
  type ScrollHandoffState,
} from "@/components/ops/planning/rundown-scroll-handoff";

const METRICS = { scrollTop: 400, scrollHeight: 1_000, clientHeight: 400 };

function finish(state: ScrollHandoffState): ScrollHandoffState {
  return endScrollGesture(state);
}

describe("Rundown 滚动边界交接状态机", () => {
  it("内部没有纵向滚动范围时立即交给外层", () => {
    const result = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "down",
      30,
      { scrollTop: 0, scrollHeight: 400, clientHeight: 400 },
    );

    expect(result.action).toBe("outer");
    expect(result.boundary).toBeNull();
    expect(result.state).toEqual(initialScrollHandoffState());
  });

  it("内部仍可滚动时只滚内部，首次到底停在边界", () => {
    let state = beginScrollGesture(initialScrollHandoffState());
    const inside = advanceScrollHandoff(state, "down", 80, METRICS);
    expect(inside.action).toBe("inner");

    state = inside.state;
    const arriving = advanceScrollHandoff(state, "down", 250, { ...METRICS, scrollTop: 500 });
    expect(arriving.action).toBe("stop");
    expect(arriving.boundary).toBe("bottom");

    const sameGesture = advanceScrollHandoff(arriving.state, "down", 40, { ...METRICS, scrollTop: 600 });
    expect(sameGesture.action).toBe("stop");
  });

  it("到底后下一次同向独立手势交给外层", () => {
    const first = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "down",
      20,
      { ...METRICS, scrollTop: 590 },
    );
    expect(first.action).toBe("stop");

    const second = advanceScrollHandoff(
      beginScrollGesture(finish(first.state)),
      "down",
      20,
      { ...METRICS, scrollTop: 600 },
    );
    expect(second.action).toBe("outer");
  });

  it("方向反转时解除交接，回到内部滚动", () => {
    const bottom = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "down",
      20,
      { ...METRICS, scrollTop: 590 },
    );
    const reversed = advanceScrollHandoff(
      bottom.state,
      "up",
      20,
      { ...METRICS, scrollTop: 600 },
    );
    expect(reversed.action).toBe("inner");
    expect(reversed.state.armedBoundary).toBeNull();
  });

  it("离开已武装的边界后重置，再次到边界仍先停一次", () => {
    const bottom = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "down",
      20,
      { ...METRICS, scrollTop: 590 },
    );
    const reset = syncScrollBoundary(finish(bottom.state), { ...METRICS, scrollTop: 550 });
    expect(reset.armedBoundary).toBeNull();

    const arrivesAgain = advanceScrollHandoff(
      beginScrollGesture(reset),
      "down",
      60,
      { ...METRICS, scrollTop: 550 },
    );
    expect(arrivesAgain.action).toBe("stop");
  });

  it("亚像素边界误差保留交接，真正离开边界才重置", () => {
    const bottom = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "down",
      2,
      { ...METRICS, scrollTop: 599.25 },
    );
    expect(bottom.action).toBe("stop");

    const subpixelEdge = syncScrollBoundary(finish(bottom.state), { ...METRICS, scrollTop: 599.25 });
    expect(subpixelEdge.armedBoundary).toBe("bottom");
    expect(advanceScrollHandoff(
      beginScrollGesture(subpixelEdge),
      "down",
      1,
      { ...METRICS, scrollTop: 599.25 },
    ).action).toBe("outer");

    const leftEdge = syncScrollBoundary(finish(bottom.state), { ...METRICS, scrollTop: 598.75 });
    expect(leftEdge.armedBoundary).toBeNull();
  });

  it("顶部遵循同样的首次停住、第二次交接规则", () => {
    const first = advanceScrollHandoff(
      beginScrollGesture(initialScrollHandoffState()),
      "up",
      20,
      { ...METRICS, scrollTop: 10 },
    );
    expect(first.action).toBe("stop");
    expect(first.boundary).toBe("top");

    const second = advanceScrollHandoff(
      beginScrollGesture(finish(first.state)),
      "up",
      20,
      { ...METRICS, scrollTop: 0 },
    );
    expect(second.action).toBe("outer");
  });
});
