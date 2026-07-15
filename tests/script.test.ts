import { describe, it, expect } from "vitest";
import { getActiveVersionId, loadProduction, listVersions } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { PROD_HOSHINO, PROD_SUPPLY } from "./helpers";

describe("versions", () => {
  it("listVersions returns 2+ versions for 我们的星星", async () => {
    expect((await listVersions(PROD_HOSHINO)).length).toBeGreaterThanOrEqual(2);
  });

  it("getActiveVersionId returns a version for both productions", async () => {
    expect(await getActiveVersionId(PROD_HOSHINO)).not.toBeNull();
    expect(await getActiveVersionId(PROD_SUPPLY)).not.toBeNull();
  });
});

describe("loadProduction / script blocks", () => {
  it("script table has 5000+ rows across both productions", async () => {
    const res = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM script WHERE production_id = ANY($1)`,
      [[PROD_HOSHINO, PROD_SUPPLY]]
    );
    expect(parseInt(res.rows[0].count)).toBeGreaterThanOrEqual(5000);
  });

  it("我们的星星 active version has blocks loaded", async () => {
    const versionId = await getActiveVersionId(PROD_HOSHINO);
    const state = await loadProduction(PROD_HOSHINO, versionId!);
    expect(state).not.toBeNull();
    expect(state!.state.blocks.length).toBeGreaterThan(0);
  });

  it("供养2.0 has blocks", async () => {
    const versionId = await getActiveVersionId(PROD_SUPPLY);
    const state = await loadProduction(PROD_SUPPLY, versionId!);
    expect(state).not.toBeNull();
    expect(state!.state.blocks.length).toBeGreaterThan(0);
  });

  it("returns null for non-existent production", async () => {
    expect(await loadProduction("no-such-prod", "no-such-version")).toBeNull();
  });
});
