import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  listCueLists, createCueList, getCueList, updateCueList, deleteCueList,
  createCue, getCue, listCues, updateCue, deleteCue,
} from "@/lib/db";
import { TEST_USER } from "./helpers";
import { makeProduction, cleanupProduction, shortId } from "./factories";

let prodId: string;
const CL_ID  = `cl-${shortId()}`;
const CUE_ID = `cue-${shortId()}`;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
});

afterAll(async () => {
  await deleteCue(CUE_ID, CL_ID).catch(() => {});
  await deleteCueList(CL_ID, prodId).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("cue list CRUD", () => {
  it("createCueList creates a new cue list", async () => {
    await createCueList({
      id: CL_ID, productionId: prodId,
      name: "单元测试走位表", notes: "", abbr: null,
      template: null, defaultEditRoles: [], createdBy: TEST_USER,
    });
    const cl = await getCueList(CL_ID, prodId);
    expect(cl).not.toBeNull();
    expect(cl!.name).toBe("单元测试走位表");
  });

  it("listCueLists includes the created cue list", async () => {
    expect((await listCueLists(prodId)).some((l) => l.id === CL_ID)).toBe(true);
  });

  it("updateCueList renames it", async () => {
    await updateCueList(CL_ID, prodId, { name: "单元测试走位表（改名）" });
    expect((await getCueList(CL_ID, prodId))!.name).toBe("单元测试走位表（改名）");
  });

  it("getCueList returns null for wrong production", async () => {
    expect(await getCueList(CL_ID, "wrong-prod")).toBeNull();
  });
});

describe("cue CRUD", () => {
  const anchor = { kind: "gap" as const, afterBlockId: null };

  it("createCue adds a cue with gap anchor", async () => {
    await createCue({ id: CUE_ID, cueListId: CL_ID, number: "Q1", name: "开场", content: "", start: anchor, end: anchor });
    const cue = await getCue(CUE_ID, CL_ID);
    expect(cue).not.toBeNull();
    expect(cue!.number).toBe("Q1");
  });

  it("listCues includes the created cue", async () => {
    expect((await listCues(CL_ID)).some((c) => c.id === CUE_ID)).toBe(true);
  });

  it("updateCue changes the name", async () => {
    await updateCue(CUE_ID, CL_ID, { name: "开场（已修改）" });
    expect((await getCue(CUE_ID, CL_ID))!.name).toBe("开场（已修改）");
  });

  it("deleteCue removes the cue", async () => {
    await deleteCue(CUE_ID, CL_ID);
    expect(await getCue(CUE_ID, CL_ID)).toBeNull();
  });
});
