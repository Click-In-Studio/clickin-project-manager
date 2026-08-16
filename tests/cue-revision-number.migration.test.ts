import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";

describe("Cue revision number migration", () => {
  it("allows the same Cue number in separate physical revisions", async () => {
    const { rows } = await getPool().query(
      `SELECT 1
       FROM pg_constraint c
       WHERE c.conrelid = 'cue'::regclass
         AND c.contype = 'u'
         AND (
           SELECT array_agg(a.attname ORDER BY key.ordinality)
           FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
         ) = ARRAY['cue_list_id', 'number']::name[]`,
    );
    expect(rows).toHaveLength(0);
  });
});
