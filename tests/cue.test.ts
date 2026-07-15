import { describe, it, expect, afterAll } from "vitest";
import {
  listCueLists, createCueList, getCueList, updateCueList, deleteCueList,
  createCue, getCue, listCues, updateCue, deleteCue,
} from "@/lib/db";
import { PROD_HOSHINO, TEST_USER } from "./helpers";

const CL_ID  = "test-cl-unit";
const CUE_ID = "test-cue-unit";

afterAll(async () => {
  await deleteCue(CUE_ID, CL_ID).catch(() => {});
  await deleteCueList(CL_ID, PROD_HOSHINO).catch(() => {});
});

describe("cue lists (seed data)", () => {
  it("listCueLists returns at least one cue list for 我们的星星", async () => {
    expect((await listCueLists(PROD_HOSHINO)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("cue list CRUD", () => {
  it("createCueList creates a new cue list", async () => {
    await createCueList({
      id: CL_ID, productionId: PROD_HOSHINO,
      name: "单元测试走位表", notes: "", abbr: null,
      template: null, defaultEditRoles: [], createdBy: TEST_USER,
    });
    const cl = await getCueList(CL_ID, PROD_HOSHINO);
    expect(cl).not.toBeNull();
    expect(cl!.name).toBe("单元测试走位表");
  });

  it("updateCueList renames it", async () => {
    await updateCueList(CL_ID, PROD_HOSHINO, { name: "单元测试走位表（改名）" });
    expect((await getCueList(CL_ID, PROD_HOSHINO))!.name).toBe("单元测试走位表（改名）");
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
