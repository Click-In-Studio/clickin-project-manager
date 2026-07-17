import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listScenesByVersion, getSceneById, listProductionCharacters, getCharacterById } from "@/lib/db";
import { makeProduction, makeScene, makeCharacter, cleanupProduction } from "./factories";

let prodId: string;
let versionId: string;
let sceneId: string;
let charId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  sceneId = await makeScene(prodId, versionId);
  charId = await makeCharacter(prodId, versionId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("scenes", () => {
  it("listScenesByVersion returns the created scene", async () => {
    const scenes = await listScenesByVersion(versionId);
    expect(scenes.some((s) => s.id === sceneId)).toBe(true);
  });

  it("getSceneById returns the correct scene", async () => {
    const scene = await getSceneById(sceneId, prodId);
    expect(scene).not.toBeNull();
    expect(scene!.id).toBe(sceneId);
  });

  it("getSceneById returns null for non-existent scene", async () => {
    expect(await getSceneById("no-such-scene", prodId)).toBeNull();
  });

  it("getSceneById returns null for correct scene id with wrong production", async () => {
    const other = await makeProduction();
    const otherSceneId = await makeScene(other.prodId, other.versionId);
    const result = await getSceneById(otherSceneId, prodId);
    await cleanupProduction(other.prodId).catch(() => {});
    expect(result).toBeNull();
  });
});

describe("characters", () => {
  it("listProductionCharacters returns the created character", async () => {
    const chars = await listProductionCharacters(prodId);
    expect(chars.some((c) => c.id === charId)).toBe(true);
  });

  it("getCharacterById returns the correct character", async () => {
    const char = await getCharacterById(charId, prodId);
    expect(char).not.toBeNull();
    expect(char!.id).toBe(charId);
  });

  it("getCharacterById returns null for wrong production", async () => {
    const other = await makeProduction();
    const result = await getCharacterById(charId, other.prodId);
    await cleanupProduction(other.prodId).catch(() => {});
    expect(result).toBeNull();
  });
});
