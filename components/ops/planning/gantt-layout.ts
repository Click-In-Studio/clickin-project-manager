// 甘特图名称列布局是纯客户端计算；本文件不得引入 node / DB 依赖。
export const GANTT_LABEL_MIN_PX = 96;
export const GANTT_LABEL_MAX_PX = 360;
export const GANTT_LABEL_DEFAULT_MAX_PX = 240;

export type GanttLabelWidthBounds = {
  min: number;
  max: number;
  initial: number;
};

/**
 * 名称列以当前可见区域为基准，而不是以 640px 的横向滚动画布为基准：
 * 初始值约占 1/3；用户拖宽后最多占一半，避免窄屏只剩名称看不到时间轴。
 */
export function ganttLabelWidthBounds(visibleWidth: number): GanttLabelWidthBounds {
  const width = Math.max(1, Math.floor(visibleWidth));
  const min = Math.min(GANTT_LABEL_MIN_PX, width);
  const max = Math.max(min, Math.min(GANTT_LABEL_MAX_PX, Math.floor(width / 2)));
  const initial = Math.max(min, Math.min(GANTT_LABEL_DEFAULT_MAX_PX, Math.floor(width / 3), max));
  return { min, max, initial };
}

export function clampGanttLabelWidth(value: number, visibleWidth: number): number {
  const { min, max } = ganttLabelWidthBounds(visibleWidth);
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function parseGanttLabelWidth(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
