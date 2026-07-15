import { describe, it, expect } from "vitest";
import { listProductionScenes, getSceneById, listProductionCharacters, getCharacterById } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { PROD_HOSHINO, PROD_SUPPLY } from "./helpers";

describe("scenes", () => {
  it("listProductionScenes returns scenes for 我们的星星", async () => {
    const scenes = await listProductionScenes(PROD_HOSHINO);
    expect(scenes.length).toBeGreaterThan(0);
  });

  it("listProductionScenes returns scenes for 供养2.0", async () => {
    const scenes = await listProductionScenes(PROD_SUPPLY);
    expect(scenes.length).toBeGreaterThan(0);
  });

  it("scene table has 100+ rows across both productions", async () => {
    const res = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM scene WHERE production_id = ANY($1)`,
      [[PROD_HOSHINO, PROD_SUPPLY]]
    );
    expect(parseInt(res.rows[0].count)).toBeGreaterThanOrEqual(100);
  });

  it("getSceneById returns the correct scene", async () => {
    const scenes = await listProductionScenes(PROD_HOSHINO);
    const first = scenes[0];
    const scene = await getSceneById(first.id, PROD_HOSHINO);
    expect(scene).not.toBeNull();
    expect(scene!.id).toBe(first.id);
  });

  it("getSceneById returns null for non-existent scene", async () => {
    expect(await getSceneById("no-such-scene", PROD_HOSHINO)).toBeNull();
  });
});

describe("characters", () => {
  it("listProductionCharacters returns characters for 我们的星星", async () => {
    const chars = await listProductionCharacters(PROD_HOSHINO);
    expect(chars.length).toBeGreaterThan(0);
  });

  it("getCharacterById returns the correct character", async () => {
    const chars = await listProductionCharacters(PROD_HOSHINO);
    const char = await getCharacterById(chars[0].id, PROD_HOSHINO);
    expect(char).not.toBeNull();
    expect(char!.id).toBe(chars[0].id);
  });

  it("getCharacterById returns null for wrong production", async () => {
    const chars = await listProductionCharacters(PROD_HOSHINO);
    expect(await getCharacterById(chars[0].id, PROD_SUPPLY)).toBeNull();
  });
});
