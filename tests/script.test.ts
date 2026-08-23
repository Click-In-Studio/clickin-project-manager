import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getActiveVersionId, loadProduction } from "@/lib/db";
import { makeProduction, makeBlocks, cleanupProduction } from "./factories";

let prodId: string;
let versionId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  await makeBlocks(prodId, versionId, 3);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("versions", () => {
  it("getActiveVersionId returns a version for a new production", async () => {
    expect(await getActiveVersionId(prodId)).toBe(versionId);
  });
});

describe("loadProduction / script blocks", () => {
  it("active version has blocks loaded", async () => {
    const vid = await getActiveVersionId(prodId);
    const state = await loadProduction(prodId, vid!);
    expect(state).not.toBeNull();
    expect(state!.state.blocks.length).toBeGreaterThan(0);
  });

  it("returns null for non-existent production", async () => {
    expect(await loadProduction("no-such-prod", "no-such-version")).toBeNull();
  });
});
