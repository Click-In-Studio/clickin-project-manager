export type Character = { id: string; name: string; isAggregate: boolean; memberIds?: string[] };
export type Scene = { id: string; number: string; name: string; parentId: string | null };
export type BlockType = "dialogue" | "stage" | "chapter_marker" | "scene_marker" | "rehearsal_marker";
export type MarkerMeta = {
  number?: string;
  name?: string;
  parentMarkerId?: string | null;
  synopsis?: string;
  actionLine?: string;
  music?: string;
  stageNotes?: string;
  expectedDuration?: string;
};
export type Block = {
  id: string;
  type: BlockType;
  content: string;
  stageComment?: string | null;
  characterIds: string[];
  characterAnnotations: Record<string, string>;
  forceShowCharacterName?: boolean;
  lyric: boolean;
  ownerMarkerId?: string | null;
  sceneId: string | null;
  rehearsalMark: string | null;
  markerMeta?: MarkerMeta | null;
};

export type PageLayout = "a4" | "letter" | "a3-2col" | "tablet-2col";
export type ScriptTextLayoutMode = "center" | "compact";

export type ScriptConfig = {
  stageDelimOpen: string;
  stageDelimClose: string;
  pageLayout: PageLayout;
  textLayoutMode: ScriptTextLayoutMode;
  openingChapterMarkerId: string | null;
  showOpeningChapter: boolean;
};

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  stageDelimOpen: "（",
  stageDelimClose: "）",
  pageLayout: "a4",
  textLayoutMode: "center",
  openingChapterMarkerId: null,
  showOpeningChapter: false,
};

export type ScriptState = {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  config: ScriptConfig;
};
