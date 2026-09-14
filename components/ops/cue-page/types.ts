import type { CueList } from "@/lib/ops/cue-list-types";
import type { Cue, CueAnchor } from "@/lib/ops/cue-types";
import type { Block, Character, Scene } from "@/lib/script/script-types";

export type CueViewState = { visibleIds: string[]; activeId: string | null };
export type CueSequenceItem =
  | { kind: "gap"; afterBlockId: string }
  | { kind: "marker"; block: Block };

// "expand": drag a point cue outward to form a range (direction determined by drag direction)
export type DragType = "move" | "expand" | "handle-start" | "handle-end";

export type DragStateRef = {
  active: boolean;
  dragType: DragType;
  cueId: string;
  startX: number;
  startY: number;
  thresholdMet: boolean;
  liveAnchor: CueAnchor | null;
  originalAnchor: CueAnchor | null;
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type Props = {
  productionId: string;
  productionName: string;
  blocks: Block[];
  characters: Character[];
  scenes: Scene[];
  cueLists: CueList[];
  initialCues: Cue[];
  editableListIds: string[];
  manageListIds: string[];
  myUserId: string;
  isAdmin: boolean;
  pageMap: Record<string, number>;
  versionId?: string;
};

export type Selection =
  | { kind: "none" }
  | { kind: "cue"; cueId: string }
  | { kind: "pending"; start: CueAnchor; end: CueAnchor };

export type DragConfig = { dragType: DragType; origAnchor?: CueAnchor };

export type CueMark = {
  offset: number;
  colorHex: string;
  selected: boolean;
  cueId: string;
  dragConfig?: DragConfig;
};

export type GuideLineData = {
  cueId: string; color: string;
  chipX: number; chipY: number; markX: number; markY: number;
};

// ─── Comment types ───────────────────────────────────────────────────────────

export type Mention = { userId: string; name: string };

export type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  userId: string;
  authorName: string;
  body: string;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

// ─── Presence ────────────────────────────────────────────────────────────────

export type CuePresence = {
  clientId: string;
  userName: string;
  color: string;
  listId: string | null;
  cueId: string | null;
};
