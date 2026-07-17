/**
 * Migration tests for migrate-internal-user-id.sql.
 *
 * Operating modes:
 *
 *   Migration path (CI: base schema applied, no migration yet):
 *     global-setup.ts detects the old schema, inserts faker-seeded factory rows,
 *     applies the migration, and writes a PreMigrationSnapshot to SNAPSHOT_PATH.
 *     All three test layers run, including invariance.
 *
 *   Normal path (local dev, already-migrated DB):
 *     global-setup.ts skips the migration. SNAPSHOT_PATH doesn't exist.
 *     Schema and integrity tests always run; invariance tests skip (it.skipIf).
 *
 * Layer structure (same pattern for all future migration tests):
 *   1. Schema    — column types, presence/absence
 *   2. Integrity — FK orphan counts, JSONB cleanliness
 *   3. Invariance — every factory row maps faithfully before → after
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { SNAPSHOT_PATH, type PreMigrationSnapshot } from "./migration-snapshot";

// ── Snapshot ──────────────────────────────────────────────────────────────────
//
// Read synchronously at module-load time so that it.skipIf(!snapshot) has the
// correct value when test definitions are registered. An async beforeAll would
// leave snapshot=null during registration, causing every it.skipIf to always
// skip — even when the snapshot file exists.
//
// globalSetup runs before workers load this file, so the file is already on
// disk (or absent) by the time this executes.
let snapshot: PreMigrationSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as PreMigrationSnapshot;
} catch {
  snapshot = null; // normal path: no snapshot (local already-migrated DB)
}

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("app_user table exists", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'app_user'
    `);
    expect(rows).toHaveLength(1);
  });

  it("feishu_user.user_id is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'feishu_user' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("feishu_user.user_id has UNIQUE constraint", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'feishu_user'
        AND tc.constraint_type = 'UNIQUE'
        AND ccu.column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
  });

  it("production_member: open_id column is gone", async () => {
    const { rows } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'production_member' AND column_name = 'open_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("production_member: user_id is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_member' AND column_name = 'user_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("cue_list.created_by is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'cue_list' AND column_name = 'created_by'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("production_event.created_by is UUID NOT NULL", async () => {
    const { rows } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'production_event' AND column_name = 'created_by'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("uuid");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("comment: open_id column is gone, user_id UUID NOT NULL", async () => {
    const { rows: gone } = await getPool().query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'comment' AND column_name = 'open_id'
    `);
    expect(gone).toHaveLength(0);

    const { rows: neo } = await getPool().query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'comment' AND column_name = 'user_id'
    `);
    expect(neo).toHaveLength(1);
    expect(neo[0].data_type).toBe("uuid");
    expect(neo[0].is_nullable).toBe("NO");
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("every feishu_user row has a non-null user_id that points to app_user", async () => {
    const { rows: nulls } = await getPool().query(
      "SELECT COUNT(*)::int AS cnt FROM feishu_user WHERE user_id IS NULL",
    );
    expect(nulls[0].cnt).toBe(0);

    const { rows: orphans } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM feishu_user fu
      LEFT JOIN app_user au ON au.id = fu.user_id
      WHERE au.id IS NULL
    `);
    expect(orphans[0].cnt).toBe(0);
  });

  it("all production_member rows reference valid app_user", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_member pm
      LEFT JOIN app_user au ON au.id = pm.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all cue_list rows reference valid app_user", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM cue_list cl
      LEFT JOIN app_user au ON au.id = cl.created_by
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all production_event rows reference valid app_user", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM production_event pe
      LEFT JOIN app_user au ON au.id = pe.created_by
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("all comment rows reference valid app_user", async () => {
    const { rows } = await getPool().query(`
      SELECT COUNT(*)::int AS cnt
      FROM comment c
      LEFT JOIN app_user au ON au.id = c.user_id
      WHERE au.id IS NULL
    `);
    expect(rows[0].cnt).toBe(0);
  });

  it("no JSONB mentions retain the legacy openId key", async () => {
    for (const table of ["comment", "event_report", "event_report_note", "event_report_reply"]) {
      const { rows } = await getPool().query(`
        SELECT COUNT(*)::int AS cnt FROM "${table}"
        WHERE mentions IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(mentions) AS m WHERE m ? 'openId'
          )
      `);
      expect(rows[0].cnt).toBe(0);
    }
  });
});

// ── 3. Invariance verification ────────────────────────────────────────────────
//
// Verifies that the migration preserved every (openId → row) mapping exactly.
// Only runs when a PreMigrationSnapshot was written by global-setup.ts —
// meaning the migration was applied during this test run (CI migration path).
// Skips on already-migrated local DBs (it.skipIf pattern).

describe("invariance verification", () => {
  // Resolves a post-migration user_id UUID back to the original open_id.
  async function openIdFor(userId: string): Promise<string | null> {
    const { rows } = await getPool().query<{ open_id: string }>(
      "SELECT open_id FROM feishu_user WHERE user_id = $1::uuid",
      [userId],
    );
    return rows[0]?.open_id ?? null;
  }

  it.skipIf(!snapshot)("feishu_user: every factory openId has a corresponding user_id", async () => {
    for (const user of snapshot!.users) {
      const { rows } = await getPool().query<{ user_id: string }>(
        "SELECT user_id FROM feishu_user WHERE open_id = $1",
        [user.openId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeTruthy();
    }
  });

  it.skipIf(!snapshot)("production_member: row count in factory production preserved", async () => {
    const { rows } = await getPool().query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM production_member WHERE production_id = $1",
      [snapshot!.production.id],
    );
    expect(rows[0].cnt).toBe(snapshot!.members.length);
  });

  it.skipIf(!snapshot)("production_member: every user_id maps back to original openId", async () => {
    const { rows } = await getPool().query<{ production_id: string; user_id: string }>(
      "SELECT production_id, user_id FROM production_member WHERE production_id = $1",
      [snapshot!.production.id],
    );
    const expected = new Set(snapshot!.members.map((m) => m.openId));
    const mismatches: string[] = [];
    for (const row of rows) {
      const resolved = await openIdFor(row.user_id);
      if (!resolved || !expected.has(resolved)) {
        mismatches.push(`user_id ${row.user_id} → openId "${resolved}" not in original member set`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it.skipIf(!snapshot)("cue_list: every created_by maps back to original openId", async () => {
    const mismatches: string[] = [];
    for (const cl of snapshot!.cueLists) {
      const { rows } = await getPool().query<{ created_by: string }>(
        "SELECT created_by FROM cue_list WHERE id = $1",
        [cl.id],
      );
      expect(rows, `cue_list ${cl.id} must exist post-migration`).toHaveLength(1);
      const resolved = await openIdFor(rows[0].created_by);
      if (resolved !== cl.openId) {
        mismatches.push(
          `cue_list ${cl.id}: expected openId "${cl.openId}", got "${resolved}"`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it.skipIf(!snapshot)("production_event: every created_by maps back to original openId", async () => {
    const mismatches: string[] = [];
    for (const evt of snapshot!.events) {
      const { rows } = await getPool().query<{ created_by: string }>(
        "SELECT created_by FROM production_event WHERE id = $1",
        [evt.id],
      );
      expect(rows, `production_event ${evt.id} must exist post-migration`).toHaveLength(1);
      const resolved = await openIdFor(rows[0].created_by);
      if (resolved !== evt.openId) {
        mismatches.push(
          `production_event ${evt.id}: expected openId "${evt.openId}", got "${resolved}"`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it.skipIf(!snapshot)("comment: every user_id maps back to original openId", async () => {
    const mismatches: string[] = [];
    for (const cmt of snapshot!.comments) {
      const { rows } = await getPool().query<{ user_id: string }>(
        "SELECT user_id FROM comment WHERE id = $1",
        [cmt.id],
      );
      expect(rows, `comment ${cmt.id} must exist post-migration`).toHaveLength(1);
      const resolved = await openIdFor(rows[0].user_id);
      if (resolved !== cmt.openId) {
        mismatches.push(
          `comment ${cmt.id}: expected openId "${cmt.openId}", got "${resolved}"`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it.skipIf(!snapshot)("comment mentions: userId resolves to original openId, no legacy openId key", async () => {
    const mismatches: string[] = [];
    for (const cmt of snapshot!.comments) {
      const { rows } = await getPool().query<{ mentions: Array<Record<string, string>> }>(
        "SELECT mentions FROM comment WHERE id = $1",
        [cmt.id],
      );
      expect(rows, `comment ${cmt.id} must exist post-migration`).toHaveLength(1);
      const mentions = rows[0].mentions;

      // No legacy openId keys survive migration.
      const hasLegacyKey = mentions.some((m) => "openId" in m);
      if (hasLegacyKey) {
        mismatches.push(`comment ${cmt.id}: mentions still contain legacy "openId" key`);
      }

      // Each userId in mentions must resolve to one of the original mentionOpenIds.
      const expectedSet = new Set(cmt.mentionOpenIds);
      const resolvedOpenIds = await Promise.all(
        mentions.filter((m) => m.userId).map((m) => openIdFor(m.userId)),
      );
      for (const resolved of resolvedOpenIds) {
        if (!resolved || !expectedSet.has(resolved)) {
          mismatches.push(
            `comment ${cmt.id} mentions: resolved "${resolved}" not in original set [${[...expectedSet].join(", ")}]`,
          );
        }
      }
      // The set of resolved openIds must exactly match the original mentionOpenIds.
      if (new Set(resolvedOpenIds).size !== expectedSet.size) {
        mismatches.push(
          `comment ${cmt.id} mentions: count mismatch — got ${resolvedOpenIds.length}, expected ${expectedSet.size}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
