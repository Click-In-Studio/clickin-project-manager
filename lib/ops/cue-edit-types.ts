import type { Cue, CueAnchor } from "./cue-types";

export const CUE_EDIT_FIELDS = ["number", "name", "content", "start", "end", "warning"] as const;
export type CueEditField = typeof CUE_EDIT_FIELDS[number];
export type CueFieldPatch = Partial<Pick<Cue, CueEditField>>;
export type CuePatchBasis = CueFieldPatch;
export type CueSaveStatus = "saving" | "waiting" | "failed" | "conflict";

export class CuePatchConflict extends Error {
  constructor() { super("CUE_PATCH_CONFLICT"); }
}

export function sameCueField(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  const left = a as CueAnchor, right = b as CueAnchor;
  return left.kind === right.kind && (left.kind === "gap"
    ? right.kind === "gap" && left.afterBlockId === right.afterBlockId
    : right.kind === "block" && left.blockId === right.blockId && left.offset === right.offset);
}

export function normalizeCuePatch(fields: CueFieldPatch): CueFieldPatch {
  return Object.fromEntries(CUE_EDIT_FIELDS.flatMap(key => fields[key] === undefined ? [] : [
    [key, typeof fields[key] === "string" ? fields[key].trim() : fields[key]],
  ])) as CueFieldPatch;
}

/** 依据来自编辑开始时；改变任一锚点时同时检查起止，防止拼出未曾存在的范围。 */
export function buildCuePatchBasis(cue: Cue, fields: CueFieldPatch): CuePatchBasis {
  const keys = CUE_EDIT_FIELDS.filter(key => fields[key] !== undefined);
  if (fields.start !== undefined || fields.end !== undefined) {
    if (!keys.includes("start")) keys.push("start");
    if (!keys.includes("end")) keys.push("end");
  }
  return Object.fromEntries(keys.map(key => [key, cue[key]])) as CuePatchBasis;
}

/** 调用方在锁内核对后写入；已达到目标的字段不重写，其他字段不能覆盖陈旧依据。 */
export function conditionCuePatch(current: Cue, fields: CueFieldPatch, basis: CuePatchBasis): CueFieldPatch {
  const patch = normalizeCuePatch(fields);
  const changed = CUE_EDIT_FIELDS.filter(key => patch[key] !== undefined && !sameCueField(current[key], patch[key]));
  for (const key of CUE_EDIT_FIELDS.filter(key => patch[key] !== undefined)) {
    if (!Object.hasOwn(basis, key)) throw new CuePatchConflict();
  }
  for (const key of changed) {
    if (!sameCueField(current[key], basis[key])) throw new CuePatchConflict();
  }
  if (changed.includes("start") || changed.includes("end")) {
    for (const key of ["start", "end"] as const) {
      if (!Object.hasOwn(basis, key) || !sameCueField(current[key], basis[key])) throw new CuePatchConflict();
    }
  }
  return Object.fromEntries(changed.map(key => [key, patch[key]])) as CueFieldPatch;
}
