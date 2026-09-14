export const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  meeting: "会议",
  custom: "其他",
};
export const SCHEDULE_ITEM_TYPE_LABELS: Record<string, string> = {
  scene_rehearsal: "场景排练",
  fitting: "服装",
  sound_check: "音响",
  tech_rehearsal: "技排",
  meeting: "会议",
  break: "休息",
  custom: "其他",
};
export const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", published: "已发布", completed: "已完成", cancelled: "已取消",
};
export const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-500",
  published: "bg-blue-50 text-blue-600",
  completed: "bg-green-50 text-green-600",
  cancelled: "bg-red-50 text-red-400",
};
export const TECH_STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};
export const TECH_STATUS_COLORS: Record<string, string> = {
  awaiting: "bg-purple-50 text-purple-500",
  pending: "bg-amber-50 text-amber-600",
  in_progress: "bg-blue-50 text-blue-600",
  done: "bg-green-50 text-green-600",
};
