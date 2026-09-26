import type { RundownColumn } from "./rundown-types";

export const RUNDOWN_TIME_WIDTH = 72;
export const RUNDOWN_LANE_MIN_WIDTH = 132;
export const RUNDOWN_LOCATION_HEIGHT = 28;
export const RUNDOWN_HEADER_HEIGHT = 44;

/**
 * 固定列必须保持与 sticky left 相同的宽度；否则少列时 1fr 会把固定列拉宽，
 * 后一个固定列仍按最小宽度偏移，横向滚动后就会叠在前一个固定列上。
 */
export function rundownGridColumns(lanes: Pick<RundownColumn, "pinned">[]): string {
  const laneColumns = lanes.map(lane => lane.pinned
    ? `${RUNDOWN_LANE_MIN_WIDTH}px`
    : `minmax(${RUNDOWN_LANE_MIN_WIDTH}px, 1fr)`
  );
  return [`${RUNDOWN_TIME_WIDTH}px`, ...laneColumns].join(" ");
}

export function rundownPinnedLeft(pinnedIndex: number): number {
  return RUNDOWN_TIME_WIDTH + pinnedIndex * RUNDOWN_LANE_MIN_WIDTH;
}
