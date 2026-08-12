import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  LOCAL_SCRIPT_DATA_SNAPSHOT_PATH,
  type LocalScriptDataSnapshot,
} from "./local-script-data-snapshot";

let snapshot: LocalScriptDataSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(LOCAL_SCRIPT_DATA_SNAPSHOT_PATH, "utf8"),
  ) as LocalScriptDataSnapshot;
} catch {
  snapshot = null;
}

describe("local script data migration", () => {
  it("seeds the global script comment member template", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM grant_template
       WHERE production_type IS NULL
         AND role_name = '*'
         AND permission_key = 'script:comment'`,
    );
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!snapshot)("backfills comment eligibility", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM production_role_permission
       WHERE role_id = $1 AND permission_key = 'script:comment'`,
      [snapshot!.roleId],
    );
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!snapshot)("does not create active comment grants", async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM atomic_permission_grant
       WHERE production_id = $1 AND permission_key = 'script:comment'`,
      [snapshot!.productionIds.stagePlay],
    );
    expect(rows).toHaveLength(0);
  });

  it.skipIf(!snapshot)("backfills missing rehearsal preferences by production type", async () => {
    const { rows } = await getPool().query<{ id: string; enabled: boolean }>(
      `SELECT id, (script_config->>'useRehearsalMarks')::boolean AS enabled
       FROM production WHERE id = ANY($1::text[]) ORDER BY id`,
      [[snapshot!.productionIds.stagePlay, snapshot!.productionIds.musical]],
    );
    expect(Object.fromEntries(rows.map(row => [row.id, row.enabled]))).toEqual({
      [snapshot!.productionIds.stagePlay]: false,
      [snapshot!.productionIds.musical]: true,
    });
  });

  it.skipIf(!snapshot)("preserves explicit rehearsal preferences and other config", async () => {
    const { rows } = await getPool().query<{ config: Record<string, unknown> }>(
      "SELECT script_config AS config FROM production WHERE id = $1",
      [snapshot!.productionIds.explicitFilm],
    );
    expect(rows[0].config).toMatchObject({ useRehearsalMarks: true, pageLayout: "letter" });
  });
});
