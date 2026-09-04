// asset 类型词汇表：唯一真相源（client-safe，勿引入 pg 等服务端依赖）。
// 此前 ASSET_TYPE_LABELS 在 4 个组件里各有一份副本，asset_type 列无 CHECK 约束，
// API 也不校验——写入非法值会让前端 ASSET_TYPE_LABELS[t].includes() 抛错。

export const ASSET_TYPES = [
  "drafting", "planogram", "demo", "rehearsal_video", "reference",
  "material", "clip", "qlab", "score", "recording",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  drafting: "图纸", planogram: "平面图", demo: "Demo",
  rehearsal_video: "排练视频", reference: "Reference", material: "素材",
  clip: "片段", qlab: "QLab", score: "乐谱", recording: "录音",
};

export function isAssetType(v: unknown): v is AssetType {
  return typeof v === "string" && (ASSET_TYPES as readonly string[]).includes(v);
}
