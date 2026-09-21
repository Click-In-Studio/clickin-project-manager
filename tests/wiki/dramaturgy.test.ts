import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listScenesByVersion, getSceneById, listCharactersByVersion, getCharacterById } from "@/lib/script/script-scene-character-db";
import { makeProduction, makeScene, makeCharacter, cleanupProduction } from "../_support/factories";

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
    const scene = await getSceneById(sceneId, prodId, versionId);
    expect(scene).not.toBeNull();
    expect(scene!.id).toBe(sceneId);
  });

  it("getSceneById returns null for non-existent scene", async () => {
    expect(await getSceneById("no-such-scene", prodId, versionId)).toBeNull();
  });

  it("getSceneById returns null for correct scene id with wrong production", async () => {
    const other = await makeProduction();
    const otherSceneId = await makeScene(other.prodId, other.versionId);
    const result = await getSceneById(otherSceneId, prodId, other.versionId);
    await cleanupProduction(other.prodId).catch(() => {});
    expect(result).toBeNull();
  });
});

describe("characters", () => {
  it("listCharactersByVersion returns the created character", async () => {
    const chars = await listCharactersByVersion(versionId);
    expect(chars.some((c) => c.id === charId)).toBe(true);
  });

  it("getCharacterById returns the correct character", async () => {
    const char = await getCharacterById(charId, prodId, versionId);
    expect(char).not.toBeNull();
    expect(char!.id).toBe(charId);
  });

  it("getCharacterById returns null for wrong production", async () => {
    const other = await makeProduction();
    const result = await getCharacterById(charId, other.prodId, versionId);
    await cleanupProduction(other.prodId).catch(() => {});
    expect(result).toBeNull();
  });
});
