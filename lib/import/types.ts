// ─── Feishu Sheet ──────────────────────────────────────────────────────────────

export type SheetMeta = {
  sheetId: string;
  title: string;
  rowCount: number;
  columnCount: number;
};

export type SheetCell = string | null;
export type SheetRow = SheetCell[];
export type SheetData = {
  headers: string[]; // first non-empty row treated as headers
  rows: SheetRow[];  // remaining rows
  rawHeaders: SheetRow; // the actual first row (may include nulls)
};

// ─── Column Mapping ────────────────────────────────────────────────────────────

/** Identifies a column by its index (0-based) in the sheet. */
export type ColRef = number;
export type StageDelimiterPattern = "（）" | "【】" | "()" | "[]";
export type ScriptConfigStageDelimiterPattern = "（）" | "【】";

// Scene Info columns
export type SceneColMap = {
  sceneNum: ColRef;        // required
  sceneName?: ColRef;      // optional - may be embedded in sceneNum col
  intro?: ColRef;
  actionLine?: ColRef;
  music?: ColRef;
  stagePres?: ColRef;
  duration?: ColRef;
};

// Script block columns
export type ScriptColMap = {
  sceneNum: ColRef;        // required
  rehearsalMark?: ColRef;
  typeTag?: ColRef;
  character?: ColRef;
  stageComment?: ColRef;
  bodyColumns: ColRef[];   // one or more body columns, concatenated in order
  stageInlineColumns?: ColRef[]; // subset of bodyColumns treated as inline stage directions
  /** Bracket patterns in body text that are normalized as inline stage directions.
   *  Supported values: "（）" "【】" "()" "[]" */
  stageInlinePatterns?: StageDelimiterPattern[];
};

/** For each aggregate character: which base-character names are its members. */
export type AggregateMembers = Record<string, string[]>; // aggregateName → memberNames[]

// ─── Scene Number Parsing ──────────────────────────────────────────────────────

export type ParsedSceneNum = {
  raw: string;
  parentNum: string | null;  // e.g. "1" for top-level acts
  parentName: string | null; // e.g. "选择" from "1选择-1"
  childNum: string | null;   // e.g. "1-1"
  childName: string | null;  // e.g. "供养" from "1-1 供养"
};

// ─── Character Parsing ─────────────────────────────────────────────────────────

export type CharKind = "normal" | "aggregate" | "note";

export type ParsedChar = {
  raw: string;
  name: string;
  kind: CharKind;
  note?: string;
};

// ─── Type/Tag Mapping ──────────────────────────────────────────────────────────

export type TypeAction =
  | { action: "ignore" }
  | { action: "mapTag"; groupId: string; optionId: string }
  | { action: "mapType"; blockType: "dialogue" | "stage" | "lyric" | "marker" };

export type TypeTagMapping = Record<string, TypeAction>; // rawValue → action

// ─── Import Preview ────────────────────────────────────────────────────────────

export type SceneConflict =
  | { kind: "nameMismatch"; sceneNum: string; existing: string; incoming: string }
  | { kind: "orderConflict"; sceneNum: string; existingOrder: number; incomingOrder: number }
  | { kind: "parentMissing"; sceneNum: string; parentNum: string }
  | { kind: "markerMissing"; sceneNum: string };

export type ImportScenePreview = {
  scenesToAdd: { num: string; name: string; parentNum: string | null }[];
  scenesToUpdate: { num: string; oldName: string; newName: string }[];
  metaToUpdate: number; // existing scenes that will have detail fields written
  conflicts: SceneConflict[];
};

export type CharConflict =
  | { kind: "aggregateMismatch"; name: string; existingAggregate: boolean; incomingAggregate: boolean };

export type ImportScriptPreview = {
  charsToAdd: { name: string; isAggregate: boolean }[];
  charsToUpdate: { name: string; oldAggregate: boolean; newAggregate: boolean }[];
  charConflicts: CharConflict[];
  blockCount: number;
  warningRehearsalMarks: string[];  // marks that don't match expected pattern
};
