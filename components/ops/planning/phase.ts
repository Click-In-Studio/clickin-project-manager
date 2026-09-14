import type { PlanningPhase } from "./types";

// 阶段条配色（按列表序循环；同一 phase 在日历/甘特同色）
export const PHASE_TONES = [
  { bg: "rgba(47,102,112,.16)", solid: "#2f6670" },
  { bg: "rgba(176,106,59,.16)", solid: "#b06a3b" },
  { bg: "rgba(83,80,120,.16)", solid: "#535078" },
  { bg: "rgba(95,112,64,.16)", solid: "#5f7040" },
  { bg: "rgba(138,68,52,.16)", solid: "#8a4434" },
];

export function phaseTone(index: number) {
  return PHASE_TONES[((index % PHASE_TONES.length) + PHASE_TONES.length) % PHASE_TONES.length];
}

export function phaseRangeLabel(p: PlanningPhase): string {
  return `${p.startDate} ~ ${p.endDate ?? "未定"}`;
}

/** 该日期（YYYY-MM-DD）是否落在阶段区间内；开放尾 = 从 start 起持续覆盖 */
export function phaseCoversDate(p: PlanningPhase, date: string): boolean {
  return date >= p.startDate && (p.endDate === null || date <= p.endDate);
}
