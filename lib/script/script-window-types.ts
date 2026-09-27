// 客户端可安全引用的剧本分窗协议；只含类型，不得引入数据库或 Node 依赖。
import type { Block, Character, MarkerMeta, Scene, ScriptConfig } from "./script-types";
import type { BlockTagValue, TagGroup } from "./script-block-tag-db";

/**
 * 整本只下发结构骨架，正文、角色挂载与批注按窗口加载。
 * 骨架保留稳定 id 与 marker 投影，供目录、虚拟高度和完整顺序写协议使用。
 */
export type ScriptBlockManifestEntry = {
  id: string;
  type: Block["type"];
  lyric: boolean;
  sceneId: string | null;
  rehearsalMark: string | null;
  ownerMarkerId?: string | null;
  markerMeta?: MarkerMeta | null;
};

export type ScriptWindowSlice = {
  start: number;
  blocks: Block[];
  tags: BlockTagValue[];
};

export type ScriptWindowBootstrap = {
  versionId: string;
  orderRevision: string;
  manifest: ScriptBlockManifestEntry[];
  window: ScriptWindowSlice;
  scenes: Scene[];
  characters: Character[];
  config: ScriptConfig;
  tagGroups: TagGroup[];
  pageMap: Record<string, number>;
};

export type ScriptWindowResponse = {
  versionId: string;
  orderRevision: string;
  totalCount: number;
  window: ScriptWindowSlice;
};

export function manifestEntryToSkeleton(entry: ScriptBlockManifestEntry): Block {
  return {
    id: entry.id,
    type: entry.type,
    lyric: entry.lyric,
    content: "",
    stageComment: null,
    forceShowCharacterName: false,
    characterIds: [],
    characterAnnotations: {},
    sceneId: entry.sceneId,
    rehearsalMark: entry.rehearsalMark,
    ownerMarkerId: entry.ownerMarkerId,
    markerMeta: entry.markerMeta,
  };
}
