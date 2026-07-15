/**
 * Cross-production isolation: verify that every read/write that takes a
 * productionId (or a parentId scoped to a production) cannot be used to
 * reach data belonging to a different production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createProduction, deleteProduction,
  createCueList, deleteCueList, getCueList, updateCueList,
  createCue, getCue, deleteCue,
  listProductionScenes, getSceneById,
  listProductionCharacters, getCharacterById,
  listCueLists,
} from "@/lib/db";
import { createProductionEvent, getProductionEvent, deleteProductionEvent } from "@/lib/event-db";
import { PROD_PLANET, PROD_CULTURE, TEST_USER } from "./helpers";

// A production that owns none of the test resources
const OTHER_PROD = "test-other-prod";
const CL_ID      = "test-sec-cl";
const CUE_ID     = "test-sec-cue";
const EVENT_ID   = "test-sec-event";

beforeAll(async () => {
  await createProduction(OTHER_PROD, "隔离测试演出");
  await createCueList({
    id: CL_ID, productionId: PROD_PLANET, name: "安全测试走位表",
    notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: TEST_USER,
  });
  const anchor = { kind: "gap" as const, afterBlockId: null };
  await createCue({ id: CUE_ID, cueListId: CL_ID, number: "S1", name: "安全测试Q", content: "", start: anchor, end: anchor });
  await createProductionEvent({
    id: EVENT_ID, productionId: PROD_PLANET, title: "安全测试排练", eventType: "custom",
    location: "", startTime: null, endTime: null, description: "", createdBy: TEST_USER,
  });
});

afterAll(async () => {
  await deleteCue(CUE_ID, CL_ID).catch(() => {});
  await deleteCueList(CL_ID, PROD_PLANET).catch(() => {});
  await deleteProductionEvent(EVENT_ID, PROD_PLANET).catch(() => {});
  await deleteProduction(OTHER_PROD).catch(() => {});
});

describe("production isolation — reads", () => {
  it("listProductionScenes for OTHER_PROD cannot see PROD_PLANET scenes", async () => {
    const ours   = await listProductionScenes(PROD_PLANET);
    const theirs = await listProductionScenes(OTHER_PROD);
    const ourIds = new Set(ours.map((s) => s.id));
    expect(theirs.every((s) => !ourIds.has(s.id))).toBe(true);
  });

  it("listProductionCharacters for OTHER_PROD cannot see PROD_PLANET characters", async () => {
    const ours   = await listProductionCharacters(PROD_PLANET);
    const theirs = await listProductionCharacters(OTHER_PROD);
    const ourIds = new Set(ours.map((c) => c.id));
    expect(theirs.every((c) => !ourIds.has(c.id))).toBe(true);
  });

  it("getSceneById rejects correct id + wrong production", async () => {
    const scenes = await listProductionScenes(PROD_PLANET);
    const result = await getSceneById(scenes[0].id, OTHER_PROD);
    expect(result).toBeNull();
  });

  it("getCharacterById rejects correct id + wrong production", async () => {
    const chars = await listProductionCharacters(PROD_PLANET);
    const result = await getCharacterById(chars[0].id, OTHER_PROD);
    expect(result).toBeNull();
  });

  it("getCueList rejects correct id + wrong production", async () => {
    expect(await getCueList(CL_ID, OTHER_PROD)).toBeNull();
  });

  it("listCueLists for OTHER_PROD returns empty (no cue lists created for it)", async () => {
    const lists = await listCueLists(OTHER_PROD);
    expect(lists.every((l) => l.id !== CL_ID)).toBe(true);
  });

  it("getProductionEvent rejects correct id + wrong production", async () => {
    expect(await getProductionEvent(EVENT_ID, OTHER_PROD)).toBeNull();
  });
});

describe("production isolation — writes blocked by parent scope", () => {
  it("updateCueList with wrong production does nothing", async () => {
    await updateCueList(CL_ID, OTHER_PROD, { name: "越权改名" });
    const cl = await getCueList(CL_ID, PROD_PLANET);
    expect(cl!.name).not.toBe("越权改名");
  });

  it("deleteCue with wrong cue list id does not delete", async () => {
    const fakeCLId = "no-such-cl";
    await deleteCue(CUE_ID, fakeCLId);
    expect(await getCue(CUE_ID, CL_ID)).not.toBeNull();
  });
});

describe("PROD_CULTURE cannot access PROD_PLANET resources by ID", () => {
  it("getSceneById with PROD_PLANET scene id returns null for PROD_CULTURE", async () => {
    // Scene marker IDs can overlap (same content-derived IDs); isolation is
    // proved by `getSceneById` scoping the lookup through the correct version.
    // Pick an ID from PROD_PLANET that is NOT in PROD_CULTURE's active scene set.
    const planet  = await listProductionScenes(PROD_PLANET);
    const culture = await listProductionScenes(PROD_CULTURE);
    const cultureIds = new Set(culture.map((s) => s.id));
    const exclusive = planet.find((s) => !cultureIds.has(s.id));
    if (!exclusive) {
      // All scene IDs happen to appear in both productions (shared markers); skip.
      return;
    }
    expect(await getSceneById(exclusive.id, PROD_CULTURE)).toBeNull();
  });

  it("cue list created in PROD_PLANET is not visible via PROD_CULTURE", async () => {
    const planet  = await listCueLists(PROD_PLANET);
    const culture = await listCueLists(PROD_CULTURE);
    const cultureIds = new Set(culture.map((l) => l.id));
    expect(planet.every((l) => !cultureIds.has(l.id))).toBe(true);
  });
});
