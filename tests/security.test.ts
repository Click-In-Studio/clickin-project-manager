/**
 * Cross-production isolation: verify that every read/write that takes a
 * productionId (or a parentId scoped to a production) cannot be used to
 * reach data belonging to a different production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCueList, deleteCueList, getCueList, updateCueList,
  createCue, getCue, deleteCue,
  listScenesByVersion, getSceneById,
  listProductionCharacters, getCharacterById,
  listCueLists,
} from "@/lib/db";
import { createProductionEvent, getProductionEvent, deleteProductionEvent } from "@/lib/event-db";
import { TEST_USER } from "./helpers";
import { makeProduction, makeScene, makeCharacter, cleanupProduction, shortId } from "./factories";

// PROD_A owns all the test resources; PROD_B is empty (no scenes/chars/cuelists)
let prodA: { prodId: string; versionId: string };
let prodB: { prodId: string; versionId: string };

const CL_ID    = `sec-cl-${shortId()}`;
const CUE_ID   = `sec-cue-${shortId()}`;
const EVENT_ID = `sec-evt-${shortId()}`;

let sceneAId: string;
let charAId: string;

beforeAll(async () => {
  [prodA, prodB] = await Promise.all([makeProduction(), makeProduction()]);
  [sceneAId, charAId] = await Promise.all([
    makeScene(prodA.prodId, prodA.versionId),
    makeCharacter(prodA.prodId, prodA.versionId),
  ]);
  const anchor = { kind: "gap" as const, afterBlockId: null };
  await createCueList({
    id: CL_ID, productionId: prodA.prodId, name: "安全测试走位表",
    notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: TEST_USER,
  });
  await createCue({ id: CUE_ID, cueListId: CL_ID, number: "S1", name: "安全测试Q", content: "", start: anchor, end: anchor });
  await createProductionEvent({
    id: EVENT_ID, productionId: prodA.prodId, title: "安全测试排练", eventType: "custom",
    location: "", startTime: null, endTime: null, description: "", createdBy: TEST_USER,
  });
});

afterAll(async () => {
  // cue_list and production_event cascade-delete with the production,
  // but explicit cleanup is safer for parallel test suites
  await deleteCue(CUE_ID, CL_ID).catch(() => {});
  await deleteCueList(CL_ID, prodA.prodId).catch(() => {});
  await deleteProductionEvent(EVENT_ID, prodA.prodId).catch(() => {});
  await cleanupProduction(prodA.prodId).catch(() => {});
  await cleanupProduction(prodB.prodId).catch(() => {});
});

describe("production isolation — reads", () => {
  it("listScenesByVersion for PROD_B cannot see PROD_A scenes", async () => {
    const ours   = await listScenesByVersion(prodA.versionId);
    const theirs = await listScenesByVersion(prodB.versionId);
    const ourIds = new Set(ours.map((s) => s.id));
    expect(theirs.every((s) => !ourIds.has(s.id))).toBe(true);
  });

  it("listProductionCharacters for PROD_B cannot see PROD_A characters", async () => {
    const ours   = await listProductionCharacters(prodA.prodId);
    const theirs = await listProductionCharacters(prodB.prodId);
    const ourIds = new Set(ours.map((c) => c.id));
    expect(theirs.every((c) => !ourIds.has(c.id))).toBe(true);
  });

  it("getSceneById rejects correct id + wrong production", async () => {
    expect(await getSceneById(sceneAId, prodB.prodId)).toBeNull();
  });

  it("getCharacterById rejects correct id + wrong production", async () => {
    expect(await getCharacterById(charAId, prodB.prodId)).toBeNull();
  });

  it("getCueList rejects correct id + wrong production", async () => {
    expect(await getCueList(CL_ID, prodB.prodId)).toBeNull();
  });

  it("listCueLists for PROD_B returns empty (no cue lists created for it)", async () => {
    const lists = await listCueLists(prodB.prodId);
    expect(lists.every((l) => l.id !== CL_ID)).toBe(true);
  });

  it("getProductionEvent rejects correct id + wrong production", async () => {
    expect(await getProductionEvent(EVENT_ID, prodB.prodId)).toBeNull();
  });
});

describe("production isolation — writes blocked by parent scope", () => {
  it("updateCueList with wrong production does nothing", async () => {
    await updateCueList(CL_ID, prodB.prodId, { name: "越权改名" });
    const cl = await getCueList(CL_ID, prodA.prodId);
    expect(cl!.name).not.toBe("越权改名");
  });

  it("deleteCue with wrong cue list id does not delete", async () => {
    const fakeCLId = `no-such-${shortId()}`;
    await deleteCue(CUE_ID, fakeCLId);
    expect(await getCue(CUE_ID, CL_ID)).not.toBeNull();
  });
});

describe("two separate productions cannot access each other's resources by ID", () => {
  it("getSceneById with PROD_A scene id returns null for PROD_B", async () => {
    expect(await getSceneById(sceneAId, prodB.prodId)).toBeNull();
  });

  it("cue list created in PROD_A is not visible via PROD_B", async () => {
    const a = await listCueLists(prodA.prodId);
    const b = await listCueLists(prodB.prodId);
    const bIds = new Set(b.map((l) => l.id));
    expect(a.every((l) => !bIds.has(l.id))).toBe(true);
  });
});
