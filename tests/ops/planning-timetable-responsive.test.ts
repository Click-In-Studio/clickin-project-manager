import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RUNDOWN_LANE_MIN_WIDTH,
  rundownGridColumns,
  rundownPinnedLeft,
} from "@/components/ops/planning/rundown-layout";

const source = readFileSync("components/ops/planning/TimetableView.tsx", "utf8");
const css = readFileSync("components/ops/planning.module.css", "utf8");

describe("执行日程响应式密度", () => {
  it("控件组在中窄屏变为主项跨列的两列，手机变为单列", () => {
    expect(source).toContain("styles.rundownControls");
    expect(source).toContain("styles.rundownControlPrimary");
    expect(css).toContain("grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, .8fr)");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain(".rundownControls { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(css).toContain(".rundownControlPrimary { grid-column: 1 / -1; }");
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toContain(".rundownControls { grid-template-columns: minmax(0, 1fr); }");
    expect(css).toContain(".rundownControlPrimary { grid-column: auto; }");
  });

  it("控件允许收缩，并提升标签与选择值的字号", () => {
    expect(css).toMatch(/\.rundownControlCard\s*\{[\s\S]*?min-width: 0;[\s\S]*?min-height: 52px;/);
    expect(css).toMatch(/\.rundownControlLabel\s*\{[\s\S]*?font-size: 10px;/);
    expect(css).toMatch(/\.rundownControlSelect\s*\{[\s\S]*?min-width: 0;[\s\S]*?font-size: 12px;/);
  });

  it("泳道的网格、固定表头与固定事项共用紧凑尺寸", () => {
    expect(rundownGridColumns([{ pinned: true }, { pinned: true }, { pinned: false }]))
      .toBe("72px 132px 132px minmax(132px, 1fr)");
    expect(rundownPinnedLeft(0)).toBe(72);
    expect(rundownPinnedLeft(1)).toBe(72 + RUNDOWN_LANE_MIN_WIDTH);
    expect(rundownPinnedLeft(2)).toBe(72 + RUNDOWN_LANE_MIN_WIDTH * 2);

    expect(source).toContain("gridTemplateColumns: rundownGridColumns(lanes)");
    expect(source).toContain("top: hasLocationRow ? RUNDOWN_LOCATION_HEIGHT : 0");
    expect(source).toContain("left: lane.pinned ? rundownPinnedLeft(pinnedIndex)");
    expect(source).toContain("left: sticky ? rundownPinnedLeft(pinnedIndex)");
    expect(css).toContain(".rundownLaneTitle { font-size: 12px; line-height: 28px; }");
  });

  it("滚动容器建立独立层叠上下文，拖拽缩放入口不再被事项裁切", () => {
    expect(css).toMatch(/\.rundownMatrixWrap\s*\{[\s\S]*?overflow: auto;[\s\S]*?isolation: isolate;/);
    expect(css).toContain(".rundownColumnHeader:focus-within");
    expect(source).toContain("className={styles.rundownEntry}");
    expect(css).toContain(".rundownEntry { overflow: visible; }");
  });
});
