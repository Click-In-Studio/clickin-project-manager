export type Character = { id: string; name: string };
export type Scene = { id: string; number: string; name: string };
export type BlockType = "dialogue" | "stage";
export type Block = {
  id: string;
  type: BlockType;
  content: string;
  characterIds: string[];
  lyric: boolean;
  sceneId: string | null;
  rehearsalMark: string | null;
};

export type ScriptState = {
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
};
