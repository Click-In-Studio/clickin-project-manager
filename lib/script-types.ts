export type Character = { id: string; name: string; isAggregate: boolean };
export type Scene = { id: string; number: string; name: string; parentId: string | null };
export type BlockType = "dialogue" | "stage";
export type Block = {
  id: string;
  type: BlockType;
  content: string;
  stageComment?: string | null;
  characterIds: string[];
  characterAnnotations: Record<string, string>;
  forceShowCharacterName?: boolean;
  lyric: boolean;
  sceneId: string | null;
  rehearsalMark: string | null;
};

export type PageLayout = "a4" | "letter" | "a3-2col" | "tablet-2col";
export type ScriptTextLayoutMode = "center" | "compact";

export type ScriptConfig = {
  stageDelimOpen: string;
  stageDelimClose: string;
  pageLayout: PageLayout;
  textLayoutMode: ScriptTextLayoutMode;
};

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  stageDelimOpen: "（",
  stageDelimClose: "）",
  pageLayout: "a4",
  textLayoutMode: "center",
};

export type ScriptState = {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  config: ScriptConfig;
};
