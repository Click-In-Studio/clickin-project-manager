/**
 * 项目类型清单（单一事实源）——此前在 NewProductionModal 与 AdminSettingsClient 里
 * 各抄了一份，加一个类型要改两处。
 *
 * 类型同时是**项目模版的唯一入口**（`TEMPLATE_BY_TYPE`）：建项目选类型 = 选一套模版。
 * 不给「角色用 A、部门用 B」的组合面——角色模版与部门模版并不真正正交。
 */
export const PRODUCTION_TYPES = [
  { value: "stage_play",     label: "话剧" },
  { value: "theatre",        label: "舞台剧" },
  { value: "musical",        label: "音乐剧" },
  { value: "gala",           label: "综合晚会" },
  { value: "music_festival", label: "音乐节" },
  { value: "concert",        label: "音乐会" },
  { value: "short_film",     label: "短片" },
  { value: "film",           label: "电影" },
  { value: "tv_drama",       label: "电视剧" },
  { value: "music_video",    label: "音乐 MV" },
  { value: "radio_drama",    label: "广播剧" },
  { value: "album",          label: "专辑 / 单曲" },
  { value: "other",          label: "其他" },
] as const;

export type ProductionTypeValue = (typeof PRODUCTION_TYPES)[number]["value"];

export function productionTypeLabel(value: string | null | undefined): string | null {
  return PRODUCTION_TYPES.find((t) => t.value === value)?.label ?? null;
}
