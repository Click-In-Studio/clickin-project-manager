import { describe, expect, it } from "vitest";
import { suggestionMenuLayout } from "@/lib/editor-floating-menu";

describe("suggestionMenuLayout", () => {
  it("opens above a caret near the bottom edge", () => {
    const layout = suggestionMenuLayout(
      { left: 640, top: 650, bottom: 670 },
      { width: 1280, height: 700 },
    );
    expect(layout.placement).toBe("top");
    expect(layout.top).toBe(646);
    expect(layout.maxHeight).toBe(256);
  });

  it("opens below when there is sufficient space", () => {
    const layout = suggestionMenuLayout(
      { left: 120, top: 80, bottom: 100 },
      { width: 1280, height: 700 },
    );
    expect(layout.placement).toBe("bottom");
    expect(layout.top).toBe(104);
  });

  it("clamps the right edge and reduces height in a short viewport", () => {
    const layout = suggestionMenuLayout(
      { left: 1180, top: 110, bottom: 130 },
      { width: 1280, height: 240 },
    );
    expect(layout.left).toBe(912);
    expect(layout.maxHeight).toBeLessThan(256);
  });
});
